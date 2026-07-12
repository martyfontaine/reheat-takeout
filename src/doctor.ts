/**
 * Dependency + environment checks (ISC-6, ISC-54, ISC-56).
 *
 * Reports PASS/FAIL per required binary and probes Apple Photos automation so a
 * missing-permission first run surfaces an actionable message instead of failing
 * silently later.
 */
import { configExists, configPath, loadConfig } from "./config";
import { heuristicICloudEnabled } from "./icloud";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function whichCheck(name: string, bin: string): Check {
  const path = Bun.which(bin);
  return { name, ok: path !== null, detail: path ?? "NOT FOUND on PATH" };
}

/**
 * exiftool parses untrusted media (it has had parser CVEs, e.g. CVE-2021-22204),
 * so report its version and nudge the user to keep it current.
 */
async function exiftoolCheck(): Promise<Check> {
  const path = Bun.which("exiftool");
  if (!path) return { name: "exiftool", ok: false, detail: "NOT FOUND — install with `brew install exiftool`" };
  try {
    const proc = Bun.spawn([path, "-ver"], { stdout: "pipe", stderr: "pipe" });
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const ver = out.trim();
    return { name: "exiftool", ok: true, detail: `${path} (v${ver}) — keep updated; it parses untrusted media` };
  } catch {
    return { name: "exiftool", ok: true, detail: path };
  }
}

/**
 * Probe whether we can control Apple Photos. This may briefly launch Photos and
 * may trigger the first-run TCC Automation prompt — which is the intended cue.
 */
async function automationCheck(): Promise<Check> {
  try {
    const proc = Bun.spawn(
      ["osascript", "-e", 'tell application "Photos" to return name'],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (code === 0) return { name: "Apple Photos automation", ok: true, detail: "authorized" };
    if (/-1743|not authoriz/i.test(err)) {
      return {
        name: "Apple Photos automation",
        ok: false,
        detail:
          "not authorized — System Settings ▸ Privacy & Security ▸ Automation ▸ allow your terminal to control Photos",
      };
    }
    return { name: "Apple Photos automation", ok: false, detail: err.trim() || `osascript exit ${code}` };
  } catch (e) {
    return { name: "Apple Photos automation", ok: false, detail: String(e) };
  }
}

/**
 * Best-effort iCloud Photos detection (ISC-54). Uses the passive filesystem
 * heuristic (cloud-sync artifacts in the system library). Definitive state is
 * available via the user-invoked `photobridge icloud status` (UI automation).
 */
async function iCloudCheck(): Promise<Check> {
  const ic = heuristicICloudEnabled();
  const detail =
    ic.state === "likely-on"
      ? `appears ENABLED (${ic.detail}) — imports will upload to iCloud and count against its storage (see README; definitive: 'photobridge icloud status')`
      : ic.state === "likely-off"
        ? `appears OFF (${ic.detail}) — definitive: 'photobridge icloud status'`
        : `${ic.detail} — if iCloud Photos is ON, imports upload to iCloud (definitive: 'photobridge icloud status')`;
  return { name: "iCloud Photos", ok: true, detail }; // informational — never fails the run
}

async function configCheck(): Promise<Check> {
  if (!configExists()) {
    return { name: "config", ok: false, detail: `not found — run 'photobridge init' (${configPath()})` };
  }
  const cfg = await loadConfig();
  return { name: "config", ok: true, detail: `inbox=${cfg?.inboxDir}` };
}

export async function runDoctor(): Promise<Check[]> {
  const checks: Check[] = [
    await exiftoolCheck(),
    whichCheck("ditto", "ditto"),
    whichCheck("unzip", "unzip"),
    whichCheck("tar", "tar"),
    whichCheck("osascript", "osascript"),
  ];
  checks.push(await automationCheck());
  checks.push(await iCloudCheck());
  checks.push(await configCheck());
  return checks;
}
