/**
 * Archive extraction (ISC-9, ISC-10, ISC-11, ISC-14).
 *
 *  - .zip via `ditto -x -k` (macOS-native, large-archive safe).
 *  - .tgz / .tar.gz via `tar -xzf`.
 *  - Multi-part Takeout (`-001.zip`, `-002.zip`, …): each part is a COMPLETE zip
 *    holding a slice of the tree; all sibling parts are extracted into one dest
 *    before scanning.
 *  - Atomic: extract into a temp dir; on success rename into place, on failure
 *    remove the temp dir so no partial state is left behind (ISC-9, ISC-14).
 */
import { mkdtemp, rm, mkdir, readdir, rename } from "fs/promises";
import { basename, dirname, join } from "path";
import { existsSync, statSync } from "fs";

export type ArchiveKind = "zip" | "tgz";

export function classifyArchive(path: string): ArchiveKind | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".tgz") || lower.endsWith(".tar.gz")) return "tgz";
  return null;
}

// ---------- Decompression-bomb guard (untrusted archives auto-fire the daemon) ----------

const MAX_ARCHIVE_ENTRIES = 2_000_000; // sane ceiling on files in a Takeout
const FREE_SPACE_HEADROOM = 2 * 1024 ** 3; // keep at least 2 GiB free after extraction
const MAX_GZIP_RATIO = 1100; // gzip's theoretical max is ~1032:1 — bound tgz expansion

export interface ArchiveStats {
  entries: number;
  /** Declared/estimated uncompressed size in bytes, or null if undeterminable. */
  uncompressedBytes: number | null;
}

export interface ExtractionLimits {
  maxEntries: number;
  freeHeadroomBytes: number;
}

export const DEFAULT_EXTRACTION_LIMITS: ExtractionLimits = {
  maxEntries: MAX_ARCHIVE_ENTRIES,
  freeHeadroomBytes: FREE_SPACE_HEADROOM,
};

/**
 * Pure guard: is it safe to expand `stats` given `freeBytes` free? Rejects archives
 * with an absurd entry count or that would (by declared/estimated size) fill the disk.
 * `freeBytes <= 0` means "couldn't determine free space" — the size check is skipped
 * (the entry cap still applies and a real ENOSPC still fails the extraction).
 */
export function checkExtractionLimits(
  stats: ArchiveStats,
  freeBytes: number,
  limits: ExtractionLimits = DEFAULT_EXTRACTION_LIMITS,
): { ok: boolean; reason?: string } {
  if (stats.entries > limits.maxEntries) {
    return { ok: false, reason: `archive has ${stats.entries} entries (cap ${limits.maxEntries})` };
  }
  if (
    stats.uncompressedBytes !== null &&
    freeBytes > 0 &&
    stats.uncompressedBytes + limits.freeHeadroomBytes > freeBytes
  ) {
    return {
      ok: false,
      reason: `expands to ~${stats.uncompressedBytes} bytes but only ${freeBytes} free (need ${limits.freeHeadroomBytes} headroom)`,
    };
  }
  return { ok: true };
}

/** Available bytes on the volume holding `dir` (via df; 0 if undeterminable). */
export async function freeSpaceBytes(dir: string): Promise<number> {
  try {
    const proc = Bun.spawn(["df", "-Pk", dir], { stdout: "pipe", stderr: "ignore" });
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const line = out.trim().split("\n")[1] ?? "";
    const availKb = Number.parseInt(line.split(/\s+/)[3] ?? "", 10);
    return Number.isFinite(availKb) ? availKb * 1024 : 0;
  } catch {
    return 0;
  }
}

/** Inspect an archive's entry count + uncompressed size WITHOUT extracting it. */
export async function archiveStats(path: string, kind: ArchiveKind): Promise<ArchiveStats> {
  if (kind === "zip") {
    // `unzip -l` prints a footer: "<totalUncompressedBytes>   <count> files".
    const proc = Bun.spawn(["unzip", "-l", path], { stdout: "pipe", stderr: "ignore" });
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const m = out.match(/^\s*(\d+)\s+(\d+)\s+files?\s*$/m);
    if (m) return { uncompressedBytes: Number(m[1]), entries: Number(m[2]) };
    return { uncompressedBytes: null, entries: 0 }; // couldn't parse — degrade to entry-less
  }
  // tgz: count entries; bound expansion by gzip's max ratio rather than trusting
  // per-entry sizes (a single gzip stream can't inflate beyond ~1032:1).
  const proc = Bun.spawn(["tar", "-tzf", path], { stdout: "pipe", stderr: "ignore" });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const entries = out.split("\n").filter((l) => l.length > 0).length;
  let compressed = 0;
  try {
    compressed = statSync(path).size;
  } catch {
    /* ignore */
  }
  return { entries, uncompressedBytes: compressed > 0 ? compressed * MAX_GZIP_RATIO : null };
}

/** Multi-part Takeout zip naming: `<prefix>-001.zip`, `-002.zip`, … */
export const MULTIPART_RE = /^(.*?)-(\d{3})\.zip$/i;

/** All sibling parts of a multi-part Takeout set (or just [archivePath]). */
export async function multipartSiblings(archivePath: string): Promise<string[]> {
  const dir = dirname(archivePath);
  const m = basename(archivePath).match(MULTIPART_RE);
  if (!m) return [archivePath];
  const prefix = m[1];
  const entries = await readdir(dir);
  const parts = entries
    .filter((e) => {
      const mm = e.match(MULTIPART_RE);
      return mm !== null && mm[1] === prefix;
    })
    .sort();
  return parts.map((e) => join(dir, e));
}

async function runExtract(archivePath: string, kind: ArchiveKind, dest: string): Promise<void> {
  const cmd =
    kind === "zip"
      ? ["ditto", "-x", "-k", archivePath, dest]
      : ["tar", "-xzf", archivePath, "-C", dest];
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) {
    throw new Error(`extract failed (${cmd[0]} exit ${code}): ${stderr.slice(0, 500)}`);
  }
}

export interface ExtractResult {
  /** Directory containing the extracted tree. */
  workDir: string;
  /** Archives extracted (>1 for multi-part). */
  parts: string[];
}

function stableName(archivePath: string): string {
  return (
    basename(archivePath).replace(/(-\d{3})?\.(zip|tgz|tar\.gz)$/i, "") + ".extracted"
  );
}

/**
 * Extract an archive (and any multi-part siblings) atomically into `workRoot`.
 * Throws on failure without leaving partial output.
 */
export async function extractArchive(archivePath: string, workRoot: string): Promise<ExtractResult> {
  const kind = classifyArchive(archivePath);
  if (!kind) throw new Error(`unsupported archive: ${archivePath}`);
  const parts = kind === "zip" ? await multipartSiblings(archivePath) : [archivePath];

  await mkdir(workRoot, { recursive: true });
  const tmp = await mkdtemp(join(workRoot, ".extract-"));
  try {
    for (const part of parts) {
      const pk = classifyArchive(part);
      if (!pk) throw new Error(`unsupported part: ${part}`);
      // Bomb guard: refuse an archive that would fill the disk or has an absurd entry
      // count BEFORE handing it to ditto/tar (the daemon extracts untrusted archives).
      const check = checkExtractionLimits(await archiveStats(part, pk), await freeSpaceBytes(workRoot));
      if (!check.ok) throw new Error(`refusing to extract ${basename(part)}: ${check.reason}`);
      await runExtract(part, pk, tmp);
    }
    const finalDir = join(workRoot, stableName(archivePath));
    if (existsSync(finalDir)) await rm(finalDir, { recursive: true, force: true });
    await rename(tmp, finalDir);
    return { workDir: finalDir, parts };
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }); // ISC-9/14: no partial state on failure
    throw err;
  }
}
