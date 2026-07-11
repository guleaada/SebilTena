// Idempotent, NON-DESTRUCTIVE production migrate. Safe to run against Turso
// repeatedly and in any order relative to seeding. It ONLY ensures the schema
// (CREATE TABLE IF NOT EXISTS + the additive ALTER migrations in src/db.js) —
// it never DROPs, never DELETEs, never wipes the ground-truth or audit tables.
//
// Seeding the registry is a SEPARATE, explicit step (`npm run seed`) — this
// script deliberately does not auto-seed, so a deploy can never silently
// overwrite a hand-loaded production registry. See DEPLOY.md.
//
//   node scripts/migrate.js
//
import { db, dbMode, initSchema } from "../src/db.js";

async function main() {
  console.log(`[migrate] db: ${dbMode}`);
  await initSchema(); // idempotent: IF NOT EXISTS + additive ALTERs (duplicate-column errors ignored)

  const pesticides = Number((await db.execute("SELECT COUNT(*) c FROM pesticides")).rows[0].c);
  const unreviewed = Number((await db.execute("SELECT COUNT(*) c FROM pesticides WHERE reviewed = 0")).rows[0].c);
  console.log(`[migrate] schema ensured. pesticides: ${pesticides} (unreviewed: ${unreviewed}).`);

  if (pesticides === 0) {
    console.log("[migrate] registry is EMPTY. Load it explicitly with `npm run seed` (or the real MoA CSV). Not auto-seeding.");
  }
  if (unreviewed > 0) {
    console.log("[migrate] NOTE: unreviewed first-aid present — a NODE_ENV=production launch WITHOUT STAGING=true will refuse to start (SAFETY.md boot-gate).");
  }
  process.exit(0);
}

main().catch((e) => { console.error("[migrate] FAILED:", e?.message || e); process.exit(1); });
