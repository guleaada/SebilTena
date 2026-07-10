import { db as defaultDb } from "./db.js";

// Interaction telemetry -> `events` table. Deliberately separate from `scans`,
// which is the safety-audit + surveillance source (M7). Telemetry must never
// inflate scan counts or per-region counterfeit rates. See DECISIONS.md.
export async function logEvent({ type, channel, payload, region }, dbClient = defaultDb) {
  try {
    await dbClient.execute({
      sql: "INSERT INTO events (type, channel, payload, region) VALUES (?,?,?,?)",
      args: [type, channel ?? null, payload ? JSON.stringify(payload) : null, region ?? null],
    });
  } catch (err) {
    // Telemetry must never break a farmer-facing response.
    console.error("event log failed:", err?.message || err);
  }
}
