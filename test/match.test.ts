import { test, expect, describe } from "bun:test";
import { join } from "path";
import { readdirSync } from "fs";
import {
  buildDirIndex,
  resolveOwnSidecar,
  motionStillSibling,
  splitCounter,
  stripEditedToken,
  candidatesFor,
  classifyKind,
  isNonSidecarJson,
  type MatchVia,
} from "../src/match";

const ALBUM_A = join(
  import.meta.dir,
  "fixtures/takeout-mini/Takeout/Google Photos/Album A",
);

describe("splitCounter", () => {
  test("extracts trailing (n) and leaves plain names alone", () => {
    expect(splitCounter("IMG_0003(1).JPG")).toEqual({ base: "IMG_0003.JPG", counter: "(1)" });
    expect(splitCounter("IMG_0003.JPG")).toEqual({ base: "IMG_0003.JPG", counter: "" });
  });
});

describe("candidatesFor — the (n) counter moves to the tail (ISC-18/19)", () => {
  test("supplemental + legacy forms, never IMG(1).JPG.json", () => {
    const c = candidatesFor("IMG_0003.JPG", "(1)");
    expect(c).toContain("IMG_0003.JPG.supplemental-metadata(1).json");
    expect(c).toContain("IMG_0003.JPG(1).json");
    expect(c).not.toContain("IMG_0003(1).JPG.json");
  });
  test("generates FULL and truncated supplemental candidates, full tried first", () => {
    const c = candidatesFor("PXL_20230815_143025123.jpg", "");
    // Google sometimes leaves the full token (even > 46 chars) ...
    expect(c).toContain("PXL_20230815_143025123.jpg.supplemental-metadata.json");
    // ... and sometimes clips it to a 46-char stem — both must be candidates.
    expect(c).toContain("PXL_20230815_143025123.jpg.supplemental-metada.json");
    expect(c.indexOf("PXL_20230815_143025123.jpg.supplemental-metadata.json")).toBeLessThan(
      c.indexOf("PXL_20230815_143025123.jpg.supplemental-metada.json"),
    );
  });
});

describe("stripEditedToken (ISC-20)", () => {
  test("-edited resolves to the original name", () => {
    expect(stripEditedToken("IMG_0004-edited.JPG")).toBe("IMG_0004.JPG");
    expect(stripEditedToken("IMG_0004.JPG")).toBeNull();
  });
});

describe("matcher against the checked-in fixture tree (ISC-15..22)", () => {
  const index = buildDirIndex(readdirSync(ALBUM_A));

  const resolve = (media: string): { name: string | null; via: MatchVia } => {
    const own = resolveOwnSidecar(media, index);
    if (own.name) return own;
    if (classifyKind(media) === "video") {
      const still = motionStillSibling(media, index);
      if (still) {
        const r = resolveOwnSidecar(still, index);
        if (r.name) return { name: r.name, via: "motion-sibling" };
      }
    }
    return { name: null, via: null };
  };

  const cases: Array<[string, string | null]> = [
    ["IMG_0001.JPG", "IMG_0001.JPG.json"], // legacy
    ["IMG_0002.HEIC", "IMG_0002.HEIC.supplemental-metadata.json"], // supplemental
    ["PXL_20230815_143025123.jpg", "PXL_20230815_143025123.jpg.supplemental-metada.json"], // truncated
    ["IMG_0003.JPG", "IMG_0003.JPG.json"], // original of a dup pair
    ["IMG_0003(1).JPG", "IMG_0003.JPG(1).json"], // counter at tail
    ["IMG_0004.JPG", "IMG_0004.JPG.json"],
    ["IMG_0004-edited.JPG", "IMG_0004.JPG.json"], // inherit original
    ["IMG_0005.HEIC", "IMG_0005.HEIC.supplemental-metadata.json"], // live-photo still
    ["IMG_0005.MOV", "IMG_0005.HEIC.supplemental-metadata.json"], // live-photo motion inherits still
    ["IMG_0008.JPG", "IMG_0008.json"], // extension-omitted sidecar (ISC-18)
    // real-world: long name whose full supplemental sidecar (stem 52 > 46) is NOT truncated
    ["received_5164740663546561.jpeg", "received_5164740663546561.jpeg.supplemental-metadata.json"],
    ["IMG_0006.JPG", null], // no sidecar => unmatched
  ];

  for (const [media, expected] of cases) {
    test(`${media} → ${expected ?? "UNMATCHED"}`, () => {
      expect(resolve(media).name).toBe(expected);
    });
  }

  test("Anti: ambiguous extension-omitted sidecar is NOT guessed (ISC-24)", () => {
    // IMG_9000.jpg + IMG_9000.png share a stem; only IMG_9000.json exists.
    // Binding it to either would be a mispair — both must come back unmatched.
    expect(resolve("IMG_9000.jpg").name).toBeNull();
    expect(resolve("IMG_9000.png").name).toBeNull();
    // ...but an UNambiguous extension-omitted sidecar still resolves.
    expect(resolve("IMG_0008.JPG").name).toBe("IMG_0008.json");
  });

  test("Anti: dup counterparts map to DISTINCT sidecars, never mispaired (ISC-24)", () => {
    expect(resolve("IMG_0003.JPG").name).toBe("IMG_0003.JPG.json");
    expect(resolve("IMG_0003(1).JPG").name).toBe("IMG_0003.JPG(1).json");
    expect(resolve("IMG_0003.JPG").name).not.toBe(resolve("IMG_0003(1).JPG").name);
  });

  test("live-photo motion is matched via still sibling", () => {
    expect(resolve("IMG_0005.MOV").via).toBe("motion-sibling");
  });

  test("non-media JSON is excluded from sidecar consideration", () => {
    expect(isNonSidecarJson("metadata.json")).toBe(true);
    expect(isNonSidecarJson("IMG_0001.JPG.json")).toBe(false);
  });
});
