// Pre-launch / pre-handover verification for Boma.
//
//   npm run check:go-live
//   npm run check:go-live -- --skip-network
//
// It never sends email/SMS, never initiates a payment and never writes to the
// database. It checks configuration, database reachability, seed/demo data and
// (unless --skip-network) Daraja OAuth plus the public callback host.
import "../utils/envBootstrap";
import fs from "fs";
import { prisma } from "../utils/prisma";
import { getJwtSecret, isDeployedProduction, isProductionRuntime } from "../utils/runtimeConfig";
import {
  MPESA_ENV,
  MPESA_SANDBOX,
  mpesaConfigured,
  verifyDarajaConnection,
} from "../utils/mpesa";

const skipNetwork = process.argv.includes("--skip-network");
let failures = 0;
let warnings = 0;

function heading(text: string): void {
  console.log(`\n${text}`);
}

function ok(label: string, detail = ""): void {
  console.log(`  OK   ${label}${detail ? ` — ${detail}` : ""}`);
}

function warn(label: string, detail = ""): void {
  warnings++;
  console.log(`  WARN ${label}${detail ? ` — ${detail}` : ""}`);
}

function fail(label: string, detail = ""): void {
  failures++;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
}

function httpsUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probeCallbackHealth(callbackUrl: string): Promise<void> {
  const url = httpsUrl(callbackUrl);
  if (!url) return;
  const target = `${url.origin}/health/live`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(target, { signal: controller.signal });
    const text = (await res.text()).slice(0, 120);
    if (res.ok) ok("public callback host reachable", `${target} -> ${res.status} ${text}`);
    else warn("public callback host responded with an error", `${target} -> ${res.status} ${text}`);
  } catch (e) {
    warn("public callback host unreachable from this machine", `${target}: ${(e as Error)?.message || e}`);
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const deployed = isDeployedProduction();

  heading("Boma go-live check");
  console.log(`  runtime:        ${isProductionRuntime() ? "production-like" : "development"}`);
  console.log(`  deployed:       ${deployed ? "yes" : "no"}`);
  console.log(`  skip network:   ${skipNetwork ? "yes" : "no"}`);
  console.log(`  database host:  ${databaseHost()}`);

  heading("Configuration");
  checkDatabaseUrl(deployed);
  checkJwtSecret();
  checkClientUrl(deployed);
  checkCronSecret(deployed);
  checkMessaging();

  const mpesaReady = checkMpesa(deployed);
  if (mpesaReady && !skipNetwork) {
    console.log("\nChecking Daraja OAuth (no charge is initiated)...");
    try {
      const info = await verifyDarajaConnection();
      ok("Daraja authentication", `${info.mode} shortcode ${info.shortcode}`);
    } catch (e) {
      fail("Daraja authentication", (e as Error)?.message || String(e));
    }
  }
  if (mpesaReady && !skipNetwork) {
    await probeCallbackHealth(String(process.env.MPESA_CALLBACK_URL || ""));
  }

  heading("Database");
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, 10000, "database probe");
    ok("database reachable");
    await inspectData(deployed);
  } catch (e) {
    fail("database unreachable", (e as Error)?.message?.split("\n")[0] || String(e));
    console.log("  Fix DATABASE_URL / the Supabase pooler before deploying. The API can boot degraded, but bookings cannot be served.");
  }

  heading("Result");
  if (failures > 0) {
    console.log(`  ${failures} blocker(s), ${warnings} warning(s). Resolve the blockers before taking live bookings.`);
    process.exitCode = 1;
  } else if (warnings > 0) {
    console.log(`  No blockers, ${warnings} warning(s). Review the warnings before launch.`);
  } else {
    console.log("  All checks passed.");
  }

  await prisma.$disconnect().catch(() => undefined);
}

function databaseHost(): string {
  try {
    return new URL(String(process.env.DATABASE_URL)).host;
  } catch {
    return "(not set or invalid)";
  }
}

function checkDatabaseUrl(deployed: boolean): void {
  const raw = String(process.env.DATABASE_URL || "");
  if (!raw) {
    fail("DATABASE_URL is set");
    return;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail("DATABASE_URL is a valid URL");
    return;
  }
  ok("DATABASE_URL is set", url.host);

  const sslRootCert = url.searchParams.get("sslrootcert");
  if (sslRootCert) {
    if (deployed && process.env.VERCEL === "1") {
      fail(
        "DATABASE_URL has no local sslrootcert path on Vercel",
        "remove sslrootcert from the Vercel environment variable; use sslmode=require"
      );
    } else if (!fs.existsSync(sslRootCert)) {
      fail("sslrootcert file exists", sslRootCert);
    } else {
      ok("sslrootcert file exists", sslRootCert);
    }
  }

  if (process.env.VERCEL === "1" && url.port !== "6543") {
    warn(
      "Vercel should use the Supabase transaction pooler (port 6543)",
      "thousands of short-lived functions exhaust a session-pooler connection limit; add pgbouncer=true&connection_limit=1"
    );
  }
  if (url.searchParams.get("pgbouncer") === "true" && url.port !== "6543") {
    warn("pgbouncer=true is set on a non-6543 port", "check the Supabase pooler URL");
  }
}

function checkJwtSecret(): void {
  try {
    const secret = getJwtSecret();
    if (secret.startsWith("boma-development-only")) {
      warn("JWT_SECRET is using the development fallback", "set a strong secret before production");
    } else {
      ok("JWT_SECRET is strong", `${secret.length} characters`);
    }
  } catch (e) {
    fail("JWT_SECRET is strong", (e as Error)?.message || String(e));
  }
}

function checkClientUrl(deployed: boolean): void {
  const raw = String(process.env.CLIENT_URL || "").trim();
  if (!raw) {
    if (deployed) fail("CLIENT_URL is set");
    else warn("CLIENT_URL is not set", "emails and CORS will fall back to development defaults");
    return;
  }
  const first = raw.split(",")[0].trim();
  const url = httpsUrl(first);
  if (!url) {
    if (deployed) fail("CLIENT_URL is https", first);
    else warn("CLIENT_URL is not https", first);
    return;
  }
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    if (deployed) fail("CLIENT_URL is not localhost in production", first);
    else ok("CLIENT_URL (development)", first);
    return;
  }
  ok("CLIENT_URL is https", first);
}

function checkCronSecret(deployed: boolean): void {
  const secret = String(process.env.CRON_SECRET || "");
  if (!secret) {
    if (deployed) fail("CRON_SECRET is set", "required for reminders and payment recovery on Vercel");
    else warn("CRON_SECRET is not set", "cron endpoints are disabled; the local server still runs its timers");
    return;
  }
  if (secret.length < 16) {
    if (deployed) fail("CRON_SECRET is at least 16 characters");
    else warn("CRON_SECRET is shorter than recommended");
    return;
  }
  ok("CRON_SECRET is set", `${secret.length} characters`);
}

function checkMessaging(): void {
  const smtpHost = String(process.env.SMTP_HOST || "");
  if (!smtpHost) {
    warn("SMTP is not configured", "emails (confirmations, receipts, resets) are only written to the server log");
  } else {
    const missing = ["SMTP_PORT", "SMTP_FROM"].filter((key) => !process.env[key]);
    if (missing.length) warn("SMTP is partially configured", `missing ${missing.join(", ")}`);
    else ok("SMTP is configured", smtpHost);
  }

  const atKey = String(process.env.AT_API_KEY || "");
  const atUser = String(process.env.AT_USERNAME || "");
  if (!atKey && !atUser) {
    warn("Africa's Talking is not configured", "SMS is only written to the server log");
  } else if (!atKey || !atUser) {
    warn("Africa's Talking is partially configured", "both AT_API_KEY and AT_USERNAME are required");
  } else {
    ok("Africa's Talking is configured", atUser);
  }
}

function checkMpesa(deployed: boolean): boolean {
  const present = MPESA_ENV.filter((key) => Boolean(process.env[key]));
  if (present.length === 0) {
    warn("M-Pesa is not configured", "guests can book and pay at the front desk; online payment is disabled");
    return false;
  }
  if (present.length < MPESA_ENV.length) {
    fail("M-Pesa configuration is complete", `missing ${MPESA_ENV.filter((key) => !process.env[key]).join(", ")}`);
    return false;
  }

  const callback = String(process.env.MPESA_CALLBACK_URL || "");
  const url = httpsUrl(callback);
  if (!url) {
    fail("MPESA_CALLBACK_URL is a public https URL", callback);
    return true;
  }
  ok("MPESA_CALLBACK_URL is https", url.host);
  if (callback.includes("trycloudflare.com") || callback.includes("ngrok")) {
    if (deployed) fail("MPESA_CALLBACK_URL is stable", "temporary tunnels expire and lose real payment callbacks");
    else warn("MPESA_CALLBACK_URL is a temporary tunnel", "replace it with the deployed API URL before launch");
  }

  const mode = MPESA_SANDBOX ? "sandbox" : "production";
  if (mode === "sandbox") {
    warn("M-Pesa is in sandbox mode", "real money cannot be collected until Daraja Go Live credentials are configured");
  } else {
    ok("M-Pesa is in production mode", String(process.env.MPESA_SHORTCODE || ""));
  }
  return true;
}

async function inspectData(deployed: boolean): Promise<void> {
  const [services, users, reservations, payments] = await Promise.all([
    prisma.service.count(),
    prisma.user.count(),
    prisma.reservation.count(),
    prisma.payment.count(),
  ]);
  console.log(
    `  data:           ${services} service(s), ${users} user(s), ${reservations} reservation(s), ${payments} payment(s)`
  );

  if (services === 0) warn("no services are configured", "the public catalog will use static fallback content");

  const demoUsers = await prisma.user.findMany({
    where: {
      OR: [
        { email: { endsWith: "@orms.local" } },
        { email: { endsWith: "@boma.local" } },
        { email: { startsWith: "qa-reminder-" } },
      ],
    },
    select: { email: true, role: true, isActive: true },
  });
  const activeDemo = demoUsers.filter((user) => user.isActive);
  if (activeDemo.length === 0) {
    ok("no active demo/QA accounts");
  } else {
    const detail = activeDemo.map((user) => `${user.email} (${user.role})`).join(", ");
    if (deployed) fail("no active demo/QA accounts in production", detail);
    else warn("demo/QA accounts are active", `${activeDemo.length}: ${detail}`);
  }

  try {
    const rows = await prisma.$queryRaw<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM "_prisma_migrations"
    `;
    const applied = Number(rows[0]?.count || 0);
    if (applied === 0) {
      warn("no Prisma migrations are recorded", "use prisma migrate deploy (or resolve a baseline) before production");
    } else {
      ok("Prisma migrations recorded", `${applied} applied`);
    }
  } catch {
    warn(
      "schema is not under Prisma migration control",
      "create a baseline migration and run prisma migrate deploy before production"
    );
  }
}

main().catch(async (e) => {
  console.error("\nFAILED —", e?.message || e);
  process.exitCode = 1;
  await prisma.$disconnect().catch(() => undefined);
});
