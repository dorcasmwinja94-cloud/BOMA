# Boma - Online Reservation Management System

Professional reservation management platform for Kenyan accommodation, tours, beach excursions, transfers, and conference venues. Guests can browse the catalog, book, pay with M-Pesa, and manage their reservations; staff run confirmations, sync, reports and audit from role-based portals.

## Problems Solved
- **Duplicate bookings:** every creation runs the duplicate check and insert inside one serializable transaction, so two simultaneous requests cannot both claim the same slot. Conflicts are rejected with `409` and linked to the existing record.
- **Outdated schedules:** every reservation change records a `SyncLog`; staff can retry failed or pending syncs.
- **Missing confirmations:** a valid reservation automatically receives a `Boma-XXXX` confirmation; confirmations can be searched by code, client name or email, and are delivered by email (and SMS) with a per-confirmation delivery status.
- **No-shows and forgotten bookings:** guests receive automated reminders 24–48 hours before check-in and again on arrival day; an upfront M-Pesa deposit can be required to secure a slot.
- **Disappeared records:** every reservation carries a `version` number for optimistic locking; updates with a stale version are rejected.
- **Security:** five failed sign-ins lock an account for 15 minutes; the login page also pauses submissions for 60 seconds after three failures.

## Stack
- Supabase PostgreSQL + Prisma ORM
- Node.js / Express / Socket.IO
- React + React Router + Recharts
- JWT role-based access control: `MANAGER`, `RESERVATION_OFFICER`, `CLIENT`

## Quick Start (development)

### 1. Environment
Copy `.env.example` to `.env` and fill in real values. Never commit `.env`.

Use the **Supabase session pooler** URL (port `5432`) for Prisma. The direct
`db.<project-ref>.supabase.co` host may resolve to IPv6 only, and port `6543`
(transaction pooler) is not suitable for Prisma. If your network inspects TLS,
capture the pooler chain (`node fetch-pooler-cert.js`) and set `sslrootcert` in
`DATABASE_URL` accordingly. If neither is configured the server retries and then
boots in **degraded mode**: the public catalog is served from a cached/static
fallback and DB endpoints return a clean `503` — the site never hard-crashes.

### 2. Install
```bash
npm install
cd client && npm install
```

### 3. Sync the schema
```bash
npx prisma generate
npx prisma db push        # dev only — for production see "Deploying"
```

`db push` is safe for the existing populated database. Do **not** run
`npm run db:seed` against a populated database: the seed script clears and
replaces Boma data.

### 4. Run
```bash
npm run dev        # API on :4000 + React dev server on :3000
```
or separately: `npm run server` and `npm run client`.

## Demo Credentials (development only — change before go-live)
| Role | Email | Password | Portal |
| --- | --- | --- | --- |
| Manager | `manager@orms.local` | `Manager@123` | `/manager` |
| Reservation Officer | `officer@orms.local` | `Officer@123` | `/officer` |
| Client | `client@orms.local` | `Client@123` | `/client` |

## Payments (M-Pesa Daraja STK Push)
Configure all five M-Pesa variables (see `.env.example`). Without them the server
**refuses to initiate payment with HTTP 503** and tells the guest to pay at the
front desk — it never fabricates a payment.

> **Sandbox vs production prompts.** Safaricom's sandbox only delivers STK
> prompts to its shared test handset (`254708374149`) or the Daraja simulator.
> Arbitrary real numbers are accepted by the sandbox API but do not ring. To send
> prompts to real guest numbers, complete Daraja Go Live, use the production
> shortcode/passkey/keys, set `MPESA_ENVIRONMENT=production`, and point
> `MPESA_CALLBACK_URL` at a stable public HTTPS domain. Boma sends the STK to the
> exact number entered (normalized to `2547…`); prompt delivery is controlled by
> Safaricom, not by the application.

Flow:
1. Guest books (`POST /api/public/reservations` or authenticated `/api/reservations`).
2. Guest clicks **Pay now with M-Pesa** (public page: call
   `POST /api/public/payments/mpesa/initiate` with the reservation id and the
   confirmation code from the booking; authenticated clients: `POST /api/payments/mpesa/initiate`).
   The server sends an STK prompt to the guest's phone.
3. Safaricom calls `POST /api/payments/mpesa/callback` (public, always answered
   `200`). On success the payment is marked `COMPLETED` with the M-Pesa receipt
   and the reservation is auto-confirmed.
4. The client polls `GET /api/payments/status/:reservationId` (or
   `GET /api/public/payments/status/:reservationId?code=<confirmation code>`)
   every 5 seconds and shows the receipt.
5. Staff can record refunds via `POST /api/payments/:id/refund` (manager/officer).

`MPESA_ENVIRONMENT=production` switches the Daraja base URL from sandbox to live.
`MPESA_CALLBACK_URL` must be publicly reachable over HTTPS (your domain, or a
tunnel such as ngrok during sandbox testing).
`MPESA_TRANSACTION_TYPE` is `CustomerPayBillOnline` for a Paybill (default) or
`CustomerBuyGoodsOnline` for a Buy Goods Till.
`MPESA_DEPOSIT_PERCENT` (1–100, default `100`) controls the upfront share of the
reservation total collected by STK push. Set it to e.g. `30` to take a 30%
deposit; the client shows the deposit and balance before the guest enters their
PIN, and the property collects the balance at check-in.

## Email & SMS delivery
- Email: set `SMTP_*` (any provider — SendGrid, Mailgun, SES, Gmail app passwords).
  Booking confirmations and password resets are sent automatically. Without
  `SMTP_HOST` every message is logged to the server console (`[mail:log]`) and
  password-reset responses include a `devToken` so the flow is still testable —
  `devToken` is **never** returned once SMTP is configured.
- SMS: set `AT_API_KEY` / `AT_USERNAME` (/`AT_SENDER_ID`) for Africa's Talking.
  Without them messages are logged to the console (`[sms:log]`).
- Resending a confirmation actually re-delivers it and updates the stored
  `deliveryStatus` (`SENT` / `FAILED`).
- **Automated reminders:** a scheduler sweeps every 15 minutes and sends a
  reminder to confirmed guests whose check-in is tomorrow (24–48h ahead) and
  again on the arrival day. Each stage is recorded in the `AuditLog`
  (`REMINDER_48H` / `REMINDER_SAME_DAY`) so a guest is never reminded twice;
  delivery uses the same SMTP and Africa's Talking channels.

## Production deployment
```bash
npm install
npm run build            # builds client/ into client/build
npx prisma migrate deploy
NODE_ENV=production PORT=4000 npm start
```
In production the same Node process serves the built client (SPA fallback for
client-side routes) and the API under `/api` on the same origin — no CORS is
needed and none is opened. Put the process behind a TLS-terminating reverse
proxy (nginx/Caddy) or your platform's load balancer.

### Process manager (PM2)
```bash
npm install -g pm2
npm run build
pm2 start ecosystem.config.js
pm2 save
```
`ecosystem.config.js` runs the API as `boma` with automatic restarts. Alternatively
use `systemd`/`docker` — the contract is: `NODE_ENV=production npm start` on a
single port with `client/build` present.

### Database backups
Supabase's free tier has limited point-in-time recovery. Enable scheduled backups
(Project → Database → Backups) or `pg_dump`/`pg_cron` before real guest data
accumulates. Test a restore at least once.

## Health & degraded mode
`GET /health` probes the database with a 2s timeout:
`{"status":"ok","db":"up"}` or `{"status":"degraded","db":"down"}`.
Use it for uptime checks and load-balancer health probes. Transient DB drops do
not kill the process (retried connect, async error containment); the site stays
on the last-good catalog until the DB recovers.

## Known operational caveats
- Supabase session pooler from some networks intermittently drops TLS handshakes.
  The app absorbs these (retry + degraded mode). If drops are frequent, check the
  network route or open a Supabase support ticket; port `6543` cannot be used by
  Prisma from this setup.
- In-memory auth rate limiting is per-process — run a single instance or move
  `express-rate-limit` to a shared store before scaling horizontally.
- The React dev server on `:3000` proxies nothing; dev expects the API on `:4000`
  and uses cross-origin calls with `CLIENT_URL`-style open CORS in development only.

## Verification
- `npx tsc --noEmit` — server type-check (must pass).
- `node server/test-core-features.js` — regression suite (CRUD, duplicate 409,
  stale-version 409, sync, reports, lockout) against a running server.
- `npm run build --prefix client` — production client compile.
- `cdp-*.js` — headless-Chrome checks (need Chrome with `--remote-debugging-port=9222`).
- CI: `.github/workflows/ci.yml` runs install, Prisma validate + generate, server
  type-check and the client production build on every push/PR.

## Key API Areas
- `POST /api/auth/login` - JWT sign-in with lockout handling
- `GET/POST/PUT /api/reservations` - reservation CRUD with duplicate checks and version locking
- `POST /api/reservations/:id/cancel` - cancel and record sync/audit events
- `POST /api/sync-logs/retry` - retry external sync
- `GET /api/confirmations`, `GET /api/confirmations/search`, `POST /api/confirmations/:id/resend`
- `POST /api/payments/mpesa/initiate`, `POST /api/payments/mpesa/callback`, `GET /api/payments/status/:reservationId`
- `GET /api/dashboard/summary`, `GET /api/audit-logs`
- Public: `POST /api/public/reservations`, `POST /api/public/password-reset-request`,
  `POST /api/public/password-reset`, `POST /api/public/payments/mpesa/initiate`,
  `GET /api/public/payments/status/:reservationId`
