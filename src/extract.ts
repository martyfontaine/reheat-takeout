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
import { existsSync } from "fs";

export type ArchiveKind = "zip" | "tgz";

export function classifyArchive(path: string): ArchiveKind | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".tgz") || lower.endsWith(".tar.gz")) return "tgz";
  return null;
}

const MULTIPART_RE = /^(.*?)-(\d{3})\.zip$/i;

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
