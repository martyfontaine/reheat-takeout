import { test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const SRC = join(import.meta.dir, "..", "src");

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walkTs(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * ISC-58 (Anti): Reheat makes no outbound network connection. We audit the
 * source for network-call PRIMITIVES — not bare URL strings (the plist DOCTYPE
 * URL is a harmless standard string, never fetched).
 */
test("no outbound network primitives in src (ISC-58)", () => {
  const banned: Array<[RegExp, string]> = [
    [/\bfetch\s*\(/, "fetch()"],
    [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
    [/\bWebSocket\b/, "WebSocket"],
    [/\bEventSource\b/, "EventSource"],
    [/\bBun\.(connect|listen)\b/, "Bun.connect/listen"],
    [/from\s+['"]node:(https?|net|tls|dgram|dns)['"]/, "node net module import"],
    [/require\(\s*['"](https?|net|tls|dgram|dns)['"]\s*\)/, "node net module require"],
  ];

  const offenders: string[] = [];
  for (const file of walkTs(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const [re, label] of banned) {
      if (re.test(text)) offenders.push(`${file}: ${label}`);
    }
  }
  expect(offenders).toEqual([]);
});
