// Protected scheduled-job endpoints.
//
// Vercel Hobby cron runs only once per day, and the free tier otherwise does not
// provide minute-level scheduling. Point an external scheduler (cron-job.org,
// GitHub Actions, etc.) at these endpoints every minute (payments) and every
// 15 minutes (reminders). Both Vercel Cron and external schedulers authenticate
// with `Authorization: Bearer <CRON_SECRET>`; `x-cron-secret` is also accepted
// for tools that cannot set an Authorization header.
import crypto from "crypto";
import { NextFunction, Request, Response, Router } from "express";
import { runReminderSweep } from "../utils/reminders";
import { runPaymentReconciliation } from "../utils/paymentRecovery";
import { mpesaConfigured } from "../utils/mpesa";

const router = Router();

function secureEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireCronSecret(req: Request, res: Response, next: NextFunction) {
  const expected = String(process.env.CRON_SECRET || "");
  // Refuse to run an unauthenticated job endpoint. An empty secret must never
  // turn into an open trigger for emails/SMS or Daraja queries.
  if (!expected) {
    return res.status(503).json({ ok: false, error: "CRON_SECRET is not configured." });
  }

  const authorization = String(req.headers.authorization || "");
  const provided = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : String(req.headers["x-cron-secret"] || "");

  if (!provided || !secureEquals(expected, provided)) {
    return res.status(401).json({ ok: false, error: "Unauthorized." });
  }
  res.setHeader("Cache-Control", "no-store");
  next();
}

async function runReminders(_req: Request, res: Response) {
  try {
    const result = await runReminderSweep();
    res.json({ ok: true, job: "reminders", ...result });
  } catch (e) {
    // A failed sweep is retried by the scheduler. Return 503 so uptime monitors
    // and cron providers record the failure instead of seeing a false success.
    console.error("[cron] reminder sweep failed:", (e as Error)?.message || e);
    res.status(503).json({ ok: false, job: "reminders", error: "Reminder sweep failed." });
  }
}

async function runPayments(_req: Request, res: Response) {
  try {
    if (!mpesaConfigured()) {
      return res.json({ ok: true, job: "payments", skipped: "mpesa-not-configured" });
    }
    const result = await runPaymentReconciliation();
    res.json({ ok: true, job: "payments", ...result });
  } catch (e) {
    console.error("[cron] payment reconciliation failed:", (e as Error)?.message || e);
    res.status(503).json({ ok: false, job: "payments", error: "Payment reconciliation failed." });
  }
}

router.get("/reminders", requireCronSecret, runReminders);
router.post("/reminders", requireCronSecret, runReminders);
router.get("/payments", requireCronSecret, runPayments);
router.post("/payments", requireCronSecret, runPayments);

export default router;
