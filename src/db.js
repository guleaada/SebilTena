import { createClient } from "@libsql/client";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

// Turso in production; local SQLite file for dev when no TURSO_DATABASE_URL.
const useTurso = Boolean(process.env.TURSO_DATABASE_URL);

export const dbMode = useTurso ? "turso" : "local-sqlite";

export const db = createClient(
  useTurso
    ? {
        url: process.env.TURSO_DATABASE_URL,
        authToken: process.env.TURSO_AUTH_TOKEN,
      }
    : { url: `file:${path.join(ROOT, "medaguard.db")}` }
);

// Create tables from db/schema.sql (idempotent — uses IF NOT EXISTS), then run
// additive column migrations for existing databases (CREATE TABLE IF NOT EXISTS
// won't add new columns to a table that already exists).
export async function initSchema() {
  const schema = fs.readFileSync(path.join(ROOT, "db", "schema.sql"), "utf8");
  await db.executeMultiple(schema);
  await migrate();
}

const MIGRATIONS = [
  "ALTER TABLE scans ADD COLUMN resolved_status TEXT",
  "ALTER TABLE scans ADD COLUMN resolved_at TEXT",
];

async function migrate() {
  for (const sql of MIGRATIONS) {
    try {
      await db.execute(sql);
    } catch (err) {
      // Ignore "duplicate column" — the migration has already been applied.
      if (!/duplicate column/i.test(String(err?.message || err))) throw err;
    }
  }
}
