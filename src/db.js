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

// Create tables from db/schema.sql (idempotent — uses IF NOT EXISTS).
export async function initSchema() {
  const schema = fs.readFileSync(path.join(ROOT, "db", "schema.sql"), "utf8");
  await db.executeMultiple(schema);
}
