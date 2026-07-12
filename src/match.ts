/**
 * Sidecar matcher — the crown jewel (ISC-15..22, ISC-24).
 *
 * Matching is deterministic FORWARD (media name → ordered candidate sidecar names)
 * but lossy in reverse, so we NEVER derive a media name from a sidecar. For each
 * media file we generate an ordered candidate list and return the first candidate
 * that actually exists in the SAME directory. Confirmed rules:
 *
 *  - Two eras coexist: legacy `X.ext.json` and supplemental
 *    `X.ext.supplemental-metadata.json`.
 *  - Truncation cap is 46 chars for the stem before `.json`; only the
 *    `.supplemental-metadata` token is clipped (never the basename, ext, or counter).
 *  - The `(n)` duplicate counter moves to the very END, before `.json`:
 *    `IMG_1234(1).JPG` → `IMG_1234.JPG.supplemental-metadata(1).json` (supplemental)
 *    or `IMG_1234.JPG(1).json` (legacy). Never `IMG_1234(1).JPG.json`.
 *  - `-edited` / localized variants inherit the ORIGINAL's sidecar.
 *  - Live-photo motion files (.mov/.mp4) inherit the still sibling's sidecar.
 *  - Case-insensitive fallback within the directory (.JPG vs .jpg).
 */
import { extname } from "path";
import type { MediaKind } from "./types";

const SUPPLEMENTAL_TOKEN = ".supplemental-metadata";

// Localized "edited" suffixes Google appends to edited copies.
const EDITED_TOKENS = [
  "-edited",
  "-bearbeitet", // de
  "-modifié", // fr
  "-bewerkt", // nl
  "-editado", // es/pt
  "-modificato", // it
  "-ha editado", // es (alt)
  "-編集済み", // ja
  "-편집됨", // ko
];

const IMAGE_EXTS = new Set([
  ".jpg", ".jpeg", ".heic", ".heif", ".png", ".gif", ".webp", ".tif", ".tiff",
]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".3gp", ".avi", ".mkv"]);
const MOTION_EXTS = new Set([".mov", ".mp4"]); // live-photo motion halves

// JSON files that are NOT media sidecars — must be excluded.
const NON_SIDECAR_JSON = new Set([
  "metadata.json",
  "print-subscriptions.json",
  "shared_album_comments.json",
  "user-generated-memory-titles.json",
]);

export function isNonSidecarJson(name: string): boolean {
  return NON_SIDECAR_JSON.has(name.toLowerCase());
}

export function classifyKind(name: string): MediaKind | null {
  const ext = extname(name).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  return null;
}

export type MatchVia = "own" | "edited-original" | "motion-sibling" | null;

/** Fast in-directory lookup with a case-insensitive fallback. */
export interface DirIndex {
  names: Set<string>;
  lower: Map<string, string>; // lowercased name -> actual on-disk name
}

export function buildDirIndex(filenames: string[]): DirIndex {
  const names = new Set(filenames);
  const lower = new Map<string, string>();
  for (const n of filenames) lower.set(n.toLowerCase(), n);
  return { names, lower };
}

function lookup(index: DirIndex, name: string): string | null {
  if (index.names.has(name)) return name;
  return index.lower.get(name.toLowerCase()) ?? null;
}

interface Split {
  /** basename WITH extension, counter removed, e.g. "IMG_1234.JPG". */
  base: string;
  /** "(1)" or "". */
  counter: string;
}

/** Split a trailing `(n)` duplicate counter out of `name`. */
export function splitCounter(name: string): Split {
  const m = name.match(/^(.*)\((\d+)\)(\.[^.]+)$/);
  if (m) return { base: m[1] + m[3], counter: `(${m[2]})` };
  return { base: name, counter: "" };
}

/** If `nameWithExt` is an edited variant, return the original name; else null. */
export function stripEditedToken(nameWithExt: string): string | null {
  const ext = extname(nameWithExt);
  const stem = nameWithExt.slice(0, nameWithExt.length - ext.length);
  const stemLower = stem.toLowerCase();
  for (const tok of EDITED_TOKENS) {
    if (stemLower.endsWith(tok.toLowerCase())) {
      return stem.slice(0, stem.length - tok.length) + ext;
    }
  }
  return null;
}

/** All left-substrings of ".supplemental-metadata", longest first. */
function supplementalTruncations(): string[] {
  const out: string[] = [];
  for (let len = SUPPLEMENTAL_TOKEN.length; len >= 1; len--) {
    out.push(SUPPLEMENTAL_TOKEN.slice(0, len));
  }
  return out;
}
const SUPPLEMENTAL_TRUNCATIONS = supplementalTruncations();

/** Ordered candidate sidecar filenames for a base (with ext) + counter. */
export function candidatesFor(base: string, counter: string): string[] {
  const out: string[] = [];
  // Supplemental: try the FULL ".supplemental-metadata" first, then every
  // left-truncation of the token (longest → shortest), counter at the very end.
  // Google usually leaves the full token but clips long names to a ~46-char stem
  // — we generate BOTH and let the existence check pick whichever is on disk.
  // (Real-world: a 52-char stem can be left untruncated; capping at 46 dropped it.)
  for (const suffix of SUPPLEMENTAL_TRUNCATIONS) {
    out.push(base + suffix + counter + ".json");
  }
  // Legacy with counter appended AFTER the extension.
  out.push(base + counter + ".json");
  // Legacy no-counter (only when there is no counter).
  if (counter === "") out.push(base + ".json");
  // NOTE: the extension-omitted candidate (`IMG_1234.json`) is handled separately
  // in resolveOwnSidecar with an ambiguity guard — it is NOT emitted here.
  // De-duplicate while preserving order.
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c) ? false : (seen.add(c), true)));
}

/** The extension-omitted sidecar candidate (`IMG_1234.json` for `IMG_1234.jpg`), or null. */
function extensionOmittedCandidate(base: string, counter: string): string | null {
  const ext = extname(base);
  if (ext.length === 0) return null;
  return base.slice(0, base.length - ext.length) + counter + ".json";
}

/**
 * True if the directory holds ANOTHER media file with the same stem but a
 * different extension (e.g. IMG_1234.jpg alongside IMG_1234.png). In that case an
 * extension-omitted sidecar (IMG_1234.json) is ambiguous and must NOT be used.
 */
function hasSameStemMediaSibling(mediaName: string, index: DirIndex): boolean {
  const ext = extname(mediaName);
  const stem = mediaName.slice(0, mediaName.length - ext.length).toLowerCase();
  for (const other of index.names) {
    if (other === mediaName) continue;
    if (classifyKind(other) === null) continue; // only media files count
    const oext = extname(other);
    if (other.slice(0, other.length - oext.length).toLowerCase() === stem) return true;
  }
  return false;
}

/**
 * Resolve a media file's own sidecar (own name first, then edited-original),
 * within a single directory index. Returns the on-disk sidecar name or null.
 */
export function resolveOwnSidecar(mediaName: string, index: DirIndex): { name: string | null; via: MatchVia } {
  const { base, counter } = splitCounter(mediaName);

  for (const cand of candidatesFor(base, counter)) {
    const hit = lookup(index, cand);
    if (hit) return { name: hit, via: "own" };
  }

  // Extension-omitted sidecar (ISC-18) — only when unambiguous (ISC-24 guard):
  // if another same-stem/different-ext media file exists, skip and report unmatched
  // rather than risk binding one photo's metadata to the wrong file.
  const extless = extensionOmittedCandidate(base, counter);
  if (extless && !hasSameStemMediaSibling(mediaName, index)) {
    const hit = lookup(index, extless);
    if (hit) return { name: hit, via: "own" };
  }

  const original = stripEditedToken(base);
  if (original) {
    for (const cand of candidatesFor(original, counter)) {
      const hit = lookup(index, cand);
      if (hit) return { name: hit, via: "edited-original" };
    }
  }

  return { name: null, via: null };
}

/**
 * For a live-photo motion file (.mov/.mp4) with no own sidecar, find the still
 * sibling (same stem, image extension) present in the directory. The motion file
 * inherits the still's sidecar.
 */
export function motionStillSibling(motionName: string, index: DirIndex): string | null {
  const ext = extname(motionName);
  if (!MOTION_EXTS.has(ext.toLowerCase())) return null;
  const stem = motionName.slice(0, motionName.length - ext.length);
  const stemLower = stem.toLowerCase();
  for (const actual of index.names) {
    const cext = extname(actual);
    if (!IMAGE_EXTS.has(cext.toLowerCase())) continue;
    const cstem = actual.slice(0, actual.length - cext.length);
    if (cstem === stem || cstem.toLowerCase() === stemLower) return actual;
  }
  return null;
}
