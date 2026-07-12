/**
 * ApplePhotosSink — PhotoSink #1 (ISC-42..46).
 *
 * Imports via AppleScript (File▸Import path) rather than touching the opaque
 * `.photoslibrary` package directly. Because the merge already embedded correct
 * EXIF, Photos reads the right date on a plain import — no signed Swift helper
 * needed in v1. The AppleScript `import` command returns the list of added items;
 * that count confirms presence BEFORE the caller records anything (ISC-44).
 * Imports are chunked so one failure never loses a whole batch (ISC-43).
 */
import type { PhotoSink, ImportResult } from "../types";

const AUTOMATION_HINT =
  "Apple Photos automation is not authorized. Grant it in System Settings ▸ Privacy & Security ▸ " +
  "Automation (allow your terminal / Bun to control Photos), then re-run.";

const IMPORT_SCRIPT = `on run argv
  set theFiles to {}
  repeat with p in argv
    set end of theFiles to (POSIX file (p as text))
  end repeat
  tell application "Photos"
    set added to import theFiles skip check duplicates true
    return (count of added) as text
  end tell
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
        const confirmed = await this.importChunk(chunk);
        if (confirmed >= chunk.length) {
          result.imported.push(...chunk);
        } else {
          // A bare count can't say WHICH succeeded, so we conservatively fail the
          // chunk — nothing gets recorded that wasn't confirmed (ISC-44).
          result.failed.push(
            ...chunk.map((p) => ({ path: p, reason: `import confirmed ${confirmed}/${chunk.length}` })),
          );
        }
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        result.failed.push(...chunk.map((p) => ({ path: p, reason })));
      }
    }
    return result;
  }

  private async importChunk(paths: string[]): Promise<number> {
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
    return Number.parseInt(stdout.trim(), 10) || 0;
  }
}

function* chunked<T>(arr: T[], size: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}
