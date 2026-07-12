// M10 — toxicologist sign-off workflow tests. Approve/revoke behaviour, the
// stricter "cleared" definition, append-only log immutability, mandatory
// reviewer+credential (approve) / reason (revoke), and that the detail view
// resolves the exact first-aid steps the farmer would receive. Deterministic,
// real seeded DB, no network.
//
//   node scripts/test-review.js
//
import { db, initSchema } from "../src/db.js";
import { approve, revoke, listProducts, productDetail, reviewSummary, reviewLogCsv, CLEARED_SQL } from "../src/review.js";

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? "  -> " + detail : ""}`); }
}
const clearedCount = async () => Number((await db.execute(`SELECT COUNT(*) n FROM pesticides WHERE ${CLEARED_SQL}`)).rows[0].n);
const prow = async (id) => (await db.execute({ sql: "SELECT * FROM pesticides WHERE id=?", args: [id] })).rows[0];
const logCount = async (id) => Number((await db.execute({ sql: "SELECT COUNT(*) n FROM review_log WHERE pesticide_id=?", args: [id] })).rows[0].n);

async function main() {
  await initSchema();
  await db.execute("DELETE FROM review_log");
  // Start from a known unreviewed baseline (seed data is all reviewed:false).
  await db.execute("UPDATE pesticides SET reviewed=0, reviewed_by=NULL, reviewer_credential=NULL, reviewed_at=NULL, review_notes=NULL");

  const first = (await db.execute("SELECT id, active_ingredient FROM pesticides ORDER BY id LIMIT 1")).rows[0];
  const PID = Number(first.id);

  console.log("Baseline: nothing cleared");
  const total = Number((await db.execute("SELECT COUNT(*) n FROM pesticides")).rows[0].n);
  check("no products cleared at start", (await clearedCount()) === 0, String(await clearedCount()));

  console.log("\nDetail view resolves the EXACT first-aid steps the farmer receives");
  const det = await productDetail(PID);
  const swallowed = det.routes.find((r) => r.route === "swallowed");
  check("detail has all four routes", det.routes.length === 4);
  check("steps are resolved text, not codes", swallowed.steps.length > 0 && /[a-z]/i.test(swallowed.steps[0].text) && !swallowed.steps[0].text.startsWith("aid_"), JSON.stringify(swallowed.steps[0]));
  check("swallowed first step is 'do not vomit' guidance", /do not|vomit/i.test(swallowed.steps.map((s) => s.text).join(" ")), JSON.stringify(swallowed.steps.map((s) => s.text)));
  check("detail includes dosages + ppe + hazard", Array.isArray(det.dosages) && Array.isArray(det.ppe_required) && "hazard_class" in det);

  console.log("\nApprove requires a named reviewer + credential");
  check("approve with no reviewer -> rejected", (await approve({ pesticideId: PID, reviewer: "", credential: "MD" })).error === "reviewer_and_credential_required");
  check("approve with no credential -> rejected", (await approve({ pesticideId: PID, reviewer: "Dr X", credential: "  " })).error === "reviewer_and_credential_required");
  check("still not cleared after rejected approvals", (await clearedCount()) === 0);

  const ok = await approve({ pesticideId: PID, reviewer: "Dr. Mastewal Alehegn", credential: "Clinical toxicologist, MD", notes: "Standard OP first-aid confirmed." });
  check("valid approve succeeds", ok.ok === true && ok.status === "approved");
  const row = await prow(PID);
  check("product now cleared (reviewed + reviewed_by + reviewed_at)", Number(row.reviewed) === 1 && !!row.reviewed_by && !!row.reviewed_at);
  check("reviewer name + credential stored", row.reviewed_by === "Dr. Mastewal Alehegn" && row.reviewer_credential === "Clinical toxicologist, MD");
  check("cleared count is now 1", (await clearedCount()) === 1);
  check("approval appended to the log", (await logCount(PID)) === 1);
  const approvedInList = (await listProducts("approved")).some((p) => p.id === PID);
  check("appears under the Approved filter", approvedInList);

  console.log("\n'Cleared' is stricter than reviewed=1 (defensive)");
  await db.execute({ sql: "UPDATE pesticides SET reviewed_by=NULL WHERE id=?", args: [PID] });
  check("reviewed=1 but no reviewer -> NOT cleared", (await clearedCount()) === 0);
  await approve({ pesticideId: PID, reviewer: "Dr. Mastewal Alehegn", credential: "Clinical toxicologist, MD" }); // restore
  check("re-approve restores cleared", (await clearedCount()) === 1);

  console.log("\nRevoke is loud: requires a reason, clears the approval, logs it");
  check("revoke with no reason -> rejected", (await revoke({ pesticideId: PID, reviewer: "Dr. Mastewal", credential: "MD", reason: "" })).error === "reason_required");
  check("product still cleared after a rejected revoke", (await clearedCount()) === 1);
  const rv = await revoke({ pesticideId: PID, reviewer: "Dr. Mastewal Alehegn", credential: "Clinical toxicologist, MD", reason: "New WHO guidance on this ingredient." });
  check("valid revoke succeeds", rv.ok === true && rv.status === "revoked");
  const after = await prow(PID);
  check("revoke un-clears the product (reviewed=0, fields cleared)", Number(after.reviewed) === 0 && after.reviewed_by == null && after.reviewed_at == null);
  check("cleared count back to 0", (await clearedCount()) === 0);
  // Append-only: approve + re-approve (restore, above) + revoke = 3 rows, none overwritten.
  check("revoke appended to the log (3 rows now: approve, re-approve, revoke)", (await logCount(PID)) === 3);
  const revokedInList = (await listProducts("revoked")).some((p) => p.id === PID);
  check("appears under the Revoked filter (not Unreviewed)", revokedInList && !(await listProducts("unreviewed")).some((p) => p.id === PID));

  console.log("\nThe review_log is APPEND-ONLY (never updated or deleted)");
  // The module exposes no update/revoke-of-log path; assert the source has no
  // UPDATE/DELETE against review_log, and that history is preserved verbatim.
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../src/review.js", import.meta.url), "utf8");
  check("review.js contains no UPDATE review_log", !/UPDATE\s+review_log/i.test(src));
  check("review.js contains no DELETE FROM review_log", !/DELETE\s+FROM\s+review_log/i.test(src));
  const firstEntry = (await db.execute({ sql: "SELECT action, reviewer, notes FROM review_log WHERE pesticide_id=? ORDER BY id ASC LIMIT 1", args: [PID] })).rows[0];
  check("the original approval entry is preserved verbatim after revoke", firstEntry.action === "approved" && firstEntry.reviewer === "Dr. Mastewal Alehegn");

  console.log("\nSummary + audit CSV");
  const sum = await reviewSummary();
  check("summary reports N of M", sum.total === total && sum.cleared === 0 && /0 of \d+ products reviewed/.test(sum.text), JSON.stringify(sum));
  const csv = await reviewLogCsv();
  check("CSV has the audit header + both actions for the product", /log_id,pesticide_id,product_name,action,reviewer/.test(csv) && /approved/.test(csv) && /revoked/.test(csv));
  check("CSV records the reviewer credential", /Clinical toxicologist/.test(csv));

  // Leave the DB clean (all 20 unreviewed) so downstream suites + the demo see
  // the same baseline — otherwise this product would linger as 'revoked'.
  await db.execute("DELETE FROM review_log");
  await db.execute("UPDATE pesticides SET reviewed=0, reviewed_by=NULL, reviewer_credential=NULL, reviewed_at=NULL, review_notes=NULL");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("crash:", e); process.exit(1); });
