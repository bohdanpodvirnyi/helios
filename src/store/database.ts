import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { runMigrations } from "./migrations.js";
import { HELIOS_DIR } from "../paths.js";

const DB_PATH = join(HELIOS_DIR, "helios.db");

/** Shared prepared-statement cache. Stores use composition to avoid re-preparing. */
export class StmtCache {
  private cache = new Map<string, Database.Statement>();
  stmt(sql: string): Database.Statement {
    let s = this.cache.get(sql);
    if (!s) {
      s = getDb().prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }
}

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    mkdirSync(HELIOS_DIR, { recursive: true });
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.pragma("busy_timeout = 5000");
    _db.pragma("foreign_keys = ON");
    runMigrations(_db);
  }
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

let _dirCreated = false;
export function getHeliosDir(): string {
  if (!_dirCreated) {
    mkdirSync(HELIOS_DIR, { recursive: true });
    _dirCreated = true;
  }
  return HELIOS_DIR;
}
