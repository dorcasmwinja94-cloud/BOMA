import "./utils/expressAsync"; // must be imported before routes register their handlers
import path from "path";
import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import { prisma, dbState } from "./utils/prisma";
import router from "./routes/main";
import { startReminderScheduler } from "./utils/reminders";
import { startPaymentReconciler } from "./utils/paymentRecovery";
import { mpesaConfigured, MPESA_SANDBOX } from "./utils/mpesa";

const isProd = process.env.NODE_ENV === "production" || process.argv.includes("--prod");
// Same-origin SPA needs no CORS in production; cross-origin dev defaults to open.
const corsOrigin = process.env.CLIENT_URL || (isProd ? false : "*");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: corsOrigin === false ? undefined : corsOrigin } });

if (isProd) app.set("trust proxy", 1);
app.use(cors({ origin: corsOrigin }));
app.use(express.json());

// Liveness only: no database probe, so a setup check through a tunnel cannot
// flip the global DB state or time out on a slow pooler round-trip.
app.get("/health/live", (_req, res) => {
  res.json({ status: "ok", service: "boma" });
});

app.get("/health", async (_req, res) => {
  try {
    const probe = prisma.$queryRaw`SELECT 1`;
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("db probe timeout")), 2000));
    await Promise.race([probe, timeout]);
    dbState.ready = true;
    res.json({ status: "ok", db: "up" });
  } catch {
    dbState.ready = false;
    res.json({ status: "degraded", db: "down" });
  }
});

app.use("/api", router);

// In production serve the compiled client and fall back to index.html for SPA routes.
if (isProd) {
  const buildDir = path.join(process.cwd(), "client", "build");
  app.use(express.static(buildDir));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api") || req.path.startsWith("/health") || req.path.startsWith("/socket.io")) return next();
    res.sendFile(path.join(buildDir, "index.html"));
  });
}

// Always return JSON on unhandled errors (avoids HTML error pages in the SPA).
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[api] Unhandled error:", err);
  res.status(500).json({ error: "Service temporarily unavailable. Please try again." });
});

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);
  socket.join("manager");
});

// Keep the process alive and log instead of crashing on unexpected failures.
process.on("unhandledRejection", (reason) => console.error("[process] Unhandled rejection:", reason));
process.on("uncaughtException", (err) => console.error("[process] Uncaught exception:", err));

async function start() {
  // The hosted Postgres (Supabase session pooler) occasionally drops TLS
  // handshakes; retry before deciding. If the DB never comes up, still boot in
  // degraded mode: the public catalog is served from a cached/static fallback
  // and DB endpoints return a clean error instead of the whole site dying.
  const MAX_ATTEMPTS = Number(process.env.DB_CONNECT_ATTEMPTS || 10);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await prisma.$connect();
      dbState.ready = true;
      console.log("[startup] Database connected");
      break;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn(`[startup] DB connect attempt ${attempt}/${MAX_ATTEMPTS} failed: ${message.split("\n")[0]}`);
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (!dbState.ready) {
    console.warn("[startup] Continuing in DEGRADED mode (no DB). Public catalog uses fallback data; sign-in and booking return a clean 503 until the database recovers.");
  }
  if (mpesaConfigured()) {
    let callbackHost = "(invalid)";
    try { callbackHost = new URL(String(process.env.MPESA_CALLBACK_URL)).host; } catch { /* keep placeholder */ }
    console.log(`[mpesa] mode=${MPESA_SANDBOX ? "sandbox" : "production"} shortcode=${process.env.MPESA_SHORTCODE} callback-host=${callbackHost}`);
    if (MPESA_SANDBOX && callbackHost.includes("trycloudflare.com")) {
      console.warn("[mpesa] callback uses a temporary trycloudflare tunnel — use a stable HTTPS domain for production.");
    }
  } else {
    console.warn("[mpesa] not configured — payment initiation returns 503; guests can still pay at the front desk.");
  }
  const port = Number(process.env.PORT || 4000);
  server.listen(port, () => {
    console.log(`Boma server running on port ${port}`);
    startReminderScheduler();
    startPaymentReconciler();
  });
}
start();
