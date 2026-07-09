// M4.5 test — first-aid is a CONTROLLED VOCABULARY of aid_* step codes, never
// prose, never generated. Asserts the migration guard + retrieval behaviour.
// Deterministic, no network. Requires a freshly seeded DB.
//
//   node scripts/test-firstaid.js
//
import { db, initSchema } from "../src/db.js";
import { getFirstAid, getEmergencyBundle } from "../src/firstaid.js";
import { AID_CODE_SET, ROUTES, ROUTE_SET } from "../src/aidCodes.js";

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? "  -> " + detail : ""}`); }
}

async function dbFirstAid(activeIngredient) {
  const r = await db.execute({
    sql: "SELECT first_aid FROM pesticides WHERE active_ingredient = ? COLLATE NOCASE LIMIT 1",
    args: [activeIngredient],
  });
  return r.rows.length ? JSON.parse(r.rows[0].first_aid) : null;
}

async function main() {
  await initSchema();

  const ing = "Mancozeb 800 g/kg";
  const dbFa = await dbFirstAid(ing);
  check("seed present", !!dbFa, "Mancozeb first_aid missing — run: npm run seed");

  // ---- MIGRATION GUARD ----------------------------------------------------
  // No first_aid value in the DB is free text; every value is JSON of
  // route -> [code], routes valid, codes in-vocabulary, no code is a sentence.
  const all = await db.execute("SELECT product_name, first_aid FROM pesticides");
  let prose = 0, badRoute = 0, badCode = 0;
  for (const row of all.rows) {
    let fa;
    try { fa = JSON.parse(row.first_aid); } catch { prose++; continue; }
    if (typeof fa !== "object" || Array.isArray(fa)) { prose++; continue; }
    for (const [route, codes] of Object.entries(fa)) {
      if (!ROUTE_SET.has(route)) badRoute++;
      if (!Array.isArray(codes)) { prose++; continue; }
      for (const c of codes) {
        if (typeof c !== "string" || !AID_CODE_SET.has(c)) badCode++;
        if (/\s/.test(String(c))) prose++; // a code with whitespace = prose leak
      }
    }
  }
  check("guard: no free-text first_aid in DB", prose === 0, `prose-ish=${prose}`);
  check("guard: all routes valid", badRoute === 0, `badRoute=${badRoute}`);
  check("guard: all codes in vocabulary", badCode === 0, `badCode=${badCode}`);
  check("guard: products present", all.rows.length > 0);

  // ---- getFirstAid returns CODES, matches DB, no prose --------------------
  for (const route of ROUTES) {
    const fa = await getFirstAid(ing, route, "en");
    check(`first-aid ${route} steps == DB codes`, JSON.stringify(fa.steps) === JSON.stringify(dbFa[route]),
      `${JSON.stringify(fa.steps)} vs ${JSON.stringify(dbFa[route])}`);
    check(`first-aid ${route} all in vocab`, fa.steps.every((c) => AID_CODE_SET.has(c)));
    check(`first-aid ${route} provenance controlled`, fa.provenance === "db_controlled_vocab");
    check(`first-aid ${route} carries no prose field`, !("text" in fa));
    check(`first-aid ${route} source=product`, fa.source === "product");
  }

  // ---- Missing product/route -> universal fallback, never blank -----------
  const unknown = await getFirstAid("Totally Made Up 999 g/L", "swallowed", "en");
  check("unknown ingredient -> found=false", unknown.found === false);
  check("unknown ingredient -> universal fallback (not blank)",
    unknown.source === "universal" && unknown.steps.length > 0);
  check("unknown ingredient -> steps in vocabulary", unknown.steps.every((c) => AID_CODE_SET.has(c)));

  // ---- Bad route -> no guess ---------------------------------------------
  const badR = await getFirstAid(ing, "telepathy", "en");
  check("bad route -> invalid_route", badR.error === "invalid_route");
  check("bad route -> no steps", !badR.steps);

  // ---- Emergency bundle: codes only, reviewed flag -----------------------
  const bundle = await getEmergencyBundle("en");
  check("bundle provenance controlled", bundle.provenance === "db_controlled_vocab");
  const rec = bundle.first_aid[ing];
  check("bundle product routes are codes", rec && rec.routes.swallowed.every((c) => AID_CODE_SET.has(c)));
  // No prose anywhere in bundle.first_aid
  let bundleProse = 0;
  for (const r of Object.values(bundle.first_aid))
    for (const codes of Object.values(r.routes || {}))
      for (const c of codes) if (/\s/.test(String(c)) || !AID_CODE_SET.has(c)) bundleProse++;
  check("bundle carries no prose", bundleProse === 0, `leaks=${bundleProse}`);
  check("bundle universal is codes", ROUTES.every((r) => (bundle.universal[r] || []).every((c) => AID_CODE_SET.has(c))));
  check("bundle reviewed=false (sample data)", bundle.reviewed === false);
  check("bundle has agents", Array.isArray(bundle.agents) && bundle.agents.length > 0);
  check("bundle has poison centre", !!bundle.poison_centre);

  // ---- Release gate: unreviewed products exist ---------------------------
  const rev = await db.execute("SELECT COUNT(*) AS n FROM pesticides WHERE reviewed = 0");
  check("release gate: unreviewed products present", Number(rev.rows[0].n) > 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("crash:", e); process.exit(1); });
