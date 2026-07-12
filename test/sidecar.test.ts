import { test, expect, describe } from "bun:test";
import { parseSidecar } from "../src/sidecar";

describe("parseSidecar", () => {
  test("photoTakenTime is authoritative", () => {
    const md = parseSidecar(JSON.stringify({
      photoTakenTime: { timestamp: "1692111925" },
      creationTime: { timestamp: "1000" },
    }));
    expect(md.takenTimeUnix).toBe(1692111925);
    expect(md.timeSource).toBe("photoTaken");
  });

  test("falls back to creationTime when photoTakenTime absent", () => {
    const md = parseSidecar(JSON.stringify({ creationTime: { timestamp: "1692111925" } }));
    expect(md.takenTimeUnix).toBe(1692111925);
    expect(md.timeSource).toBe("creation");
  });

  test("geoData 0/0/0 means no location (ISC-27)", () => {
    const md = parseSidecar(JSON.stringify({ geoData: { latitude: 0, longitude: 0, altitude: 0 } }));
    expect(md.geo).toBeNull();
  });

  test("geoDataExif is the fallback only when geoData is zeroed", () => {
    const md = parseSidecar(JSON.stringify({
      geoData: { latitude: 0, longitude: 0, altitude: 0 },
      geoDataExif: { latitude: 1.5, longitude: 2.5, altitude: 3 },
    }));
    expect(md.geo).toEqual({ latitude: 1.5, longitude: 2.5, altitude: 3 });
  });

  test("real geoData is preferred over geoDataExif", () => {
    const md = parseSidecar(JSON.stringify({
      geoData: { latitude: 10, longitude: 20, altitude: 0 },
      geoDataExif: { latitude: 99, longitude: 99, altitude: 0 },
    }));
    expect(md.geo).toEqual({ latitude: 10, longitude: 20, altitude: 0 });
  });

  test("blank description becomes null (no empty caption written)", () => {
    expect(parseSidecar(JSON.stringify({ description: "   " })).description).toBeNull();
    expect(parseSidecar(JSON.stringify({ description: "hi" })).description).toBe("hi");
  });
});
