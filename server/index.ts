import "./utils/envBootstrap"; // must be first: populates process.env before other imports
import http from "http";
import { createApp } from "./app";
import { prisma, dbState } from "./utils/prisma";
import { startReminderScheduler } from "./utils/reminders";
import { startPaymentReconciler } from "./utils/paymentRecovery";
import { mpesaConfigured, MPESA_SANDBOX } from "./utils/mpesa";
import { assertRuntimeConfig, isProductionRuntime } from "./utils/runtimeConfig";

const production = isProductionRuntime();
const app = createApp({ serveClient: true });
const server = http.createServer(app);

let shuttingDown = false;

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[process] ${signal} received — shutting down gracefully`);

  // Never let a stuck keep-alive connection prevent a restart/deploy from
  // finishing. The timer is a last resort; normal shutdown clears it.
  const force = setTimeout(() => {
    console.error("[process] Forced exit after 10s");
    process.exit(exitCode || 1);
  }, 10_000);
  force.unref();

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections?.();
    setTimeout(() => {
      server.closeAllConnections?.();
      resolve();
    }, 3000).unref();
  });
  try {
    await prisma.$disconnect();
  } catch {
    // The pool may already be gone (for example after a database restart).
  }

  clearTimeout(force);
  process.exit(exitCode);
}

// A process that continues after an uncaught exception or an unhandled
// rejection can serve corrupted state. Log it, stop accepting requests, and let
// the supervisor (ts-node-dev, PM2, systemd, Vercel) start a clean process.
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  console.error("[process] Unhandled rejection:", reason);
  void shutdown("unhandledRejection", 1);
});
process.on("uncaughtException", (err) => {
  console.error("[process] Uncaught exception:", err);
  void shutdown("uncaughtException", 1);
});

async function connectWithTimeout(ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      prisma.$connect(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("database connect timeout")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function start(): Promise<void> {
  try {
    assertRuntimeConfig();
  } catch (e) {
    console.error(`[startup] ${(e as Error).message}`);
    process.exit(1);
  }

  // The hosted Postgres (Supabase pooler) occasionally drops TLS handshakes;
  // retry before deciding. If it never comes up, still boot in degraded mode:
  // the public catalog is served from cache/fallback and database endpoints
  // return a clean error instead of the whole site dying.
  const maxAttempts = Number(process.env.DB_CONNECT_ATTEMPTS || (production ? 3 : 10));
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await connectWithTimeout(8000);
      dbState.ready = true;
      console.log("[startup] Database connected");
      break;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn(`[startup] DB connect attempt ${attempt}/${maxAttempts} failed: ${message.split("\n")[0]}`);
      if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
  if (!dbState.ready) {
    console.warn(
      "[startup] Continuing in DEGRADED mode (no DB). Public catalog uses fallback data; " +
        "sign-in and booking return a clean 503 until the database recovers."
    );
  }

  if (mpesaConfigured()) {
    let callbackHost = "(invalid)";
    try {
      callbackHost = new URL(String(process.env.MPESA_CALLBACK_URL)).host;
    } catch {
      // Keep the placeholder; assertRuntimeConfig already reported the URL.
    }
    console.log(
      `[mpesa] mode=${MPESA_SANDBOX ? "sandbox" : "production"} ` +
        `shortcode=${process.env.MPESA_SHORTCODE} callback-host=${callbackHost}`
    );
  } else {
    console.warn("[mpesa] not configured — payment initiation returns 503; guests can still pay at the front desk.");
  }

  const port = Number(process.env.PORT || 4000);
  server.on("error", (err) => {
    console.error("[startup] HTTP server error:", err);
    process.exit(1);
  });
  server.listen(port, () => {
    console.log(`Boma server running on port ${port}`);
    // The Vercel deployment uses /api/cron/*, not in-process timers.
    if (!process.env.VERCEL) {
      startReminderScheduler();
      startPaymentReconciler();
    }
  });
}

void start();
