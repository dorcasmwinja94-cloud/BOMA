import "./utils/expressAsync"; // must run before routes register their handlers
import path from "path";
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import { prisma, dbState } from "./utils/prisma";
import router from "./routes/main";
import cronRouter from "./routes/cron";
import { isProductionRuntime } from "./utils/runtimeConfig";

export type CreateAppOptions = {
  // The local long-running server serves the compiled CRA build. On Vercel the
  // CDN serves the client and only /api/* reaches this app.
  serveClient?: boolean;
};

function allowedOrigins(): string[] {
  return String(process.env.CLIENT_URL || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function createApp(options: CreateAppOptions = {}): express.Express {
  const production = isProductionRuntime();
  const serveClient = options.serveClient ?? !process.env.VERCEL;
  const app = express();

  app.disable("x-powered-by");
  if (production) app.set("trust proxy", 1);

  // Same-origin production deployments need no CORS. CLIENT_URL is still the
  // browser origin allowed to call the API; a comma-separated list also
  // covers preview deployments and a future split into two projects.
  const origins = allowedOrigins();
  const originOption = origins.length
    ? (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        // Requests without an Origin header (server-to-server, curl, Safaricom
        // callbacks) are not browser CORS requests and must still work.
        callback(null, !origin || origins.includes(origin));
      }
    : production
      ? false
      : "*";

  app.use(cors({ origin: originOption }));
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    next();
  });
  // Bounded body size: the API never accepts file uploads, only small JSON
  // payloads. This turns an oversized request into a clean 413 instead of
  // exhausting function memory.
  app.use(express.json({ limit: process.env.API_BODY_LIMIT || "1mb" }));

  // Liveness only: no database probe, so a setup check through a tunnel or a
  // platform health check cannot flip the global DB state or time out on a slow
  // pooler round-trip.
  app.get("/health/live", (_req, res) => {
    res.json({ status: "ok", service: "boma" });
  });

  // Readiness: proves the database is reachable. Kept bounded so a stalled
  // pooler cannot hold the request open.
  app.get("/health", async (_req, res) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const probe = prisma.$queryRaw`SELECT 1`;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("db probe timeout")), 2000);
      });
      await Promise.race([probe, timeout]);
      dbState.ready = true;
      res.json({ status: "ok", db: "up" });
    } catch {
      dbState.ready = false;
      res.status(503).json({ status: "degraded", db: "down" });
    } finally {
      if (timer) clearTimeout(timer);
    }
  });

  // Scheduled jobs are called by an external scheduler (see docs/GO-LIVE.md),
  // never by the public client.
  app.use("/api/cron", cronRouter);

  app.use("/api", router);

  // Unknown API routes must return JSON, never the SPA shell or an HTML page.
  app.use("/api", (req: Request, res: Response) => {
    res.status(404).json({ error: "Not found", path: req.originalUrl });
  });

  if (serveClient && production) {
    const buildDir = path.join(process.cwd(), "client", "build");
    app.use(express.static(buildDir));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api") || req.path.startsWith("/health")) {
        return next();
      }
      res.sendFile(path.join(buildDir, "index.html"));
    });
  } else {
    app.get("/", (_req, res) => {
      res.json({ service: "boma", status: "ok", health: "/health/live" });
    });
    // Every other unknown path is an API 404, not Express's HTML page.
    app.use((req: Request, res: Response) => {
      res.status(404).json({ error: "Not found", path: req.originalUrl });
    });
  }

  // Always return JSON on unhandled errors (avoids HTML error pages in the SPA).
  // Malformed bodies surface with different shapes depending on the runtime
  // (body-parser SyntaxError locally, plain Error from the platform's body
  // getter on serverless), so match them all as client errors: a bad request
  // must never look like a server failure.
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = Number(err?.statusCode ?? err?.status ?? 0);
    const type = String(err?.type ?? "");
    const message = String(err?.message ?? "");
    if (status === 413 || type === "entity.too.large") {
      return res.status(413).json({ error: "Request body is too large." });
    }
    if (
      status === 400 ||
      type === "entity.parse.failed" ||
      type === "entity.verify.failed" ||
      (err instanceof SyntaxError && "body" in err) ||
      /invalid json/i.test(message)
    ) {
      return res.status(400).json({ error: "Invalid JSON body." });
    }
    console.error("[api] Unhandled error:", err);
    res.status(500).json({ error: "Service temporarily unavailable. Please try again." });
  });

  return app;
}
