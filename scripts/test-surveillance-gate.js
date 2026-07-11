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

    console.log("No / wrong token -> 401");
    check("districts, no token -> 401", (await status("/api/surveillance/districts")) === 401);
    check("summary, no token -> 401", (await status("/api/surveillance/summary")) === 401);
    check("wrong token -> 401", (await status("/api/surveillance/districts", { "x-admin-token": "nope" })) === 401);

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
