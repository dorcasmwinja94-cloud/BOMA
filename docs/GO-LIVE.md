# Boma go-live runbook (Vercel + Supabase)

This is the deployment contract for Boma. Follow it in order. Commands that
change data are called out explicitly; nothing here seeds or resets a populated
database.

## 1. Architecture

Boma is deployed as **one Vercel project** from this repository:

| Project | Root directory | Purpose | URL |
| --- | --- | --- | --- |
| `boma-reservations` | repository root | CRA static site **and** the Express API under `/api/*` | `https://boma-reservations.vercel.app` |

Why one project: the SPA and the API ship and deploy together, every
browser request (including the M-Pesa callback path) is same-origin so no
CORS is needed for guests, and rollbacks revert both halves atomically.
`vercel.json` builds the client (`npm --prefix client run build`), serves
`client/build` from the CDN with a catch-all rewrite to `index.html`, and
routes `/api/*` to the serverless function in `api/index.ts` (Express, from
`server/app.ts`, same code as the long-running server minus Socket.IO and the
in-process schedulers).

The long-running local server (`server/index.ts`) still exists for development
and single-host deployments. It keeps Socket.IO and in-process schedulers.
Scheduled work on Vercel moves to `/api/cron/*`.

## 2. External prerequisites

- A Supabase PostgreSQL project (the existing database is fine).
- A Vercel account. Hobby is acceptable for the function duration (300s), but
  check Vercel's non-commercial terms if this is a business deployment.
- A stable HTTPS origin for the API. The callback must survive deploys and
  restarts, so temporary tunnels are not acceptable for production.
- Daraja credentials. Sandbox can be deployed now; **production M-Pesa stays
  blocked until Safaricom completes Go Live** for the business shortcode.
- Optional but recommended before launch: SMTP provider and Africa's Talking
  credentials. Without them, email/SMS is logged, not delivered.

## 3. Database

### 3.1 Connection string

Use Supabase's **transaction pooler** for the Vercel API project:

```
postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1&sslmode=require
```

- Do **not** include `sslrootcert=C:/...` on Vercel. That file only exists on the
  local machine; the function cannot read it.
- The transaction pooler maps many short-lived functions onto a small number of
  database connections. `connection_limit=1` prevents one function from holding
  a pool that other functions need.
- If the transaction pooler misbehaves, the session pooler on port `5432` also
  works with `connection_limit=1`, but it consumes a connection per warm
  function. Watch the Supabase connection graph.
- Migrations and `psql`/`pg_dump` should use the session pooler or a direct
  connection, not the transaction pooler.

### 3.2 Schema migrations

The repository now contains a baseline migration:

```
prisma/migrations/20261118000000_init/migration.sql
```

**Existing populated database** (the current Supabase project) — the baseline
has already been marked as applied and the live schema has no drift. If you ever
recreate the database metadata, mark it without running the SQL:

```bash
npx prisma migrate resolve --applied 20261118000000_init
```

**Fresh/empty database:**

```bash
npx prisma migrate deploy
```

Rules:

- Never run `prisma db push` against production.
- Never run `npm run db:seed` against a populated database. The seed script
  clears data and is intended for an empty development database only.
- `npm run db:migrate` (`prisma migrate dev`) is for development. It needs a
  shadow database and must not be pointed at production.
- If `prisma migrate status` reports `P1001`/`P2028`, the Supabase pooler is
  flapping. Retry before concluding the schema is broken.

### 3.3 Backups

Enable Supabase scheduled backups before real guest data accumulates and test a
restore once. A migration is forward-only; the rollback plan for a bad schema
change is a verified database backup plus a previous Vercel deployment.

### 3.4 Repository ↔ Supabase GitHub integration

This repository uses **Prisma migrations**, not Supabase CLI migrations or the
Supabase GitHub integration. The only runtime link between the repo and Supabase
is the `DATABASE_URL` environment variable. There is no `supabase/config.toml`
and no `supabase/migrations` directory, and CI only validates the Prisma schema
(it never connects to the hosted database).

If you connect the repository under Supabase Dashboard → Project Settings →
Integrations → GitHub for branching/preview databases, do **not** let a second
migration system apply the schema. Keep Prisma as the single source of truth, or
migrate the project fully to Supabase CLI migrations first. Connecting the GitHub
integration is optional and is not required for Vercel deployments.

To confirm the deployed app is using the intended project, compare the project
reference in `DATABASE_URL` (the `postgres.<ref>` username) with the reference in
`SUPABASE_URL` / `REACT_APP_SUPABASE_URL` (`https://<ref>.supabase.co`).

## 4. Deploy the project

1. Vercel → **Add New → Project** → import the repository.
2. **Root Directory:** repository root. Framework preset: **Other**.
3. The build command, output directory, function settings and rewrites all
   come from `vercel.json` (client build → `client/build`, `/api/*` →
   `api/index.ts`). Do not override them.
4. Add the environment variables below for **Production** (and Preview if you
   use preview deployments).

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Supabase transaction pooler URL above |
| `JWT_SECRET` | yes | 32+ random chars; generate with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `CLIENT_URL` | yes | `https://boma-reservations.vercel.app`; comma-separated values allowed for previews |
| `CRON_SECRET` | yes | 16+ random chars; protects `/api/cron/*` |
| `REACT_APP_API_BASE` | yes | `/` — bakes same-origin API URLs into the client build (set on production **and** preview) |
| `MPESA_CONSUMER_KEY` | for payments | all five M-Pesa values or none |
| `MPESA_CONSUMER_SECRET` | for payments | |
| `MPESA_SHORTCODE` | for payments | `174379` in sandbox |
| `MPESA_PASSKEY` | for payments | sandbox passkey from Daraja |
| `MPESA_CALLBACK_URL` | for payments | `https://boma-reservations.vercel.app/api/payments/mpesa/callback` |
| `MPESA_ENVIRONMENT` | recommended | `sandbox` until Go Live, then `production` |
| `MPESA_TRANSACTION_TYPE` | optional | `CustomerPayBillOnline` (default) or `CustomerBuyGoodsOnline` |
| `MPESA_DEPOSIT_PERCENT` | optional | `100` (default) or e.g. `30` for a deposit |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | recommended | without these, email is logged only |
| `AT_API_KEY` / `AT_USERNAME` / `AT_SENDER_ID` | recommended | without these, SMS is logged only |
| `API_BODY_LIMIT` | optional | defaults to `1mb` |
| `DB_CONNECT_ATTEMPTS` | optional | serverless functions connect lazily; leave unset |

Do not set `PORT`. Do not set `NODE_ENV` manually on Vercel; the platform sets
`production`.

5. Deploy. The first request validates configuration. A missing/weak
   `JWT_SECRET`, missing `CLIENT_URL`, partial M-Pesa configuration or a
   temporary callback tunnel returns a configuration error instead of running in
   an unsafe state.
6. Verify:

```bash
curl https://boma-reservations.vercel.app/health/live
# {"status":"ok","service":"boma"}

curl https://boma-reservations.vercel.app/health
# {"status":"ok","db":"up"}  (503 + {"status":"degraded","db":"down"} if not)
```

`/health/live` never touches the database, so it is the liveness probe to use
for uptime monitoring. `/health` is readiness and returns HTTP 503 when the
database is unavailable.

### 4.1 Function duration and region

`vercel.json` sets `maxDuration: 120` for the API. Daraja calls are bounded at
10s (OAuth/query) and 20s (STK push), so normal requests finish far sooner. The
larger ceiling covers a payment-reconciliation cron sweep over several pending
checkouts. Hobby currently allows up to 300s.

`vercel.json` also pins `regions: ["sfo1"]` (nearest Vercel region to the
Supabase `us-west-1` pooler). Region selection is honored only on plans that
support it; if the runtime logs still report another region (e.g. `cpt1`), the
round trip to the database dominates request latency and moving the database
closer, or upgrading the plan, is the fix — not client-side changes.

## 5. The client is part of the same project — no second deploy

The merged project builds the CRA client inside the same pipeline
(`npm --prefix client run build`) and serves `client/build` from Vercel's CDN.
Everything the browser loads is static; only `/api/*` hits the function.

`REACT_APP_API_BASE=/` (production and preview) bakes **same-origin** API URLs
into the bundle (`/api/...`), so there is nothing to point at another origin.
If you ever split the client out again, set `REACT_APP_API_BASE` to the API
origin (no trailing slash, no `/api`) and redeploy — `REACT_APP_*` values are
baked at build time, so adding them after the fact does not help.

Same-origin means guests need no CORS exception. `CLIENT_URL` is still required
(email links and the socket allowlist use it) — set it to
`https://boma-reservations.vercel.app`.

After deploy, open the URL, sign in and confirm the browser's network calls go
to the same origin (`/api/...`). If a stale, per-deployment URL
(`boma-reservations-<hash>-njeri.vercel.app`) is bookmarked instead of the
production alias, its build may predate current env values; always share the
`boma-reservations.vercel.app` alias.

## 6. Scheduled jobs (reminders and payment recovery)

Vercel Hobby cron runs at most once per day, which is not enough for payment
recovery. Use an external scheduler:

| Job | URL | Frequency | Why |
| --- | --- | --- | --- |
| Payment recovery | `https://boma-reservations.vercel.app/api/cron/payments` | every minute | queries pending STK checkouts and completes real payments |
| Guest reminders | `https://boma-reservations.vercel.app/api/cron/reminders` | every 15 minutes | 48-hour and same-day reminders |

Configure the request header:

```
Authorization: Bearer <CRON_SECRET>
```

`x-cron-secret: <CRON_SECRET>` is also accepted for tools that cannot set an
`Authorization` header. The endpoints return `401` for a wrong secret, `503` if
`CRON_SECRET` is unset or the job fails, and JSON summaries on success:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://boma-reservations.vercel.app/api/cron/payments
# {"ok":true,"job":"payments","checked":0,"completed":0,"failed":0,"pending":0}
```

cron-job.org, EasyCron, UptimeRobot and GitHub Actions scheduled workflows all
work. GitHub Actions has a minimum interval of 5 minutes and can be delayed, so
it is a backstop rather than a minute-level payment reconciler.

If you upgrade to Vercel Pro and want platform cron, add a `crons` array to
`vercel.json` pointing at the same two paths; Vercel sends the
`Authorization: Bearer $CRON_SECRET` header automatically.

The local server does not need any of this: when `VERCEL` is unset it starts the
same sweeps in-process and ignores the cron endpoints.

## 7. M-Pesa: sandbox now, production after Go Live

### 7.1 Sandbox

1. Set the five `MPESA_*` variables with sandbox credentials and the Vercel
   callback URL.
2. Set `MPESA_ENVIRONMENT=sandbox`.
3. Run `npm run check:payments` locally with the same values, or use the API
   `/health/live` check and the Daraja portal.
4. Make a booking on the deployed client and pay with the shared sandbox test
   handset **254708374149**. Arbitrary real numbers do not ring in sandbox; this
   is a Safaricom limitation, not a Boma bug.
5. Confirm the reservation becomes `CONFIRMED` only after a real receipt is
   recorded. The callback path must return `200 {"ResultCode":0,...}` to
   Safaricom.

Sandbox payments never move real money and must never be presented to guests as
evidence that production payments work.

### 7.2 Production (Go Live)

1. Complete Daraja Go Live for the business Paybill/Buy Goods Till.
2. Replace the sandbox consumer key/secret, shortcode and passkey with the
   production values.
3. Set `MPESA_ENVIRONMENT=production`.
4. Keep `MPESA_CALLBACK_URL=https://boma-reservations.vercel.app/api/payments/mpesa/callback`.
5. Deploy and run `npm run check:go-live -- --skip-network` plus a real
   `npm run check:payments` against the production credentials.
6. Take a small live payment to your own number and verify the receipt appears
   in the client portal, the staff payments API and the audit log.
7. Only then announce online payment to guests.

Payment safety invariants (do not weaken):

- A payment is only `COMPLETED` when Safaricom returns a real M-Pesa receipt.
- A late payment for a cancelled/flagged booking is recorded for staff
  review/refund; it never silently re-confirms the booking.
- `4999` / "still under processing" stays `PENDING`; only terminal Daraja
  result codes fail a payment.
- Callback processing is transactional and idempotent. Processing failures
  return `5xx` so Safaricom retries.

## 8. Data hygiene before launch

1. **Disable every demo/QA account.** This includes
   `manager@orms.local`, `officer@orms.local`, `client@orms.local`,
   `public@boma.local` and any `qa-reminder-*` users. Create real staff accounts
   with strong passwords first, then deactivate the demo ones from
   Manager → Users.
2. Review QA reservations and payments. Do not delete real guest records; if a
   QA record must be removed, take a backup and do it in a reviewed SQL session.
3. Confirm the service catalog, prices and images are the real business content.
4. Set `CLIENT_URL` to the real client domain and re-check email links.
5. Run the pre-launch check:

```bash
npm run check:go-live
```

It checks configuration, database reachability, demo accounts, migration
history and (unless `--skip-network`) Daraja OAuth plus callback reachability.
It never writes data, sends messages or initiates a charge.

## 9. Post-deploy smoke test

- [ ] `GET /health/live` returns 200.
- [ ] `GET /health` returns 200 with `db: "up"`.
- [ ] The public catalog loads and `X-Source` is not `fallback`.
- [ ] A guest can register, book, and receive a confirmation code.
- [ ] Staff can sign in, confirm a booking and view it in reports.
- [ ] Browser network calls go to the same origin (`/api/...` on `boma-reservations.vercel.app`).
- [ ] `GET /api/cron/payments` with the secret returns a JSON summary.
- [ ] `GET /api/cron/payments` without the secret returns 401.
- [ ] A sandbox STK payment reaches `COMPLETED` with a receipt (test handset).
- [ ] A cancelled/flagged reservation does not get re-confirmed by a late payment.
- [ ] Email/SMS delivery is either configured or knowingly in log mode.
- [ ] Demo accounts are inactive.
- [ ] Supabase backups are enabled and a restore has been tested.

## 10. Monitoring and incidents

- Use `/health/live` for uptime checks every 1–5 minutes.
- Use `/health` for readiness; a persistent 503 means the database/pooler is
  unreachable. The API stays up and serves the fallback catalog.
- Watch Vercel function logs for `[mpesa]`, `[payments]`, `[cron]` and
  `[api] Unhandled error`. Every payment transition is also written to
  `AuditLog`.
- A `500` from the M-Pesa callback is intentional: it tells Safaricom to retry.
  Investigate the logs before replaying anything manually.
- If a deploy is bad, use Vercel → Deployments → **Rollback**. Database
  migrations are forward-only, so restore a backup if the schema itself is at
  fault.

## 11. Known limits

- Sandbox STK prompts only reach Safaricom's test handset/simulator.
- Hobby cron is daily; minute-level jobs require an external scheduler or Pro.
- In-memory rate limiting is per function instance. Vercel scales horizontally,
  so the login limiter is a speed bump, not a global quota. Account lockout in
  the database is the durable control.
- Supabase's pooler can intermittently fail TLS handshakes (`P1001`, `P2028`).
  The API retries and degrades cleanly; retry the failing operation before
  treating it as data loss.
- The local `start.mjs` embedded database is a development convenience. It
  wipes data and must never be used in production.
- `dist/` and `.vercel/` are build artefacts and are git-ignored.
