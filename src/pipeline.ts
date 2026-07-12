/**
 * Pipeline orchestration — the `run` core (ISC-9..46 wired together).
 *
 * The one invariant that buys both crash-safety and idempotency is the ordering:
 *   hash → dedup → merge → import → confirm → record.
 * The hash is of the original bytes (before merge mutates the file); the DB row is
 * written only AFTER the sink confirms the asset landed (ISC-41). A run-lock stops
 * overlapping launchd fires from corrupting state.
 */
import { readdir, mkdir, rm, writeFile, readFile } from "fs/promises";
import { basename, join } from "path";
import { existsSync, statSync } from "fs";
import type { Config } from "./config";
import type { Logger } from "./log";
import { classifyArchive, extractArchive } from "./extract";
import { isTakeoutTree } from "./scan";
import { TakeoutSource } from "./source/takeout";
import { ApplePhotosSink } from "./sink/applephotos";
import { mergeBatch } from "./merge";
import { StateStore } from "./state";
import { heuristicICloudEnabled } from "./icloud";
import { notifyReheated } from "./notify";
import type { MediaItem } from "./types";

export interface RunOptions {
  dryRun: boolean;
}

export interface RunSummary {
  archives: number;
  matched: number;
  unmatched: number;
  duplicates: number;
  merged: number;
  imported: number;
  wouldImport: number;
  failed: number;
}

const MULTIPART_RE = /^(.*?)-(\d{3})\.zip$/i;
const STALE_LOCK_MS = 6 * 60 * 60 * 1000;
const STABLE_WAIT_MS = 1500; // an archive must hold its size across this window before we touch it

/**
 * True once an archive has stopped growing. A completed browser download appears
 * via atomic rename and is stable on the first check (so no delay in the common
 * case); a file mid-copy is still growing and returns false, and its completion
 * fires a fresh WatchPaths event. This replaces an mtime-age skip, which — under
 * event-only WatchPaths — could strand a just-dropped file forever (no later event).
 */
async function isStable(path: string): Promise<boolean> {
  try {
    const first = statSync(path).size;
    if (first === 0) return false;
    await Bun.sleep(STABLE_WAIT_MS);
    return statSync(path).size === first;
  } catch {
    return false; // vanished mid-check (e.g. a temp file) — nothing to import
  }
}

/** Whether a process id is still alive (signal 0 probes without delivering). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists but not ours
  }
}

/** Archives in the inbox, collapsing multi-part groups to one representative. */
async function findArchives(inbox: string): Promise<string[]> {
  if (!existsSync(inbox)) return [];
  const entries = (await readdir(inbox)).sort();
  const seenPrefix = new Set<string>();
  const out: string[] = [];
  for (const name of entries) {
    if (classifyArchive(name) === null) continue;
    const full = join(inbox, name);
    if (!(await isStable(full))) continue; // still being written; a later event retries
    const m = name.match(MULTIPART_RE);
    if (m) {
      if (seenPrefix.has(m[1])) continue;
      seenPrefix.add(m[1]);
    }
    out.push(full);
  }
  return out;
}

export async function run(cfg: Config, logger: Logger, opts: RunOptions): Promise<RunSummary> {
  const summary: RunSummary = {
    archives: 0, matched: 0, unmatched: 0, duplicates: 0,
    merged: 0, imported: 0, wouldImport: 0, failed: 0,
  };

  await mkdir(cfg.workDir, { recursive: true });
  const lock = join(cfg.workDir, ".run.lock");
  // Atomic acquire: O_EXCL create wins the race between two rapid WatchPaths fires
  // (a check-then-write would let both pass). EEXIST means someone holds it.
  try {
    await writeFile(lock, `${process.pid} ${new Date().toISOString()}\n`, { flag: "wx" });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "EEXIST") throw e;
    // Someone holds the lock — but a run killed mid-flight (SIGKILL, crash) leaves it
    // behind with no chance to clean up. Trust the recorded PID: if that process is
    // gone, the lock is dead and we reclaim now rather than waiting out STALE_LOCK_MS.
    const holderPid = Number.parseInt((await readFile(lock, "utf8")).trim().split(/\s+/)[0] ?? "", 10);
    const holderAlive = Number.isInteger(holderPid) && pidAlive(holderPid);
    const age = Date.now() - statSync(lock).mtimeMs;
    if (holderAlive && age < STALE_LOCK_MS) {
      await logger.warn("run.skipped_locked", { lock, holderPid, ageMs: age });
      return summary;
    }
    await logger.warn("run.stale_lock_reclaimed", { lock, holderPid, holderAlive, ageMs: age });
    await writeFile(lock, `${process.pid} ${new Date().toISOString()}\n`); // reclaim
  }

  const store = await StateStore.open(cfg.dbPath);
  try {
    const archives = await findArchives(cfg.inboxDir);
    await logger.info("run.start", { inbox: cfg.inboxDir, archives: archives.length, dryRun: opts.dryRun });

    // ISC-62: passive heuristic ONLY — the run/daemon path never launches UI
    // automation (ISC-64). Definitive check is the user-invoked `icloud status`.
    if (!opts.dryRun && cfg.warnIfICloudOn && archives.length > 0) {
      const ic = heuristicICloudEnabled();
      if (ic.state === "likely-on") {
        await logger.warn("icloud.likely_on", {
          detail: ic.detail,
          note: "imports will upload to iCloud and count against its storage — see README; check with 'photobridge icloud status'",
        });
      }
    }

    for (const archive of archives) {
      let workDir: string | null = null;
      try {
        const ext = await extractArchive(archive, cfg.workDir);
        workDir = ext.workDir;

        if (!(await isTakeoutTree(workDir))) {
          await logger.warn("archive.not_takeout_skipped", { archive: basename(archive) }); // ISC-12
          continue;
        }
        summary.archives++;

        const { items, unmatched } = await new TakeoutSource([workDir]).collect();
        summary.matched += items.length;
        summary.unmatched += unmatched.length;
        for (const u of unmatched) store.recordUnmatched(u.path, u.reason);
        if (unmatched.length > 0) {
          await logger.warn("scan.unmatched", { count: unmatched.length, archive: basename(archive) });
        }

        // Dedup: against DB (ISC-40) and within-batch album duplication (ISC-39).
        const seen = new Set<string>();
        const toImport: MediaItem[] = [];
        for (const item of items) {
          if (store.has(item.hash) || seen.has(item.hash)) {
            summary.duplicates++;
            continue;
          }
          seen.add(item.hash);
          toImport.push(item);
        }

        if (opts.dryRun) {
          summary.wouldImport += toImport.length;
          await logger.info("archive.dry_run", { archive: basename(archive), wouldImport: toImport.length });
          continue;
        }

        // Merge true metadata into the files (batched, single exiftool process).
        const merge = await mergeBatch(toImport, cfg.displayTimeZone);
        summary.merged += merge.written;
        for (const e of merge.errors) await logger.error("merge.error", e);

        // Import, then record ONLY what the sink confirmed (record-after-confirm).
        const sink = new ApplePhotosSink();
        const byPath = new Map(toImport.map((i) => [i.path, i]));
        const importResult = await sink.importFiles(toImport.map((i) => i.path), { dryRun: false });
        for (const p of importResult.imported) {
          const item = byPath.get(p);
          if (item) {
            store.recordImported(item.hash, basename(item.path), item.metadata?.takenTimeUnix ?? null, null);
            summary.imported++;
          }
        }
        for (const f of importResult.failed) {
          summary.failed++;
          await logger.error("import.failed", f);
        }
        await logger.info("archive.done", {
          archive: basename(archive),
          imported: importResult.imported.length,
          failed: importResult.failed.length,
        });
      } catch (err) {
        summary.failed++;
        await logger.error("archive.error", { archive: basename(archive), error: String(err) });
      } finally {
        // Reclaim disk: the user's archive stays as source of truth; our extraction is throwaway.
        if (workDir && existsSync(workDir)) await rm(workDir, { recursive: true, force: true });
      }
    }

    await logger.info("run.summary", { ...summary });
    // The payoff: banner + chime when a reheat actually landed photos.
    if (!opts.dryRun && summary.imported > 0) {
      await notifyReheated(summary.imported);
    }
    return summary;
  } finally {
    store.close();
    await rm(lock, { force: true });
  }
}
