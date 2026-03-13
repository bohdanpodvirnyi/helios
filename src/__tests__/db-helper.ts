/**
 * Test helper: creates an in-memory SQLite database with all migrations applied.
 * Use with vi.mock() to replace the real database singleton.
 */
import Database from "better-sqlite3";
import { runMigrations } from "../store/migrations.js";

/** Create a fresh in-memory database with all migrations applied. */
export function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}
