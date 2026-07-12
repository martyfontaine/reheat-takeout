/**
 * Config load/save. No hardcoded paths (Constraint): everything derives from
 * $HOME / XDG env vars and the resolved config dir.
 */
import { homedir } from "os";
import { join } from "path";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";

export interface Config {
  /** Watched folder where Takeout archives land. */
  inboxDir: string;
  /** Extraction + staging work dir. */
  workDir: string;
  /** sqlite state store path. */
  dbPath: string;
  /** Structured log file path. */
  logPath: string;
  /** IANA timezone used to render EXIF wall-clock from Google's UTC epoch (ISC-30). */
  displayTimeZone: string;
  /** Warn before a real import when iCloud Photos looks enabled (imports upload to iCloud). */
  warnIfICloudOn: boolean;
}

export function configHome(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "photobridge");
}

export function configPath(): string {
  return join(configHome(), "config.json");
}

export function dataHome(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
  return join(base, "photobridge");
}

/** Best-effort host timezone; falls back to UTC. */
export function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function defaultConfig(): Config {
  const data = dataHome();
  return {
    inboxDir: join(homedir(), "PhotoBridge", "Inbox"),
    workDir: join(data, "work"),
    dbPath: join(data, "state.sqlite"),
    logPath: join(data, "photobridge.log"),
    displayTimeZone: hostTimeZone(),
    warnIfICloudOn: true,
  };
}

export function configExists(): boolean {
  return existsSync(configPath());
}

export async function loadConfig(): Promise<Config | null> {
  const p = configPath();
  if (!existsSync(p)) return null;
  const parsed = JSON.parse(await Bun.file(p).text()) as Partial<Config>;
  // Merge over defaults so older config files gain new fields safely.
  return { ...defaultConfig(), ...parsed };
}

export async function saveConfig(cfg: Config): Promise<void> {
  await mkdir(configHome(), { recursive: true });
  await Bun.write(configPath(), JSON.stringify(cfg, null, 2) + "\n");
}
