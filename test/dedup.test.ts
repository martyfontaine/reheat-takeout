import { test, expect, describe } from "bun:test";
import { join } from "path";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { StateStore } from "../src/state";
import { TakeoutSource } from "../src/source/takeout";

const ROOT = join(import.meta.dir, "fixtures/takeout-mini");

describe("StateStore (ISC-36/40/41)", () => {
  test("record → has, and re-record is idempotent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pb-db-"));
    try {
      const store = await StateStore.open(join(dir, "state.sqlite"));
      expect(store.has("hashA")).toBe(false);
      store.recordImported("hashA", "x.jpg", 1692111925, null);
      expect(store.has("hashA")).toBe(true);
      store.recordImported("hashA", "x.jpg", 1692111925, "asset-1"); // idempotent on hash
      expect(store.importedCount()).toBe(1);
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("content-hash dedup (ISC-37/39)", () => {
  test("identical bytes across albums produce identical hashes", async () => {
    const { items } = await new TakeoutSource([ROOT]).collect();
    const a = items.find((i) => i.path.endsWith("Album A/IMG_0100.JPG"));
    const b = items.find((i) => i.path.endsWith("Album B/IMG_0100.JPG"));
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.hash).toBe(b!.hash); // album duplication collapses to one hash

    // simulate the pipeline's dedup filter
    const store = new Set<string>();
    let imported = 0;
    for (const i of [a!, b!]) {
      if (store.has(i.hash)) continue;
      store.add(i.hash);
      imported++;
    }
    expect(imported).toBe(1); // exactly one import despite two album copies
  });

  test("unmatched files are reported, not collected", async () => {
    const { items, unmatched } = await new TakeoutSource([ROOT]).collect();
    expect(unmatched.some((u) => u.path.endsWith("IMG_0006.JPG"))).toBe(true); // no sidecar
    expect(items.some((i) => i.path.endsWith("IMG_0006.JPG"))).toBe(false);
  });
});
