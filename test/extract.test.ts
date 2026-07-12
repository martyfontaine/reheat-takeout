import { test, expect, describe } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { classifyArchive, extractArchive, multipartSiblings } from "../src/extract";
import { isTakeoutTree, scanMedia } from "../src/scan";

const FIXROOT = join(import.meta.dir, "fixtures/takeout-mini"); // contains Takeout/

async function makeZip(srcDir: string, zipPath: string): Promise<void> {
  const proc = Bun.spawn(["ditto", "-c", "-k", "--sequesterRsrc", srcDir, zipPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`zip failed: ${err}`);
}

describe("classifyArchive (ISC-11)", () => {
  test("detects zip and tgz/tar.gz", () => {
    expect(classifyArchive("takeout.zip")).toBe("zip");
    expect(classifyArchive("takeout.tar.gz")).toBe("tgz");
    expect(classifyArchive("takeout.tgz")).toBe("tgz");
    expect(classifyArchive("notes.txt")).toBeNull();
  });
});

describe("multipartSiblings (ISC-10)", () => {
  test("groups -001/-002 and ignores unrelated zips", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pb-mp-"));
    try {
      await writeFile(join(dir, "takeout-20260101-001.zip"), "");
      await writeFile(join(dir, "takeout-20260101-002.zip"), "");
      await writeFile(join(dir, "unrelated.zip"), "");
      const sib = await multipartSiblings(join(dir, "takeout-20260101-001.zip"));
      expect(sib.length).toBe(2);
      const single = await multipartSiblings(join(dir, "unrelated.zip"));
      expect(single.length).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("extract + Takeout detection (ISC-9/12/13)", () => {
  test("a real zip extracts, is detected as Takeout, and media enumerate", async () => {
    const work = await mkdtemp(join(tmpdir(), "pb-ex-"));
    try {
      const zip = join(work, "takeout.zip");
      await makeZip(FIXROOT, zip); // archives the tree containing Takeout/
      const res = await extractArchive(zip, join(work, "out"));
      expect(await isTakeoutTree(res.workDir)).toBe(true);
      const { media } = await scanMedia(res.workDir);
      expect(media.length).toBeGreaterThan(5);
      expect(media.some((m) => m.name === "IMG_0001.JPG")).toBe(true);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  test("a non-Takeout zip is ignored (ISC-12)", async () => {
    const work = await mkdtemp(join(tmpdir(), "pb-nz-"));
    try {
      const src = join(work, "stuff");
      await mkdir(join(src, "random"), { recursive: true });
      await writeFile(join(src, "random", "a.jpg"), "x");
      const zip = join(work, "notakeout.zip");
      await makeZip(src, zip);
      const res = await extractArchive(zip, join(work, "out"));
      expect(await isTakeoutTree(res.workDir)).toBe(false);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});
