/**
 * iCloud Photos control (ISC-59..64).
 *
 * Apple exposes NO API for the iCloud Photos setting — no defaults key, no
 * AppleScript command, and (verified on macOS 26) the Settings toggle is a
 * SwiftUI control that is NOT handed to another process's accessibility tree, so
 * it cannot be clicked programmatically in a way that survives macOS versions.
 *
 * Robust, honest design:
 *  - `status`   → a passive filesystem heuristic (version-independent, no perms).
 *  - `on`/`off` → open the exact Photos ▸ Settings ▸ iCloud pane FOR the user and
 *    guide the single click. Reheat never flips the setting itself — which
 *    also keeps the consequential "download originals?" decision with the human.
 *  - The daemon/run path NEVER launches UI automation (ISC-64 Anti); it only uses
 *    the passive heuristic to warn.
 */
import { homedir } from "os";
import { join } from "path";
import { existsSync, statSync } from "fs";

// ---------- Passive heuristic (safe for daemon / doctor / run / status) ----------

export type HeuristicState = "likely-on" | "likely-off" | "unknown";

export interface HeuristicResult {
  state: HeuristicState;
  detail: string;
}

/**
 * Infer iCloud Photos state from cloud-sync artifacts inside the system library.
 * `cloudsync.noindex` is created and kept fresh by cloudphotod while iCloud
 * Photos is enabled. Pure filesystem reads — no UI, no processes, no permissions.
 */
export function heuristicICloudEnabled(libraryPath?: string): HeuristicResult {
  const lib = libraryPath ?? join(homedir(), "Pictures", "Photos Library.photoslibrary");
  if (!existsSync(lib)) return { state: "unknown", detail: "system Photos library not at default path" };
  const cpl = join(lib, "resources", "cpl", "cloudsync.noindex");
  if (!existsSync(cpl)) return { state: "likely-off", detail: "no cloud-sync artifacts in library" };
  const ageDays = (Date.now() - statSync(cpl).mtimeMs) / 86_400_000;
  if (ageDays <= 7) {
    return {
      state: "likely-on",
      detail: `cloud-sync artifacts active ${ageDays < 1 ? "today" : Math.round(ageDays) + "d ago"}`,
    };
  }
  return { state: "unknown", detail: `cloud-sync artifacts stale (${Math.round(ageDays)}d old)` };
}

// ---------- Assisted pane open (user-invoked `icloud on|off` only) ----------

const OPEN_SCRIPT = `on run argv
  tell application "Photos" to activate
  delay 0.6
  tell application "System Events"
    tell application process "Photos"
      set frontmost to true
      keystroke "," using command down
      repeat 30 times
        repeat with w in windows
          if (exists toolbar 1 of w) then
            try
              if (name of w) is "iCloud" then return "OPENED"
            end try
          end if
        end repeat
        delay 0.1
      end repeat
      -- settings opened but not on the iCloud pane; still useful to the user
      if (count of windows) > 0 then return "OPENED_OTHER"
    end tell
  end tell
  return "NOWIN"
end run`;

async function openICloudPane(): Promise<{ opened: boolean; reason: string }> {
  const proc = Bun.spawn(["osascript", "-e", OPEN_SCRIPT], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    const err = stderr.trim();
    if (/assistive access|not allowed|-25211|1002/i.test(err)) return { opened: false, reason: "accessibility" };
    if (/-1743|not authoriz/i.test(err)) return { opened: false, reason: "automation" };
    return { opened: false, reason: err || `osascript exit ${code}` };
  }
  const out = stdout.trim();
  return { opened: out === "OPENED" || out === "OPENED_OTHER", reason: out };
}

export type ICloudAction = "status" | "on" | "off";

export interface ICloudResult {
  ok: boolean;
  action: ICloudAction;
  heuristic: HeuristicState;
  /** on/off: whether the Settings pane was opened for the user. */
  paneOpened: boolean;
  /** on/off: Reheat never flips the setting; the user makes the final click. */
  manualRequired: boolean;
  message: string;
}

const TOGGLE_LABEL = '"Sync this Mac"'; // macOS 26 label for iCloud Photos

export async function runICloudAction(action: ICloudAction): Promise<ICloudResult> {
  const h = heuristicICloudEnabled();
  const stateWord = h.state === "likely-on" ? "appears ON" : h.state === "likely-off" ? "appears OFF" : "is undetermined";

  if (action === "status") {
    return {
      ok: true,
      action,
      heuristic: h.state,
      paneOpened: false,
      manualRequired: false,
      message:
        `iCloud Photos ${stateWord} (${h.detail}).` +
        (h.state === "unknown" ? " Open Photos ▸ Settings ▸ iCloud to confirm." : ""),
    };
  }

  // on / off — open the pane and guide the one click.
  const { opened, reason } = await openICloudPane();
  const cur = h.state === "likely-on" ? "on" : h.state === "likely-off" ? "off" : "unknown";
  const WANT = action.toUpperCase();

  let msg = "";
  if (cur === action) msg += `iCloud Photos ${stateWord} already — no change needed if the pane agrees. `;
  if (opened) {
    msg += `Opened Photos ▸ Settings ▸ iCloud. Flip ${TOGGLE_LABEL} to ${WANT}.`;
  } else if (reason === "accessibility") {
    msg +=
      "Couldn't auto-open the pane — grant Accessibility to your terminal " +
      "(System Settings ▸ Privacy & Security ▸ Accessibility), or just open " +
      `Photos ▸ Settings ▸ iCloud yourself and flip ${TOGGLE_LABEL} to ${WANT}.`;
  } else if (reason === "automation") {
    msg +=
      "Couldn't auto-open the pane — allow your terminal to control System Events " +
      `(Privacy & Security ▸ Automation), or open Photos ▸ Settings ▸ iCloud and flip ${TOGGLE_LABEL} to ${WANT}.`;
  } else {
    msg += `Open Photos ▸ Settings ▸ iCloud and flip ${TOGGLE_LABEL} to ${WANT}.`;
  }
  if (action === "off") {
    msg +=
      "\nHeads-up: turning it OFF may prompt to download originals — on Optimize-Storage " +
      "setups that can mean pulling your entire cloud library onto this Mac. That choice is yours.";
  }
  msg +=
    "\n(Apple exposes no stable programmatic handle for this toggle on modern macOS, " +
    "so Reheat opens the pane and leaves the one click to you.)";

  return { ok: true, action, heuristic: h.state, paneOpened: opened, manualRequired: true, message: msg };
}
