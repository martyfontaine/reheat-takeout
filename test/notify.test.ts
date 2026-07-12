import { test, expect, describe } from "bun:test";
import { buildNotifyScript } from "../src/notify";

describe("buildNotifyScript", () => {
  test("includes title, subtitle, message and sound", () => {
    expect(buildNotifyScript({ title: "T", message: "M", subtitle: "S", sound: "Glass" }))
      .toBe('display notification "M" with title "T" subtitle "S" sound name "Glass"');
  });

  test("omits subtitle and sound when absent", () => {
    expect(buildNotifyScript({ title: "T", message: "M" }))
      .toBe('display notification "M" with title "T"');
  });

  test("escapes quotes and backslashes (no AppleScript injection via message)", () => {
    const s = buildNotifyScript({ title: 'a"b', message: "c\\d" });
    expect(s).toContain('title "a\\"b"');
    expect(s).toContain('notification "c\\\\d"');
  });
});
