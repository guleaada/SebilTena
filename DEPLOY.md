# DEPLOY.md — Sebil Tena staging deploy runbook (Milestone 8)

> The product is **Sebil Tena** (formerly MedaGuard). The Fly app is still named
> `medaguard-staging` (Fly apps can't be renamed in place; the custom domain
> `sebiltena.com` masks it) — keep every `medaguard-staging` reference below.

> **This is a STAGING demonstration deploy, not a farmer-facing launch.** It
> exists to show a real, secure, working system to EIAR, Dr. Mastewal, GIZ and
> grant committees. It is safe *by construction*: with unreviewed first-aid data
> it **refuses to start** as a cleared production build, and runs only via the
> explicit, banner-showing `STAGING=true` demonstration path. See
> [SAFETY.md](SAFETY.md). A pilot requires the real-world inputs listed at the
> bottom of this file.

Target: **Fly.io** (app) + **Turso / libSQL** (database).

---

## 0. One-time prerequisites

- `flyctl` installed and authenticated (`fly auth login`).
- A Turso database + auth token (`turso db create medaguard`, `turso db show`,
  `turso db tokens create`).
- The app created once: `fly apps create medaguard-staging` (or `fly launch
  --no-deploy` and accept the bundled `fly.toml`).

---

## 1. Secrets (never committed — set via `fly secrets set`)

The production **preflight fails closed** if a required secret is missing or weak
(`src/preflight.js`). Set all of these before the first deploy:

```bash
fly secrets set \
  DEVICE_TOKEN_SECRET="$(openssl rand -hex 32)" \
  ADMIN_TOKEN="$(openssl rand -hex 24)" \
  TURSO_DATABASE_URL="libsql://<your-db>.turso.io" \
  TURSO_AUTH_TOKEN="<turso-token>" \
  AT_WEBHOOK_SECRET="$(openssl rand -hex 24)"      # optional; enables SMS webhook auth
# SMS sending (optional — leave unset to disable SMS cleanly):
fly secrets set AT_API_KEY="<...>" AT_USERNAME="<...>" AT_SHORTCODE="<...>"
# Poison-control number shown in the emergency flow (set the REAL line before a pilot):
fly secrets set POISON_CENTRE_NUMBER="<real national poison line>"
```

| Secret | Required? | If unset / weak (hardened build) |
|--------|-----------|----------------------------------|
| `DEVICE_TOKEN_SECRET` | **Yes** | **Refuses to start** (write tokens must survive restarts / span machines) |
| `ADMIN_TOKEN` | Optional | Surveillance stays **locked** (all `/api/surveillance/*` → 401). If set, must be strong (≥16 chars, not a dev value) or it refuses to start |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | Yes for a real deploy | Warns + uses a local SQLite file (fine only for local verification) |
| `AT_API_KEY` / `AT_USERNAME` | Optional | SMS **disabled cleanly**; the webhook still rejects unauthenticated posts |
| `AT_WEBHOOK_SECRET` | Optional | If set, must be strong; guards the SMS webhook |
| `POISON_CENTRE_NUMBER` | Set before pilot | Emergency flow shows the placeholder until set |

`STAGING=true` and `PORT=8080` are set in `fly.toml` (not secret). `NODE_ENV=production`
is baked into the image.

---

## 2. Prepare the database (idempotent, non-destructive)

`migrate` only ensures the schema (`CREATE TABLE IF NOT EXISTS` + additive
`ALTER`s). It never drops or wipes anything, and it does **not** auto-seed.

```bash
# Runs against Turso because TURSO_DATABASE_URL is set in the environment:
TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... npm run migrate
```

Seed the registry **explicitly** (separate step, so a deploy can never overwrite a
hand-loaded production registry). For the demo this loads the 20 illustrative
sample products; for a pilot, drop the real MoA CSV at
`data/registered_pesticides.csv` first:

```bash
TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... npm run seed
```

> The sample registry + first-aid are **illustrative placeholders** and every row
> is `reviewed:false`. That is intentional — it keeps the boot-gate engaged.

---

## 3. Deploy

```bash
fly deploy
```

The image builds Node 20, installs production deps only, vendors the Tesseract
core + English traineddata into `public/vendor/tesseract` at **build time** (no
runtime third-party fetch), runs as the non-root `node` user, and health-checks
`/api/health`.

Expected boot log (demonstration path):

```
[preflight] DEMONSTRATION build (STAGING=true): unreviewed first-aid present — NOT CLEARED FOR FIELD USE. Serving with the demonstration banner.
[preflight] OK — required secrets present.
Sebil Tena listening on http://localhost:8080  (db: turso)
```

If you see `[preflight] FATAL ... refusing to start`, a required secret is
missing/weak or you attempted a cleared production build (no `STAGING`) with
unreviewed data — fix and redeploy. **Do not** set `reviewed:true` to force a
boot.

---

## 4. Verify (see Part E in the milestone; quick pass)

```bash
APP=https://medaguard-staging.fly.dev
curl -s $APP/api/health                       # {"ok":true,...}
curl -s -o /dev/null -w "%{http_code}\n" $APP/api/surveillance/districts   # 401 (locked without ADMIN_TOKEN header)
curl -s $APP/robots.txt                        # Disallow: /
curl -sI $APP/ | grep -i x-robots-tag          # noindex, nofollow
```

Open the app: the **non-dismissible demonstration banner** must be visible.

---

## 5. Roll back

Fly keeps prior releases:

```bash
fly releases                 # list
fly deploy --image <prior-release-image>   # or:
fly releases rollback <version>
```

Database rollback: `migrate` is additive-only, so a rollback of the app needs no
DB downgrade. Never hand-run destructive SQL against Turso; take a Turso snapshot
before any manual change.

---

## 6. Verifying the boot-gate locally (no Fly access needed)

```bash
# Cleared production build with unreviewed data -> MUST refuse:
NODE_ENV=production DEVICE_TOKEN_SECRET=$(openssl rand -hex 32) ADMIN_TOKEN=$(openssl rand -hex 24) node src/server.js
#   -> [preflight] FATAL: ... UNREVIEWED first-aid ... refusing to start ; exit 1

# Demonstration build -> starts, with the banner + a logged non-cleared notice:
STAGING=true NODE_ENV=production DEVICE_TOKEN_SECRET=$(openssl rand -hex 32) ADMIN_TOKEN=$(openssl rand -hex 24) PORT=3000 node src/server.js
#   -> serves, banner visible, "DEMONSTRATION ... NOT CLEARED FOR FIELD USE" logged

# Missing/weak secret in a hardened build -> MUST refuse:
STAGING=true node src/server.js     # (no DEVICE_TOKEN_SECRET) -> [preflight] FATAL ; exit 1
```

---

## Remaining real-world inputs before a pilot (NOT satisfied by this deploy)

This staging system is complete in software but **must not serve real farmers**
until all of the following land — the boot-gate enforces the first one:

1. **Toxicologist / poison-control sign-off** of every first-aid `route → aid_*`
   mapping and the `UNIVERSAL_STEPS` fallback, recorded in the SAFETY.md table,
   with the signed rows set `reviewed:true`. *Until then the app refuses to run as
   a cleared production build.*
2. **The real MoA Plant Health Regulatory Directorate registry** (~1,011 products)
   replacing the 20 illustrative samples, via `data/registered_pesticides.csv`.
3. **Real Ethiopian label photographs** to tune the OCR + fuzzy-match threshold
   (`MATCH_FUZZY_THRESHOLD`, currently an untuned 0.82) — nothing has been tested
   against a real photo.
4. **Native-speaker recordings** for the five languages (am, om, ti, so, aa) and
   agronomist-reviewed translations of the reviewed strings; today only English
   placeholder clips exist and ti/so/aa are English-fallback stubs.
5. The **real national poison-control number** (`POISON_CENTRE_NUMBER`).
6. A controlled **pilot** with extension agents, not an open launch.
