/**
 * Structured JSONL logging. Every run appends to a single file surfaced by
 * `photobridge logs` (ISC-52).
 */
import { appendFile, mkdir } from "fs/promises";
import { dirname } from "path";

export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  info(event: string, data?: Record<string, unknown>): Promise<void>;
  warn(event: string, data?: Record<string, unknown>): Promise<void>;
  error(event: string, data?: Record<string, unknown>): Promise<void>;
  path: string;
}

export function createLogger(logPath: string, alsoConsole = true): Logger {
  let ready: Promise<unknown> | null = null;
  const ensureDir = () => (ready ??= mkdir(dirname(logPath), { recursive: true }));

  const write = async (level: LogLevel, event: string, data?: Record<string, unknown>) => {
    await ensureDir();
    const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...(data ?? {}) });
    await appendFile(logPath, line + "\n");
    if (alsoConsole) {
      const suffix = data ? " " + JSON.stringify(data) : "";
      const msg = `[${level}] ${event}${suffix}`;
      if (level === "error") console.error(msg);
      else console.log(msg);
    }
  };

  return {
    path: logPath,
    info: (e, d) => write("info", e, d),
    warn: (e, d) => write("warn", e, d),
    error: (e, d) => write("error", e, d),
  };
}
