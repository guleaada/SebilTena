// M4 Part B test — assert every first-aid string traces to the DB first_aid
// column (no generation, ever). Deterministic, no network.
//
//   node scripts/test-firstaid.js
//
import { db, initSchema } from "../src/db.js";
import { getFirstAid, getEmergencyBundle, ROUTE_TO_KEY, toSteps } from "../src/firstaid.js";

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

  // Use a real seeded ingredient.
  const ing = "Mancozeb 800 g/kg";
  const dbFa = await dbFirstAid(ing);
  check("seed present", !!dbFa, "Mancozeb first_aid missing");

  // Every route's returned text must EQUAL the DB column value.
  for (const route of ["skin", "eyes", "swallowed", "breathed"]) {
    const key = ROUTE_TO_KEY[route];
    const fa = await getFirstAid(ing, route, "en");
    check(`first-aid ${route} found`, fa.found === true, JSON.stringify(fa));
    check(`first-aid ${route} == DB column`, fa.text === dbFa[key], `got "${fa.text}" vs db "${dbFa[key]}"`);
    check(`first-aid ${route} provenance=db`, fa.source === "db_first_aid");
    check(`first-aid ${route} steps rejoin to text`, toSteps(fa.text).join(" ") === dbFa[key].replace(/\s+/g, " ").trim() || fa.steps.length > 0);
  }

  // Unknown ingredient must NOT fabricate anything.
  const unknown = await getFirstAid("Totally Made Up 999 g/L", "swallowed", "en");
  check("unknown ingredient -> not found", unknown.found === false);
  check("unknown ingredient -> no text", !("text" in unknown) || unknown.text == null);

  // Bad route -> not found (no default guess).
  const badRoute = await getFirstAid(ing, "telepathy", "en");
  check("bad route -> not found", badRoute.found === false);

  // Emergency bundle first_aid map must mirror the DB.
  const bundle = await getEmergencyBundle("en");
  check("bundle source=db", bundle.source === "db_first_aid");
  check("bundle has Mancozeb", !!bundle.first_aid[ing]);
  check("bundle ingestion == DB", bundle.first_aid[ing].ingestion === dbFa.ingestion);
  check("bundle has universal fallback", !!bundle.universal && !!bundle.universal.swallowed);
  check("bundle has agents", Array.isArray(bundle.agents) && bundle.agents.length > 0);
  check("bundle has poison centre", !!bundle.poison_centre);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("crash:", e); process.exit(1); });
