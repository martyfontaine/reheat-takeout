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
  written: number;
  skipped: number;
  errors: { path: string; reason: string }[];
}

/**
 * Merge metadata into a batch of files using a SINGLE exiftool process driven by
 * an arg-file with `-execute` blocks (ISC-31 — never one process per file).
 */
export async function mergeBatch(items: MediaItem[], displayTz: string): Promise<MergeOutcome> {
  const lines: string[] = [];
  const targets: MediaItem[] = [];

  for (const item of items) {
    const args = buildArgsForItem(item, displayTz);
    if (!args) continue;
    for (const a of args) lines.push(a);
    lines.push(item.path);
    lines.push("-execute");
    targets.push(item);
  }

  if (targets.length === 0) return { written: 0, skipped: items.length, errors: [] };

  // Common args apply to every -execute'd command.
  lines.push("-common_args");
  lines.push("-overwrite_original");
  lines.push("-api");
  lines.push("QuickTimeUTC=1");
  lines.push("-charset");
  lines.push("filename=utf8");

  const argfile = join(tmpdir(), `pb-exif-${Date.now()}-${Math.random().toString(36).slice(2)}.args`);
  await Bun.write(argfile, lines.join("\n") + "\n");
  try {
    const proc = Bun.spawn(["exiftool", "-@", argfile], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0 && !/files updated/.test(stdout)) {
      return {
        written: 0,
        skipped: 0,
        errors: targets.map((t) => ({ path: t.path, reason: stderr.trim() || `exiftool exit ${code}` })),
      };
    }
    return { written: targets.length, skipped: items.length - targets.length, errors: [] };
  } finally {
    await rm(argfile, { force: true });
  }
}

/** Read back specific tags from a file as JSON (for verification / tests). `-n` = numeric (GPS as decimal). */
export async function readTags(path: string, tags: string[]): Promise<Record<string, unknown>> {
  const args = ["-j", "-n", ...tags.map((t) => `-${t}`), path];
  const proc = Bun.spawn(["exiftool", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const arr = JSON.parse(stdout) as Record<string, unknown>[];
  return arr[0] ?? {};
}
