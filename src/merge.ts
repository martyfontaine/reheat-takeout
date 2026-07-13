/**
 * Metadata merge — the product (ISC-25..35).
 *
 * Google stores capture time as a UTC epoch and location in the sidecar. Apple
 * Photos reads *date-taken* from EXIF `DateTimeOriginal`/`CreateDate` for images
 * and from QuickTime tags for video — NEVER from filesystem mtime. So the merge
 * writes true metadata back into the file's EXIF/QuickTime blocks. That is the
 * whole differentiator vs GPTH (which only touches mtime and stops before import).
 *
 * Timezone (ISC-30): EXIF datetime is a naked wall-clock with no zone; the epoch
 * is UTC. We render the wall-clock in the configured display tz and ALSO write
 * OffsetTimeOriginal so tz-aware readers are unambiguous. Video QuickTime dates
 * are written in UTC (QuickTime convention, with `-api QuickTimeUTC=1`).
 *
 * Only non-empty values are ever written — a file with good existing EXIF is
 * never overwritten with blank data (ISC-35).
 */
import { rm } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { MediaItem } from "./types";

/**
 * Resolve exiftool to an absolute path. Under launchd the PATH is minimal
 * (/usr/bin:/bin:/usr/sbin:/sbin) and excludes Homebrew, so a bare "exiftool"
 * would not be found when the daemon fires. Resolve it once, robustly.
 */
let exiftoolPathCache: string | null = null;
export function exiftoolBin(): string {
  if (exiftoolPathCache) return exiftoolPathCache;
  const found =
    Bun.which("exiftool") ??
    ["/opt/homebrew/bin/exiftool", "/usr/local/bin/exiftool"].find((p) => existsSync(p)) ??
    "exiftool";
  exiftoolPathCache = found;
  return found;
}

/** Format a UTC epoch as a wall-clock in `tz`, plus the numeric offset. */
export function formatExifLocal(epochSec: number, tz: string): { dateTime: string; offset: string } {
  const date = new Date(epochSec * 1000);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  // Intl can emit "24" for hour at midnight; normalize to "00".
  let hour = parts.hour === "24" ? "00" : parts.hour;
  const dateTime = `${parts.year}:${parts.month}:${parts.day} ${hour}:${parts.minute}:${parts.second}`;

  const asIfUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const offsetMin = Math.round((asIfUTC - date.getTime()) / 60000);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return { dateTime, offset };
}

/** Format a UTC epoch as an EXIF-style UTC wall-clock (for QuickTime). */
export function formatExifUTC(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}:${p(d.getUTCMonth() + 1)}:${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** Build the exiftool args for one item, or null if there is nothing to write. */
export function buildArgsForItem(item: MediaItem, displayTz: string): string[] | null {
  const md = item.metadata;
  if (!md) return null;
  const args: string[] = [];

  if (md.takenTimeUnix !== null) {
    const local = formatExifLocal(md.takenTimeUnix, displayTz);
    if (item.kind === "image") {
      args.push(`-DateTimeOriginal=${local.dateTime}`); // ISC-25
      args.push(`-CreateDate=${local.dateTime}`);
      args.push(`-OffsetTimeOriginal=${local.offset}`); // ISC-30
      args.push(`-OffsetTimeDigitized=${local.offset}`);
    } else {
      const utc = formatExifUTC(md.takenTimeUnix); // ISC-32: video QuickTime dates
      args.push(`-QuickTime:CreateDate=${utc}`);
      args.push(`-QuickTime:ModifyDate=${utc}`);
      args.push(`-Keys:CreationDate=${local.dateTime}${local.offset}`); // com.apple.quicktime.creationdate
    }
    args.push(`-FileModifyDate=${local.dateTime}${local.offset}`); // ISC-29: belt-and-suspenders mtime
  }

  const g = md.geo;
  if (g) {
    args.push(`-GPSLatitude=${Math.abs(g.latitude)}`); // ISC-26
    args.push(`-GPSLatitudeRef=${g.latitude >= 0 ? "N" : "S"}`);
    args.push(`-GPSLongitude=${Math.abs(g.longitude)}`);
    args.push(`-GPSLongitudeRef=${g.longitude >= 0 ? "E" : "W"}`);
    if (g.altitude !== 0) {
      args.push(`-GPSAltitude=${Math.abs(g.altitude)}`);
      args.push(`-GPSAltitudeRef=${g.altitude >= 0 ? "0" : "1"}`); // 0=above, 1=below sea level
    }
  }

  if (md.description) {
    // Argfiles are newline-delimited with no escape for embedded newlines, so a
    // multi-line caption would corrupt the whole batch. Collapse to one line.
    const desc = md.description.replace(/[\r\n]+/g, " ").trim();
    if (desc.length > 0) {
      args.push(`-ImageDescription=${desc}`); // ISC-28
      args.push(`-XMP-dc:Description=${desc}`);
      args.push(`-IPTC:Caption-Abstract=${desc}`);
    }
  }

  return args.length > 0 ? args : null;
}

export interface MergeOutcome {
  /** Items exiftool successfully wrote metadata into. */
  written: number;
  /** Items with no metadata to write — imported as-is (still counted importable). */
  skipped: number;
  /**
   * Paths safe to hand to the sink: metadata was written, or there was nothing to
   * write. Items whose merge FAILED are excluded here and listed in `errors`, so the
   * pipeline never imports a photo as "done" without the metadata that is the product.
   */
  importable: string[];
  /** Items that must NOT be imported (write failed, or an unsafe filename). */
  errors: { path: string; reason: string }[];
}

/** Escape a string for safe embedding inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Merge metadata into a batch of files using a SINGLE exiftool process driven by
 * an arg-file with `-execute` blocks (ISC-31 — never one process per file).
 *
 * Failures are attributed per file so the caller can import only what merged: a bad
 * file (or one with an unsafe name) is reported in `errors` and kept out of the
 * import, rather than sinking the batch or being imported without its metadata.
 */
export async function mergeBatch(items: MediaItem[], displayTz: string): Promise<MergeOutcome> {
  const lines: string[] = [];
  const targets: MediaItem[] = [];
  const importable: string[] = [];
  const errors: { path: string; reason: string }[] = [];
  let noWrite = 0;

  for (const item of items) {
    // Security guard: exiftool's -@ argfile is newline-delimited, so a media path
    // containing a newline would split into extra lines and be interpreted as exiftool
    // OPTIONS — option injection from a hostile archive filename. (The description is
    // collapsed for the same reason below; the path must be guarded too.) A real
    // Takeout filename never contains control characters — reject rather than merge.
    if (/[\r\n]/.test(item.path)) {
      errors.push({ path: item.path, reason: "unsafe filename (contains newline); not imported" });
      continue;
    }
    const args = buildArgsForItem(item, displayTz);
    if (!args) {
      importable.push(item.path); // nothing to write, but the photo still imports
      noWrite++;
      continue;
    }
    for (const a of args) lines.push(a);
    lines.push(item.path);
    lines.push("-execute");
    targets.push(item);
  }

  if (targets.length === 0) return { written: 0, skipped: noWrite, importable, errors };

  // Common args apply to every -execute'd command.
  lines.push("-common_args");
  lines.push("-overwrite_original");
  lines.push("-api");
  lines.push("QuickTimeUTC=1");
  lines.push("-charset");
  lines.push("filename=utf8");

  const argfile = join(tmpdir(), `reheat-exif-${Date.now()}-${Math.random().toString(36).slice(2)}.args`);
  await Bun.write(argfile, lines.join("\n") + "\n");
  try {
    const proc = Bun.spawn([exiftoolBin(), "-@", argfile], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    // Attribute failures per file: exiftool prints "Error: <msg> - <path>" for each
    // file it could not write. A target not named in any Error line succeeded.
    const failed = new Set<string>();
    for (const t of targets) {
      if (new RegExp(`Error[^\\n]*${escapeRegExp(t.path)}`).test(stderr)) failed.add(t.path);
    }
    // A non-zero exit we cannot pin to specific files (e.g. exiftool failed to start)
    // fails the whole batch — never import unverified.
    if (code !== 0 && failed.size === 0 && !/\d+ (?:image )?files? updated/.test(stdout)) {
      for (const t of targets) failed.add(t.path);
    }

    for (const t of targets) {
      if (failed.has(t.path)) {
        errors.push({ path: t.path, reason: stderr.trim().slice(0, 200) || `exiftool exit ${code}` });
      } else {
        importable.push(t.path);
      }
    }
    return { written: targets.length - failed.size, skipped: noWrite, importable, errors };
  } finally {
    await rm(argfile, { force: true });
  }
}

/** Read back specific tags from a file as JSON (for verification / tests). `-n` = numeric (GPS as decimal). */
export async function readTags(path: string, tags: string[]): Promise<Record<string, unknown>> {
  const args = ["-j", "-n", ...tags.map((t) => `-${t}`), path];
  const proc = Bun.spawn([exiftoolBin(), ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const arr = JSON.parse(stdout) as Record<string, unknown>[];
  return arr[0] ?? {};
}
