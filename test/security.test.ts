import { test, expect, describe } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir, writeFile, copyFile, symlink } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { generatePlist } from "../src/daemon";
import { extractArchive } from "../src/extract";
import { scanMedia } from "../src/scan";
import { TakeoutSource } from "../src/source/takeout";
import { defaultConfig } from "../src/config";

const PIXEL = join(import.meta.dir, "fixtures/pixel.jpg");

describe("F1 — plist XML injection is escaped", () => {
  test("XML metacharacters in inboxDir cannot break out of <string>", () => {
    const cfg = {
      ...defaultConfig(),
      inboxDir: "/tmp/pwn</string><key>INJECTED_EVIL</key><string>yes",
      logPath: "/tmp/a&b<c>.log",
    };
    const plist = generatePlist(cfg);
    expect(plist).not.toContain("<key>INJECTED_EVIL</key>"); // not active XML
    expect(plist).toContain("&lt;key&gt;INJECTED_EVIL"); // escaped instead
    expect(plist).toContain("a&amp;b&lt;c&gt;.log"); // logPath escaped too
  });
});

// Minimal stored-ZIP writer to craft a malicious path-traversal archive.
function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    let c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function buildStoredZip(name: string, data: string): Uint8Array {
  const enc = new TextEncoder();
  const nameB = enc.encode(name);
  const dataB = enc.encode(data);
  const crc = crc32(dataB);
  const p: number[] = [];
  const p16 = (n: number) => p.push(n & 0xff, (n >>> 8) & 0xff);
  const p32 = (n: number) => p.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
  p32(0x04034b50); p16(20); p16(0); p16(0); p16(0); p16(0);
  p32(crc); p32(dataB.length); p32(dataB.length); p16(nameB.length); p16(0);
  p.push(...nameB, ...dataB);
  const cd = p.length;
  p32(0x02014b50); p16(20); p16(20); p16(0); p16(0); p16(0); p16(0);
  p32(crc); p32(dataB.length); p32(dataB.length);
  p16(nameB.length); p16(0); p16(0); p16(0); p16(0); p32(0); p32(0);
  p.push(...nameB);
  const cdSize = p.length - cd;
  p32(0x06054b50); p16(0); p16(0); p16(1); p16(1); p32(cdSize); p32(cd); p16(0);
  return new Uint8Array(p);
}

describe("F2 — archive extraction cannot escape (zip-slip / symlink)", () => {
  test("a path-traversal zip does not write outside the work dir", async () => {
    const sbx = await mkdtemp(join(tmpdir(), "sec-slip-"));
    try {
      const escapeDir = join(sbx, "escapecheck");
      await mkdir(escapeDir, { recursive: true });
      const escaped = join(escapeDir, "PWNED.txt");
      await writeFile(join(sbx, "evil.zip"), buildStoredZip("../../escapecheck/PWNED.txt", "payload"));
      try {
        await extractArchive(join(sbx, "evil.zip"), join(sbx, "work"));
      } catch {
        /* rejecting the archive is also an acceptable (fail-closed) outcome */
      }
      expect(existsSync(escaped)).toBe(false); // contained
    } finally {
      await rm(sbx, { recursive: true, force: true });
    }
  });

  test("symlinks in the tree are never scanned as media", async () => {
    const sbx = await mkdtemp(join(tmpdir(), "sec-sym-"));
    try {
      const album = join(sbx, "Takeout", "Google Photos", "Album");
      await mkdir(album, { recursive: true });
      await copyFile(PIXEL, join(album, "real.jpg"));
      await writeFile(join(album, "real.jpg.supplemental-metadata.json"), '{"photoTakenTime":{"timestamp":"1600000000"}}');
      await symlink("/etc/passwd", join(album, "passwd.jpg")); // hostile symlink masquerading as media
      const { media } = await scanMedia(sbx);
      expect(media.map((m) => m.name)).toEqual(["real.jpg"]);
      expect(media.some((m) => m.name === "passwd.jpg")).toBe(false);
    } finally {
      await rm(sbx, { recursive: true, force: true });
    }
  });
});

describe("F3 — a malformed sidecar does not abort the import", () => {
  test("bad JSON is reported unmatched; good items still collected", async () => {
    const sbx = await mkdtemp(join(tmpdir(), "sec-json-"));
    try {
      const album = join(sbx, "Takeout", "Google Photos", "Album");
      await mkdir(album, { recursive: true });
      await copyFile(PIXEL, join(album, "good.jpg"));
      await writeFile(join(album, "good.jpg.supplemental-metadata.json"), '{"photoTakenTime":{"timestamp":"1600000000"}}');
      await copyFile(PIXEL, join(album, "bad.jpg"));
      await writeFile(join(album, "bad.jpg.supplemental-metadata.json"), "{ this is not valid json ");

      const { items, unmatched } = await new TakeoutSource([sbx]).collect(); // must not throw
      expect(items.some((i) => i.path.endsWith("good.jpg"))).toBe(true);
      expect(unmatched.some((u) => u.path.endsWith("bad.jpg"))).toBe(true);
    } finally {
      await rm(sbx, { recursive: true, force: true });
    }
  });
});
