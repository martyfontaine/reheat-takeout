/**
 * launchd LaunchAgent management (ISC-48..53).
 *
 * Uses WatchPaths (event-driven wake on the inbox folder) rather than a resident
 * watcher process — nothing to keep alive or crash-loop (ISC-53). The agent runs
 * `run` via an absolute program path (the Bun binary + script in dev, or the
 * compiled standalone binary inside the .app) so it never depends on launchd's PATH.
 */
import { homedir, userInfo } from "os";
import { dirname, join } from "path";
import { existsSync } from "fs";
import { mkdir, writeFile, rm } from "fs/promises";
import type { Config } from "./config";

function sanitize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "user";
}

export function agentLabel(): string {
  const user = process.env.USER || userInfo().username || "user";
  return `com.${sanitize(user)}.reheat`;
}

export function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", agentLabel() + ".plist");
}

/** Absolute path to bin/reheat.ts (this module lives in src/). */
export function scriptPath(): string {
  return join(import.meta.dir, "..", "bin", "reheat.ts");
}

/**
 * True when running as a `bun build --compile` standalone binary. Such binaries
 * run their embedded modules from a virtual filesystem rooted at `/$bunfs/`
 * (`B:\~BUN\` on Windows); the real `bin/*.ts` entry script is not a launchable
 * path on disk. We detect either signal so launchd can be told to exec correctly.
 */
function isCompiledBinary(): boolean {
  const dir = import.meta.dir;
  if (dir.includes("/$bunfs/") || dir.includes("~BUN") || dir.startsWith("B:")) return true;
  return !existsSync(scriptPath());
}

/**
 * The ProgramArguments launchd should exec (ISC-49). In dev we run the TypeScript
 * entry under Bun: `bun <bin/reheat.ts> run`. A compiled binary, however, gets
 * a synthetic `/$bunfs/...` script path injected as argv[1]; passing that through
 * would make the CLI read it as the subcommand and every drop would fail, so we
 * exec the binary itself with just `run`.
 */
export function programArguments(): string[] {
  return isCompiledBinary()
    ? [process.execPath, "run"]
    : [process.execPath, scriptPath(), "run"];
}

function guiDomain(): string {
  return `gui/${userInfo().uid}`;
}

/** Escape XML metacharacters so config paths can't break out of a <string> element. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function generatePlist(cfg: Config): string {
  const label = xmlEscape(agentLabel());
  const args = programArguments().map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");
  const inbox = xmlEscape(cfg.inboxDir);
  const logPath = xmlEscape(cfg.logPath);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WatchPaths</key>
  <array><string>${inbox}</string></array>
  <key>RunAtLoad</key><false/>
  <key>ProcessType</key><string>Background</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key><string>${logPath}</string>
  <key>StandardErrorPath</key><string>${logPath}</string>
</dict>
</plist>
`;
}

interface SpawnResult {
  code: number;
  out: string;
  err: string;
}

async function launchctl(args: string[]): Promise<SpawnResult> {
  const proc = Bun.spawn(["launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

export async function install(cfg: Config): Promise<{ plist: string; label: string }> {
  const p = plistPath();
  await mkdir(dirname(p), { recursive: true });
  await mkdir(cfg.inboxDir, { recursive: true }); // WatchPaths target must exist
  await writeFile(p, generatePlist(cfg));

  const domain = guiDomain();
  await launchctl(["bootout", `${domain}/${agentLabel()}`]); // ignore failure if not loaded
  const res = await launchctl(["bootstrap", domain, p]);
  if (res.code !== 0) {
    throw new Error(`launchctl bootstrap failed (${res.code}): ${res.err.trim() || res.out.trim()}`);
  }
  return { plist: p, label: agentLabel() };
}

export async function uninstall(): Promise<{ removed: boolean }> {
  await launchctl(["bootout", `${guiDomain()}/${agentLabel()}`]); // ISC-51
  const p = plistPath();
  const existed = existsSync(p);
  if (existed) await rm(p, { force: true });
  return { removed: existed };
}

export async function status(): Promise<{ loaded: boolean; detail: string }> {
  const res = await launchctl(["print", `${guiDomain()}/${agentLabel()}`]);
  return {
    loaded: res.code === 0,
    detail: res.code === 0 ? res.out.split("\n").slice(0, 12).join("\n") : "agent not loaded",
  };
}
