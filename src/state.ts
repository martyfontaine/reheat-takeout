/**
 * State store — sqlite dedup + idempotency (ISC-36..41).
 *
 * Dedup key is the SHA-256 of the ORIGINAL file bytes, which collapses Takeout's
 * album duplication and re-exports to a single import (ISC-37, ISC-39). The
 * `imported` row is written only AFTER the sink confirms the asset landed, so a
 * crash mid-import never leaves the DB claiming an item that Apple Photos didn't
 * receive (ISC-41 — enforced by call ordering in pipeline.ts).
 */
import { Database } from "bun:sqlite";
import { mkdir } from "fs/promises";
import { dirname } from "path";

export class StateStore {
  private db: Database;

  private constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.run(`CREATE TABLE IF NOT EXISTS imported (
      hash        TEXT PRIMARY KEY,
      orig_name   TEXT NOT NULL,
      taken_at    INTEGER,
      imported_at TEXT NOT NULL,
      apple_uuid  TEXT
    );`);
    this.db.run(`CREATE TABLE IF NOT EXISTS unmatched (
      path    TEXT PRIMARY KEY,
      reason  TEXT,
      seen_at TEXT NOT NULL
    );`);
  }

  static async open(dbPath: string): Promise<StateStore> {
    await mkdir(dirname(dbPath), { recursive: true });
    return new StateStore(dbPath);
  }

  /** True if a file with this original-byte hash was already imported. */
  has(hash: string): boolean {
    return this.db.query("SELECT 1 FROM imported WHERE hash = ?").get(hash) !== null;
  }

  /** Record a confirmed import. Idempotent on hash (ISC-36). */
  recordImported(hash: string, origName: string, takenAt: number | null, appleUuid: string | null): void {
    this.db.run(
      "INSERT OR IGNORE INTO imported (hash, orig_name, taken_at, imported_at, apple_uuid) VALUES (?, ?, ?, ?, ?)",
      [hash, origName, takenAt, new Date().toISOString(), appleUuid],
    );
  }

  recordUnmatched(path: string, reason: string): void {
    this.db.run(
      "INSERT OR REPLACE INTO unmatched (path, reason, seen_at) VALUES (?, ?, ?)",
      [path, reason, new Date().toISOString()],
    );
  }

  importedCount(): number {
    const r = this.db.query("SELECT COUNT(*) AS n FROM imported").get() as { n: number };
    return r.n;
  }

  unmatchedCount(): number {
    const r = this.db.query("SELECT COUNT(*) AS n FROM unmatched").get() as { n: number };
    return r.n;
  }

  close(): void {
    this.db.close();
  }
}
