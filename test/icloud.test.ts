import { test, expect, describe } from "bun:test";
import { join } from "path";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "fs/promises";
import { readFileSync } from "fs";
import { tmpdir } from "os";
import { heuristicICloudEnabled } from "../src/icloud";

async function fakeLibrary(withCpl: boolean, mtime?: Date): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pb-lib-"));
  const lib = join(dir, "Photos Library.photoslibrary");
  await mkdir(join(lib, "resources", "cpl"), { recursive: true });
  if (withCpl) {
    const cpl = join(lib, "resources", "cpl", "cloudsync.noindex");
    await writeFile(cpl, "");
    if (mtime) await utimes(cpl, mtime, mtime);
  }
  return lib;
}

describe("heuristicICloudEnabled (ISC-62 passive detection)", () => {
  test("fresh cloud-sync artifacts → likely-on", async () => {
    const lib = await fakeLibrary(true);
    try {
      expect(heuristicICloudEnabled(lib).state).toBe("likely-on");
    } finally {
      await rm(join(lib, ".."), { recursive: true, force: true });
    }
  });

  test("no cloud-sync artifacts → likely-off", async () => {
    const lib = await fakeLibrary(false);
    try {
      expect(heuristicICloudEnabled(lib).state).toBe("likely-off");
    } finally {
      await rm(join(lib, ".."), { recursive: true, force: true });
    }
  });

  test("stale artifacts (30d) → unknown, not a false positive", async () => {
    const old = new Date(Date.now() - 30 * 86_400_000);
    const lib = await fakeLibrary(true, old);
    try {
      expect(heuristicICloudEnabled(lib).state).toBe("unknown");
    } finally {
      await rm(join(lib, ".."), { recursive: true, force: true });
    }
  });

  test("missing library → unknown", () => {
    expect(heuristicICloudEnabled("/nonexistent/lib.photoslibrary").state).toBe("unknown");
  });
});

describe("icloud CLI validation (no UI launched on bad input)", () => {
  test("invalid subaction exits 2 with usage", async () => {
    const proc = Bun.spawn(
      ["bun", "run", join(import.meta.dir, "..", "bin", "reheat.ts"), "icloud", "bogus"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(2);
    expect(err).toContain("status|on|off");
  });

  test("missing subaction exits 2", async () => {
    const proc = Bun.spawn(
      ["bun", "run", join(import.meta.dir, "..", "bin", "reheat.ts"), "icloud"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const code = await proc.exited;
    expect(code).toBe(2);
  });

  test("status is pure heuristic — exits 0, no UI, no permissions", async () => {
    const proc = Bun.spawn(
      ["bun", "run", join(import.meta.dir, "..", "bin", "reheat.ts"), "icloud", "status"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    expect(out).toContain("iCloud Photos");
  });
});

describe("Anti (ISC-64): daemon/run path never launches UI automation", () => {
  test("pipeline.ts and daemon.ts do not reference runICloudAction", () => {
    for (const f of ["pipeline.ts", "daemon.ts"]) {
      const src = readFileSync(join(import.meta.dir, "..", "src", f), "utf8");
      expect(src).not.toContain("runICloudAction");
    }
  });
});
