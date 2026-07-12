/**
 * Core domain types and the Source→Sink adapter seam (ISC-46).
 *
 * The seam exists so the same pipeline core can serve the general goal
 * "point anything that reads library X at photos in library Y". Takeout→Apple
 * Photos is pairing #1; a v2 sink (e.g. Google appendonly) drops in behind
 * the same interfaces without touching the core loop.
 */

export interface GeoData {
  latitude: number;
  longitude: number;
  altitude: number;
}

export interface SidecarMetadata {
  /** Capture time as UTC unix seconds, or null if unknown. */
  takenTimeUnix: number | null;
  /** Where the time came from: authoritative photoTakenTime, inferior creationTime, or none. */
  timeSource: "photoTaken" | "creation" | null;
  /** Location, or null when absent or the "0/0/0 = no location" sentinel (ISC-27). */
  geo: GeoData | null;
  /** Caption/description text, or null when empty. */
  description: string | null;
  /** Original (pre-truncation) filename — disambiguation tiebreaker only, never a match key. */
  title: string | null;
}

export type MediaKind = "image" | "video";

export interface MediaItem {
  /** Absolute path to the media file on disk. */
  path: string;
  kind: MediaKind;
  /** SHA-256 of the ORIGINAL bytes, computed BEFORE any merge mutates the file (ISC-37). */
  hash: string;
  /** Resolved sidecar path, or null if unmatched (ISC-22). */
  sidecarPath: string | null;
  /** How the sidecar was resolved — for logging and audit. */
  matchedVia: "own" | "edited-original" | "motion-sibling" | null;
  /** Normalized metadata from the sidecar, or null when unmatched. */
  metadata: SidecarMetadata | null;
}

/** A media file that could not be paired with a sidecar (ISC-22 report, never dropped). */
export interface UnmatchedItem {
  path: string;
  reason: string;
}

/** A source produces import-ready media items from some origin (Takeout, …). */
export interface PhotoSource {
  readonly name: string;
  /** Enumerate all media with sidecars resolved and original-byte hashes computed. */
  collect(): Promise<{ items: MediaItem[]; unmatched: UnmatchedItem[] }>;
}

export interface ImportResult {
  /** Paths confirmed present in the sink. */
  imported: string[];
  /** Paths intentionally not imported (dedup or dry-run). */
  skipped: string[];
  /** Paths that failed to import, with reasons. */
  failed: { path: string; reason: string }[];
}

/** A sink imports enriched media into some library (Apple Photos, …). */
export interface PhotoSink {
  readonly name: string;
  /** Import files; MUST confirm presence before reporting a path as imported (ISC-44). */
  importFiles(paths: string[], opts: { dryRun: boolean }): Promise<ImportResult>;
}
