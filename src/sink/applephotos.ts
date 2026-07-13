/**
 * ApplePhotosSink — PhotoSink #1 (ISC-42..46).
 *
 * Imports via AppleScript (File▸Import path) rather than touching the opaque
 * `.photoslibrary` package directly. Because the merge already embedded correct
 * EXIF, Photos reads the right date on a plain import — no signed Swift helper
 * needed in v1.
 *
 * The script imports each file individually inside one osascript call and returns a
 * PER-FILE status line ("1" imported, "0" not), so the caller records EXACTLY the
 * files Photos confirmed (ISC-44). This is why a partial chunk is safe: we know which
 * files landed, so a retry re-imports only the ones that did not — no duplicates
 * (`skip check duplicates true` means Photos would otherwise re-add a confirmed file).
 * One process per chunk keeps import throughput up (ISC-43); Photos I/O dominates the
 * per-file loop cost.
 */
import type { PhotoSink, ImportResult } from "../types";

const AUTOMATION_HINT =
  "Apple Photos automation is not authorized. Grant it in System Settings ▸ Privacy & Security ▸ " +
  "Automation (allow your terminal / Bun to control Photos), then re-run.";

// One line of output per input path ("1"/"0"), in argv order, so results map back to
// the exact source file. A per-file try/error means one bad file never aborts the rest.
const IMPORT_SCRIPT = `on run argv
  set out to ""
  tell application "Photos"
    repeat with p in argv
      try
        set added to import {(POSIX file (p as text))} skip check duplicates true
        if (count of added) is greater than or equal to 1 then
          set out to out & "1" & linefeed
        else
          set out to out & "0" & linefeed
        end if
      on error
        set out to out & "0" & linefeed
      end try
    end repeat
  end tell
  return out
end run`;

export class ApplePhotosSink implements PhotoSink {
  readonly name = "Apple Photos";

  constructor(private readonly chunkSize = 100) {}

  async importFiles(paths: string[], opts: { dryRun: boolean }): Promise<ImportResult> {
    const result: ImportResult = { imported: [], skipped: [], failed: [] };
    if (opts.dryRun) {
      result.skipped.push(...paths);
      return result;
    }
    for (const chunk of chunked(paths, this.chunkSize)) {
      try {
        const statuses = await this.importChunk(chunk);
        chunk.forEach((p, i) => {
          if (statuses[i]) result.imported.push(p);
          else result.failed.push({ path: p, reason: "Photos did not confirm import" });
        });
      } catch (e) {
        // A whole-chunk error (e.g. automation not authorized) — fail the chunk; the
        // files stay unrecorded and retry next run.
        const reason = e instanceof Error ? e.message : String(e);
        result.failed.push(...chunk.map((p) => ({ path: p, reason })));
      }
    }
    return result;
  }

  /** Per-path success flags, in input order. Throws on a chunk-wide failure. */
  private async importChunk(paths: string[]): Promise<boolean[]> {
    const proc = Bun.spawn(["osascript", "-e", IMPORT_SCRIPT, ...paths], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      const err = stderr.trim();
      if (/-1743|not authoriz/i.test(err)) throw new Error(AUTOMATION_HINT); // ISC-56
      throw new Error(err || `osascript exit ${code}`);
    }
    const flags = stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    // Defensive: if we didn't get exactly one status per file, we can't attribute
    // results — fail the chunk rather than mis-record (nothing gets recorded unconfirmed).
    if (flags.length !== paths.length) {
      throw new Error(`import returned ${flags.length} statuses for ${paths.length} files`);
    }
    return flags.map((f) => f === "1");
  }
}

function* chunked<T>(arr: T[], size: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}
