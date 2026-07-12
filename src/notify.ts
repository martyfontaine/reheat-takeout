/**
 * The "your takeout is reheated" moment — a macOS notification banner + chime.
 *
 * Uses osascript `display notification`, which shows a banner and plays a named
 * system sound in a single call — no extra dependency. The AppleScript string is
 * built by a pure function so it can be unit-tested without popping a real banner.
 */

import { existsSync } from "fs";
import { assetPath } from "./resources";

export interface NotifyOptions {
  title: string;
  message: string;
  subtitle?: string;
  /** Name of a system sound (e.g. "Glass", "Hero"). Omit for silent. */
  sound?: string;
}

/** Escape a string for embedding inside an AppleScript "..." literal. */
function escAS(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Build the `display notification` AppleScript. Pure — safe to unit-test. */
export function buildNotifyScript(opts: NotifyOptions): string {
  let script = `display notification "${escAS(opts.message)}" with title "${escAS(opts.title)}"`;
  if (opts.subtitle) script += ` subtitle "${escAS(opts.subtitle)}"`;
  if (opts.sound) script += ` sound name "${escAS(opts.sound)}"`;
  return script;
}

/** Fire a notification. Never throws — a failed banner must not fail a reheat. */
export async function notify(opts: NotifyOptions): Promise<void> {
  try {
    const proc = Bun.spawn(["osascript", "-e", buildNotifyScript(opts)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
  } catch {
    /* notifications are best-effort */
  }
}

/** Path to the bundled "reheat complete" chime (dev repo asset or .app Resources). */
export function chimePath(): string {
  return assetPath("chime.mp3");
}

/** Play the completion chime via afplay. Awaited so the daemon doesn't cut it short. */
export async function playChime(path: string = chimePath()): Promise<void> {
  if (!existsSync(path)) return;
  try {
    const proc = Bun.spawn(["afplay", path], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
  } catch {
    /* best-effort */
  }
}

/** The signature ping: your takeout is reheated — banner + the custom chime, together. */
export async function notifyReheated(count: number): Promise<void> {
  await Promise.all([
    notify({
      title: "Your takeout has been reheated 🥡",
      subtitle: count === 1 ? "1 item moved over" : `${count} items moved over`,
      message: "Album transfer complete — geoData and photoTakenTime intact. Have a nice day :)",
    }),
    playChime(),
  ]);
}
