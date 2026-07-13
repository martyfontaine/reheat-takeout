import { test, expect, describe } from "bun:test";
import { join } from "path";
import { mkdtemp, copyFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { mergeBatch, readTags, formatExifLocal, formatExifUTC } from "../src/merge";
import type { MediaItem } from "../src/types";

const PIXEL = join(import.meta.dir, "fixtures/pixel.jpg");

function exifExpected(epochSec: number): string {
  // "2023-08-15T14:25:25.000Z" -> "2023:08:15 14:25:25" (UTC)
  const iso = new Date(epochSec * 1000).toISOString().slice(0, 19);
  return iso.replace("T", " ").replace(/-/g, ":");
}

describe("timezone formatting (ISC-30)", () => {
  test("UTC epoch renders wall-clock + offset", () => {
    const r = formatExifLocal(1692111925, "UTC");
    expect(r.dateTime).toBe(exifExpected(1692111925));
    expect(r.offset).toBe("+00:00");
  });
  test("formatExifUTC matches the UTC wall clock", () => {
    expect(formatExifUTC(1692111925)).toBe(exifExpected(1692111925));
  });
});

describe("merge writes real EXIF and it reads back (ISC-25/26/28/33/34)", () => {
  test("date + GPS + caption round-trip through exiftool", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pb-merge-"));
    try {
      const file = join(dir, "photo.jpg");
      await copyFile(PIXEL, file);

      const item: MediaItem = {
        path: file,
        kind: "image",
        hash: "unused",
        sidecarPath: "unused",
        matchedVia: "own",
        metadata: {
          takenTimeUnix: 1692111925,
          timeSource: "photoTaken",
          geo: { latitude: 37.7749, longitude: -122.4194, altitude: 12 },
          description: "Beach day",
          title: null,
        },
      };

      const out = await mergeBatch([item], "UTC");
      expect(out.written).toBe(1);
      expect(out.errors).toEqual([]);
      expect(out.importable).toEqual([file]); // merged → safe to import

      const tags = await readTags(file, [
        "DateTimeOriginal",
        "GPSLatitude",
        "GPSLongitude",
        "ImageDescription",
        "FileModifyDate",
      ]);
      expect(tags.DateTimeOriginal).toBe(exifExpected(1692111925)); // ISC-33
      expect(String(tags.FileModifyDate)).toContain("2023:08:15"); // ISC-29 mtime set to capture date
      expect(Math.abs(Number(tags.GPSLatitude) - 37.7749)).toBeLessThan(0.001); // ISC-34
      expect(Math.abs(Number(tags.GPSLongitude) - -122.4194)).toBeLessThan(0.001);
      expect(tags.ImageDescription).toBe("Beach day");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("multi-line caption does not corrupt the batch (Cato: argfile newline)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pb-cap-"));
    try {
      const file = join(dir, "photo.jpg");
      await copyFile(PIXEL, file);
      const item: MediaItem = {
        path: file,
        kind: "image",
        hash: "x",
        sidecarPath: "s",
        matchedVia: "own",
        metadata: {
          takenTimeUnix: 1692111925,
          timeSource: "photoTaken",
          geo: null,
          description: "line one\nline two\r\nline three",
          title: null,
        },
      };
      const out = await mergeBatch([item], "UTC");
      expect(out.written).toBe(1);
      expect(out.errors).toEqual([]);
      const tags = await readTags(file, ["ImageDescription", "DateTimeOriginal"]);
      expect(String(tags.ImageDescription)).toBe("line one line two line three"); // collapsed, intact
      expect(tags.DateTimeOriginal).toBe(exifExpected(1692111925)); // date still landed
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("0/0/0 geo writes no GPS (ISC-27); nothing blank is stamped (ISC-35)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pb-merge2-"));
    try {
      const file = join(dir, "photo.jpg");
      await copyFile(PIXEL, file);
      const item: MediaItem = {
        path: file,
        kind: "image",
        hash: "x",
        sidecarPath: "s",
        matchedVia: "own",
        metadata: {
          takenTimeUnix: 1692111925,
          timeSource: "photoTaken",
          geo: null, // 0/0/0 was normalized to null upstream
          description: null,
          title: null,
        },
      };
      await mergeBatch([item], "UTC");
      const tags = await readTags(file, ["GPSLatitude", "ImageDescription"]);
      expect(tags.GPSLatitude).toBeUndefined();
      expect(tags.ImageDescription).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
