// M7 Part B — access-gate integration test. Black-box: spawns the REAL server
// with an ADMIN_TOKEN, then proves every /api/surveillance/* endpoint 401s
// without a valid token, 200s with one, never leaks row-level coordinates, and
// audits every access to `events`.
//
//   node scripts/test-surveillance-gate.js
//
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { db, initSchema } from "../src/db.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3199;
const TOKEN = "test-gate-token";
const BASE = `http://localhost:${PORT}`;

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? "  -> " + detail : ""}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealthy(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch {}
    await sleep(150);
  }
  return false;
}
const status = async (path, headers = {}) => (await fetch(`${BASE}${path}`, { headers })).status;

async function main() {
  // Seed a few geotagged flagged scans (distinct raw points in ONE grid cell).
  await initSchema();
  await db.execute("DELETE FROM scans");
  const created = new Date().toISOString().replace("T", " ").slice(0, 19);
  for (const [lat, lon] of [[8.987, 38.761], [8.912, 38.799], [8.955, 38.702]]) {
    await db.execute({
      sql: `INSERT INTO scans (result_status, lat, lon, channel, created_at) VALUES ('UNREGISTERED',?,?, 'app', ?)`,
      args: [lat, lon, created],
    });
  }

  const child = spawn("node", ["src/server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), ADMIN_TOKEN: TOKEN, MG_TEST: "1" },
    stdio: "ignore",
  });

  try {
    if (!(await waitHealthy())) { console.error("server did not start"); process.exit(1); }

    console.log("No / wrong token -> 401 (EVERY surveillance data route, M7.5 A)");
    // Enumerate every surveillance data route; a NEW route added later without
    // the gate must make this test fail.
    const SURVEILLANCE_ROUTES = [
      "/api/surveillance/districts",
      "/api/surveillance/summary",
      "/api/surveillance/export",
      "/api/surveillance/districts?from=2020-01-01&to=2030-01-01",
    ];
    for (const r of SURVEILLANCE_ROUTES) {
      check(`no token -> 401: ${r}`, (await status(r)) === 401);
    }
    check("wrong token -> 401", (await status("/api/surveillance/districts", { "x-admin-token": "nope" })) === 401);
    check("empty ?token= -> 401", (await status("/api/surveillance/districts?token=")) === 401);

    console.log("\nno env/flag exposes surveillance publicly (a 401 is a 401 regardless of query)");
    check("?public=1 does not bypass the gate", (await status("/api/surveillance/districts?public=1")) === 401);
    check("?debug=1 does not bypass the gate", (await status("/api/surveillance/summary?debug=1")) === 401);

    console.log("\nValid token (three carriers) -> 200");
    check("Authorization: Bearer -> 200", (await status("/api/surveillance/summary", { authorization: `Bearer ${TOKEN}` })) === 200);
    check("x-admin-token header -> 200", (await status("/api/surveillance/districts", { "x-admin-token": TOKEN })) === 200);
    check("?token= query -> 200", (await status(`/api/surveillance/districts?token=${TOKEN}`)) === 200);

    console.log("\nGated payload carries NO row-level coordinates");
    const body = await (await fetch(`${BASE}/api/surveillance/districts`, { headers: { "x-admin-token": TOKEN } })).json();
    const raw = JSON.stringify(body);
    check("raw input coord 8.987 absent", !raw.includes("8.987"));
    check("raw input coord 38.799 absent", !raw.includes("38.799"));
    check("3 raw points collapsed into one grid cell (n=3)", body.districts.length === 1 && body.districts[0].resolvedScans === 3, JSON.stringify(body.districts.map((d) => d.resolvedScans)));
    check("cell is a labelled centroid", body.districts[0].granularity === "grid_approx" && body.districts[0].lat === 8.95 && body.districts[0].lon === 38.75);

    console.log("\nDistrict payloads are typed as LEADS, never location verdicts (M7.5 A)");
    const LEAD_TYPES = new Set(["review_recommended", "insufficient_data"]);
    check("every district status is a lead type (review_recommended | insufficient_data)", body.districts.every((d) => LEAD_TYPES.has(d.status)), JSON.stringify(body.districts.map((d) => d.status)));
    check("no district has a 'counterfeitRate' field", body.districts.every((d) => !("counterfeitRate" in d)));
    check("no district field asserts a confirmed finding", body.districts.every((d) => !("confirmed" in d) && !("isCounterfeit" in d) && !("verdict" in d)));

    console.log("\nrobots noindex + no-store on the gated surface (M7.5 A)");
    const hdrs = (await fetch(`${BASE}/api/surveillance/districts`, { headers: { "x-admin-token": TOKEN } })).headers;
    check("X-Robots-Tag noindex present", /noindex/i.test(hdrs.get("x-robots-tag") || ""), hdrs.get("x-robots-tag"));
    check("Cache-Control no-store present", /no-store/i.test(hdrs.get("cache-control") || ""), hdrs.get("cache-control"));
    // 401 responses carry the headers too (denied requests must not be cached).
    const deniedHdrs = (await fetch(`${BASE}/api/surveillance/districts`)).headers;
    check("401 response also no-store", /no-store/i.test(deniedHdrs.get("cache-control") || ""));

    console.log("\n/admin/map is a DATALESS login shell (no embedded surveillance data)");
    const mapRes = await fetch(`${BASE}/admin/map`);
    const mapHtml = await mapRes.text();
    check("/admin/map serves the login shell (200)", mapRes.ok);
    check("/admin/map carries noindex", /noindex/i.test(mapRes.headers.get("x-robots-tag") || ""));
    check("/admin/map embeds no district data", !mapHtml.includes("Poison District") && !mapHtml.includes("8.95") && !/review_recommended[\"']?\s*:/.test(mapHtml));

    console.log("\nEvery access is audited to events");
    const ev = (await db.execute("SELECT type FROM events WHERE type LIKE 'surveillance%'")).rows.map((r) => r.type);
    check("a successful access is logged", ev.includes("surveillance_access"));
    check("a denied access is logged", ev.includes("surveillance_denied"));
  } finally {
    child.kill("SIGTERM");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("crash:", e); process.exit(1); });
