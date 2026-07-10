import { db } from "./db.js";

// ---------------------------------------------------------------------------
// OFFLINE REGISTRY BUNDLE (M6 Part B). A compact snapshot of the registry the
// client caches in IndexedDB so verification works with zero signal.
//
// `checked_at` is when the SERVER last verified these records — i.e. bundle
// generation time here (a real deployment would track per-record update times).
// The client applies the ASYMMETRIC caching rules against it: safety expires
// (VERIFIED goes stale, then to caution), danger does not (BANNED/SUSPENDED are
// permanent + sticky). See public/js/verdict.js and SAFETY.md.
// ---------------------------------------------------------------------------

function safeParse(json, fallback) {
  if (json == null) return fallback;
  try { return JSON.parse(json); } catch { return fallback; }
}

export async function getRegistryBundle() {
  const checkedAt = new Date().toISOString();

  const pRes = await db.execute(
    `SELECT id, registration_no, product_name, active_ingredient, status, expiry_date,
            hazard_class, ppe_required, first_aid, approved_crops, reviewed
     FROM pesticides`
  );
  const dRes = await db.execute(
    "SELECT pesticide_id, crop, dose_per_unit, application_notes, pre_harvest_interval_days FROM dosages"
  );
  const dosagesByPid = {};
  for (const d of dRes.rows) {
    (dosagesByPid[d.pesticide_id] ||= []).push({
      crop: d.crop,
      dose_per_unit: d.dose_per_unit,
      application_notes: d.application_notes,
      pre_harvest_interval_days: d.pre_harvest_interval_days,
    });
  }

  const products = pRes.rows.map((r) => ({
    registration_no: r.registration_no,
    product_name: r.product_name,
    active_ingredient: r.active_ingredient,
    status: r.status, // registered | banned | suspended
    expiry_date: r.expiry_date,
    hazard_class: r.hazard_class,
    ppe_required: safeParse(r.ppe_required, []),
    first_aid: safeParse(r.first_aid, {}),
    approved_crops: safeParse(r.approved_crops, []),
    dosages: dosagesByPid[r.id] || [],
    reviewed: Number(r.reviewed) === 1,
    checked_at: checkedAt,
  }));

  return {
    version: 1,
    generated_at: checkedAt,
    checked_at: checkedAt,
    count: products.length,
    products,
  };
}
