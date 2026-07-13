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

/**
 * The only server Reheat runs is Gene's helper — the loopback bridge that lets his
 * "Recycle" button uninstall in one click. It must stay bound to 127.0.0.1 so it is
 * never reachable off-box; this keeps the privacy promise honest for inbound code
 * too, not just outbound (ISC-58).
 */
test("any Bun.serve in src is loopback-bound (Recycle helper)", () => {
  const offenders: string[] = [];
  for (const file of walkTs(SRC)) {
    const text = readFileSync(file, "utf8");
    if (!/\bBun\.serve\b/.test(text)) continue;
    if (!/hostname:\s*["']127\.0\.0\.1["']/.test(text)) offenders.push(`${file}: Bun.serve without a 127.0.0.1 hostname`);
    if (/["']0\.0\.0\.0["']/.test(text)) offenders.push(`${file}: binds 0.0.0.0 (off-box exposure)`);
  }
  expect(offenders).toEqual([]);
});
