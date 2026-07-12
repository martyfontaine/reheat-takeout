/**
 * Filesystem walk + Takeout-tree detection (ISC-12, ISC-13).
 *
 * Enumerates every media file under a `Takeout/Google Photos/` subtree and,
 * for each directory, exposes the full file listing so the matcher can resolve
 * sidecars within-directory (never cross-folder).
 */
import { readdir } from "fs/promises";
import { basename, dirname, join } from "path";
import { classifyKind } from "./match";
import type { MediaKind } from "./types";

export interface DirListing {
  dir: string;
  files: string[]; // filenames (not paths) directly in `dir`
}

/** Recursively yield every directory's immediate file listing. */
export async function* walkDirs(root: string): AsyncGenerator<DirListing> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return; // unreadable dir — skip rather than crash the whole scan
  }
  const files: string[] = [];
  const subdirs: string[] = [];
  for (const e of entries) {
    if (e.isDirectory()) subdirs.push(e.name);
    else if (e.isFile()) files.push(e.name);
  }
  yield { dir: root, files };
  for (const d of subdirs) yield* walkDirs(join(root, d));
}

/**
 * Find every `.../Takeout/Google Photos` root inside an extracted tree.
 * Presence of such a path is the Takeout heuristic (ISC-12).
 */
export async function findPhotoRoots(extractRoot: string): Promise<string[]> {
  const roots: string[] = [];
  for await (const { dir } of walkDirs(extractRoot)) {
    const base = basename(dir).toLowerCase();
    const parent = basename(dirname(dir)).toLowerCase();
    if (base === "google photos" && parent === "takeout") roots.push(dir);
  }
  return roots;
}

/** True if the extracted tree looks like a Google Photos Takeout (ISC-12). */
export async function isTakeoutTree(extractRoot: string): Promise<boolean> {
  return (await findPhotoRoots(extractRoot)).length > 0;
}

export interface ScannedMedia {
  path: string;
  name: string;
  dir: string;
  kind: MediaKind;
}

/**
 * Enumerate every media file under the Takeout Google Photos root(s), plus the
 * per-directory file index the matcher needs.
 */
export async function scanMedia(
  extractRoot: string,
): Promise<{ media: ScannedMedia[]; dirFiles: Map<string, string[]> }> {
  const roots = await findPhotoRoots(extractRoot);
  const media: ScannedMedia[] = [];
  const dirFiles = new Map<string, string[]>();
  for (const root of roots) {
    for await (const { dir, files } of walkDirs(root)) {
      dirFiles.set(dir, files);
      for (const name of files) {
        const kind = classifyKind(name);
        if (kind) media.push({ path: join(dir, name), name, dir, kind });
      }
    }
  }
  return { media, dirFiles };
}
