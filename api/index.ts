// Vercel serverless entry point.
//
// The local long-running server (server/index.ts) also starts in-process
// schedulers; this entry exports the same Express app without them. Scheduled
// work is triggered through the protected /api/cron/* routes instead.
import type { IncomingMessage, ServerResponse } from "http";
import { assertRuntimeConfig } from "../server/utils/runtimeConfig";
import { createApp } from "../server/app";

let app: ReturnType<typeof createApp> | null = null;
let configError: Error | null = null;

function getApp() {
  if (app) return app;
  if (configError) throw configError;
  try {
    // Deferred to the first request so a missing variable produces a clear
    // runtime error (and a 500) instead of failing the whole build.
    assertRuntimeConfig();
    app = createApp({ serveClient: false });
    return app;
  } catch (e) {
    configError = e instanceof Error ? e : new Error(String(e));
    console.error(`[vercel] ${configError.message}`);
    throw configError;
  }
}

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  try {
    getApp()(req, res);
  } catch {
    // Configuration failures are logged once above. Never leak secret values or
    // stack traces to the caller.
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
    }
    res.end(JSON.stringify({ error: "Server configuration error. Check the deployment logs." }));
  }
}
