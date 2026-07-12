import { test, expect, describe } from "bun:test";
import { join } from "path";
import { mkdtemp, copyFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { mergeBatch, readTags, formatExifUTC } from "../src/merge";
import type { MediaItem } from "../src/types";

// Small checked-in .mov (dates stripped) so this runs without ffmpeg.
const CLIP = join(import.meta.dir, "fixtures/clip.mov");

describe("video merge writes QuickTime dates, not just JPEG EXIF (ISC-32)", () => {
  test("mov gets QuickTime CreateDate/ModifyDate + Keys:CreationDate, read back exact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pb-vid-"));
    try {
      const file = join(dir, "clip.mov");
      await copyFile(CLIP, file);
      const epoch = 1692111925;
      const item: MediaItem = {
        path: file,
        kind: "video",
        hash: "x",
        sidecarPath: "s",
        matchedVia: "own",
        metadata: {
          takenTimeUnix: epoch,
          timeSource: "photoTaken",
          geo: null,
          description: null,
          title: null,
        },
      };
      const out = await mergeBatch([item], "UTC");
      expect(out.written).toBe(1);
      expect(out.errors).toEqual([]);

      const t = await readTags(file, ["QuickTime:CreateDate", "QuickTime:ModifyDate", "Keys:CreationDate"]);
      expect(t.CreateDate).toBe(formatExifUTC(epoch));
      expect(t.ModifyDate).toBe(formatExifUTC(epoch));
      expect(String(t.CreationDate)).toContain(formatExifUTC(epoch));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("QuickTime date is UTC regardless of display timezone (Cato: non-UTC tz)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pb-vidtz-"));
    try {
      const file = join(dir, "clip.mov");
      await copyFile(CLIP, file);
      const epoch = 1692111925;
      const item: MediaItem = {
        path: file,
        kind: "video",
        hash: "x",
        sidecarPath: "s",
        matchedVia: "own",
        metadata: { takenTimeUnix: epoch, timeSource: "photoTaken", geo: null, description: null, title: null },
      };
      // Render with a NON-UTC display tz; QuickTime CreateDate must still be the UTC
      // wall-clock (QuickTime dates are UTC), while Keys:CreationDate carries the offset.
      await mergeBatch([item], "America/Vancouver");
      const t = await readTags(file, ["QuickTime:CreateDate", "Keys:CreationDate"]);
      expect(t.CreateDate).toBe(formatExifUTC(epoch)); // UTC, tz-independent
      expect(String(t.CreationDate)).toMatch(/[-+]\d{2}:\d{2}$/); // carries an explicit offset
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
