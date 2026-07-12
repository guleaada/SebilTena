import { db as defaultDb } from "./db.js";
import { t } from "./localize.js";
import { ROUTES, stepsForRoute } from "./aidCodes.js";

// ---------------------------------------------------------------------------
// TOXICOLOGIST SIGN-OFF (M10) — the workflow that performs the SAFETY.md release
// gate. It makes the sign-off AUDITABLE: every approve/revoke is appended to
// `review_log` (append-only, never updated or deleted), each requires a named
// reviewer + credential, and revocation is first-class (new toxicology info must
// be able to un-clear a product, loudly). This tool does NOT lower the bar for
// who may sign off — it only records that they did. See SAFETY.md.
//
// "Cleared" is STRICTER than the old `reviewed=1`: a product is cleared only when
// it is reviewed AND carries the reviewer's name AND a server timestamp. The
// production boot-gate counts NOT-cleared products.
// ---------------------------------------------------------------------------

export const CLEARED_SQL = "reviewed = 1 AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL";

function safeParse(json, fallback) {
  if (json == null) return fallback;
  try { return JSON.parse(json); } catch { return fallback; }
}
const nonEmpty = (v) => typeof v === "string" && v.trim().length > 0;

// Derive a product's review state for the filter tabs from its row + last action.
function statusOf(row) {
  if (Number(row.reviewed) === 1 && row.reviewed_by && row.reviewed_at) return "approved";
  if (row.last_action === "revoked") return "revoked";
  return "unreviewed";
}

/** List products for a filter tab: 'unreviewed' | 'approved' | 'revoked' | 'all'. */
export async function listProducts(filter = "unreviewed", deps = {}) {
  const dbc = deps.db ?? defaultDb;
  const res = await dbc.execute(
    `SELECT p.id, p.product_name, p.active_ingredient, p.hazard_class, p.registration_no,
            p.reviewed, p.reviewed_by, p.reviewer_credential, p.reviewed_at,
            (SELECT action FROM review_log WHERE pesticide_id = p.id AND action IN ('approved','revoked')
             ORDER BY id DESC LIMIT 1) AS last_action
     FROM pesticides p ORDER BY p.product_name`
  );
  const rows = res.rows.map((r) => ({
    id: r.id,
    product_name: r.product_name,
    active_ingredient: r.active_ingredient,
    hazard_class: r.hazard_class,
    registration_no: r.registration_no,
    status: statusOf(r),
    reviewed_by: r.reviewed_by || null,
    reviewed_at: r.reviewed_at || null,
  }));
  return filter === "all" ? rows : rows.filter((r) => r.status === filter);
}

/**
 * Full review detail for one product — EXACTLY what the farmer would receive, so
 * the reviewer approves the real thing: resolved first-aid step texts per route
 * (product codes or the universal fallback, matching the emergency flow), PPE,
 * hazard class, dosages per crop, plus the current review state + the full log.
 */
export async function productDetail(id, deps = {}) {
  const dbc = deps.db ?? defaultDb;
  const pid = Number(id);
  const pRes = await dbc.execute({ sql: "SELECT * FROM pesticides WHERE id = ?", args: [pid] });
  if (!pRes.rows.length) return null;
  const p = pRes.rows[0];
  const firstAid = safeParse(p.first_aid, {});

  // Resolve each route's step codes to English canonical text (the toxicology
  // review is of the English source; localized strings are reviewed separately).
  const routes = ROUTES.map((route) => {
    const { codes, source } = stepsForRoute(firstAid, route);
    return { route, source, steps: codes.map((c) => ({ code: c, text: t("en", `aid.${c}`) })) };
  });

  const dRes = await dbc.execute({
    sql: "SELECT crop, dose_per_unit, application_notes, pre_harvest_interval_days FROM dosages WHERE pesticide_id = ? ORDER BY crop",
    args: [pid],
  });
  const logRes = await dbc.execute({
    sql: "SELECT action, reviewer, credential, notes, created_at FROM review_log WHERE pesticide_id = ? ORDER BY id DESC",
    args: [pid],
  });

  return {
    id: p.id,
    product_name: p.product_name,
    active_ingredient: p.active_ingredient,
    registration_no: p.registration_no,
    hazard_class: p.hazard_class,
    ppe_required: safeParse(p.ppe_required, []),
    approved_crops: safeParse(p.approved_crops, []),
    routes,
    dosages: dRes.rows.map((d) => ({
      crop: d.crop, dose_per_unit: d.dose_per_unit,
      application_notes: d.application_notes, pre_harvest_interval_days: d.pre_harvest_interval_days,
    })),
    status: statusOf({ reviewed: p.reviewed, reviewed_by: p.reviewed_by, reviewed_at: p.reviewed_at, last_action: logRes.rows[0]?.action }),
    reviewed_by: p.reviewed_by || null,
    reviewer_credential: p.reviewer_credential || null,
    reviewed_at: p.reviewed_at || null,
    review_notes: p.review_notes || null,
    log: logRes.rows,
  };
}

/** Approve a product: requires a named reviewer + credential (both mandatory). */
export async function approve({ pesticideId, reviewer, credential, notes }, deps = {}) {
  const dbc = deps.db ?? defaultDb;
  const pid = Number(pesticideId);
  if (!Number.isFinite(pid)) return { ok: false, error: "invalid_product" };
  if (!nonEmpty(reviewer) || !nonEmpty(credential)) return { ok: false, error: "reviewer_and_credential_required" };
  const exists = await dbc.execute({ sql: "SELECT id FROM pesticides WHERE id = ?", args: [pid] });
  if (!exists.rows.length) return { ok: false, error: "not_found" };

  await dbc.execute({
    sql: `UPDATE pesticides SET reviewed = 1, reviewed_by = ?, reviewer_credential = ?,
            reviewed_at = datetime('now'), review_notes = ? WHERE id = ?`,
    args: [reviewer.trim(), credential.trim(), nonEmpty(notes) ? notes.trim() : null, pid],
  });
  await appendLog(dbc, pid, "approved", reviewer, credential, nonEmpty(notes) ? notes.trim() : null);
  return { ok: true, status: "approved" };
}

/** Revoke a previously-approved product. Requires a reason (mandatory). Loud:
 *  clears the approval fields (so it is no longer "cleared") + appends to the log. */
export async function revoke({ pesticideId, reviewer, credential, reason }, deps = {}) {
  const dbc = deps.db ?? defaultDb;
  const pid = Number(pesticideId);
  if (!Number.isFinite(pid)) return { ok: false, error: "invalid_product" };
  if (!nonEmpty(reviewer) || !nonEmpty(credential)) return { ok: false, error: "reviewer_and_credential_required" };
  if (!nonEmpty(reason)) return { ok: false, error: "reason_required" };
  const exists = await dbc.execute({ sql: "SELECT id FROM pesticides WHERE id = ?", args: [pid] });
  if (!exists.rows.length) return { ok: false, error: "not_found" };

  // Never silently un-review: clear the approval + record who/why in the log.
  await dbc.execute({
    sql: `UPDATE pesticides SET reviewed = 0, reviewed_by = NULL, reviewer_credential = NULL,
            reviewed_at = NULL, review_notes = NULL WHERE id = ?`,
    args: [pid],
  });
  await appendLog(dbc, pid, "revoked", reviewer, credential, reason.trim());
  return { ok: true, status: "revoked" };
}

// The ONLY writer of review_log. INSERT only — never UPDATE, never DELETE.
async function appendLog(dbc, pid, action, reviewer, credential, notes) {
  await dbc.execute({
    sql: "INSERT INTO review_log (pesticide_id, action, reviewer, credential, notes) VALUES (?,?,?,?,?)",
    args: [pid, action, String(reviewer).trim(), nonEmpty(credential) ? credential.trim() : null, notes],
  });
}

/** Progress for the gate/header: how many products are cleared, out of the total. */
export async function reviewSummary(deps = {}) {
  const dbc = deps.db ?? defaultDb;
  const total = Number((await dbc.execute("SELECT COUNT(*) AS n FROM pesticides")).rows[0].n);
  const cleared = Number((await dbc.execute(`SELECT COUNT(*) AS n FROM pesticides WHERE ${CLEARED_SQL}`)).rows[0].n);
  return { total, cleared, remaining: total - cleared, text: `${cleared} of ${total} products reviewed` };
}

/** Append-only review-log CSV — the audit artifact for a regulator / grant. */
export async function reviewLogCsv(deps = {}) {
  const dbc = deps.db ?? defaultDb;
  const res = await dbc.execute(
    `SELECT l.id, l.pesticide_id, p.product_name, l.action, l.reviewer, l.credential, l.notes, l.created_at
     FROM review_log l LEFT JOIN pesticides p ON p.id = l.pesticide_id ORDER BY l.id`
  );
  const cell = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    "# MedaGuard first-aid review log — append-only audit trail (who signed off what, when).",
    ["log_id", "pesticide_id", "product_name", "action", "reviewer", "credential", "notes", "created_at"].join(","),
  ];
  for (const r of res.rows) {
    lines.push([r.id, r.pesticide_id, cell(r.product_name), r.action, cell(r.reviewer), cell(r.credential), cell(r.notes), r.created_at].join(","));
  }
  return lines.join("\n") + "\n";
}
