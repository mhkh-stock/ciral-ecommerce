# Ciral — Deploy

## Runtime

- **Node.js 24+** (`node:sqlite` is used directly; Node < 24 will not run it).
- **Zero dependencies** — no `npm install`, no build step.
- **Start command:** `node server.js` (also `npm start`).
- **Port:** listens on `$PORT` when set, otherwise **3020**.

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `PORT` | No | `3020` | The server binds `127.0.0.1:$PORT`. Public hosts set this themselves (Render, SnapDeploy). |
| `DB_FILE` | No | `data/ciral.sqlite` under the app dir | Full path to the SQLite file. **Set this on any host whose app directory is read-only** — e.g. `DB_FILE=/tmp/ciral.sqlite`. The server creates the parent directory if needed. |
| `NODE_ENV` | No | — | No behaviour depends on it today. |

There is **no `ADMIN_CODE`** and no other secret env var. Auth is
DB-backed accounts, not shared codes:

- Admin account `mhkh3200@gmail.com` (M. Hashir) is seeded on first run;
  change its password from the admin panel (Change Password) after the
  first sign-in. Manager/customer seed accounts are created with random
  passwords on first run; the admin creates/rotates accounts under Users.
- **Never put a password in a file, an env var, a screenshot or chat.**
  Seeded passwords live only as PBKDF2 hashes inside the SQLite file.

## Writable-directory needs

The app writes exactly one thing to disk: the SQLite database
(`data/ciral.sqlite` by default, plus its `-wal`/`-shm` sidecars). The
`public/` directory is read-only at runtime.

- **Local / normal host:** the app dir is writable; the default path is used.
- **Read-only app dir (e.g. SnapDeploy containers):** the server detects
  the unwritable app dir at boot and falls back to a temp directory
  (`/tmp/ciral/ciral.sqlite`, logged as
  `Ciral data directory (read-only app dir fallback): …`). Set `DB_FILE`
  explicitly if the host offers a persistent writable path — **data in
  `/tmp` does not survive a container restart/redeploy**, so the store
  would come back empty (products/orders re-seeded, accounts re-created).

## Deploy settings

### Render (`render.yaml`, in repo)

```yaml
services:
  - type: web
    name: ciral-ecommerce
    env: node
    buildCommand: ""
    startCommand: node server.js
    envVars:
      - key: NODE_VERSION
        value: "24"
```

Render sets `$PORT` automatically. Note: Render's free filesystem is
ephemeral too — set `DB_FILE` to a persistent disk path if you add one,
otherwise the store resets on each deploy.

### SnapDeploy (free tier)

- Push to `main` on `mhkh-stock/ciral-ecommerce`; the container
  auto-deploys on push (no redeploy button; Restart only re-runs the old
  image). Free tier: 5 deploys per 12-hour window.
- The app dir is read-only there, so either set
  `DB_FILE=/tmp/ciral.sqlite` (ephemeral — resets on redeploy) or attach
  a persistent writable path and point `DB_FILE` at it.
- `PORT` is provided by the platform; do not hard-code 3020.

## Verify after deploy

```bash
curl https://<host>/api/health
# {"ok":true,"products":16,"orders":10,...}
```

Then open `/` (storefront), `/customer`, `/manager`, `/admin` and sign in
with the admin account. First run seeds 16 products, 10 orders and the
Deals of the Day (which auto-renew every 24 h).

## Tests (before every deploy)

```bash
node test.js   # fresh-DB end-to-end suite, dummy accounts only
```

Must be fully green before pushing. See `README.md` → Tests.
