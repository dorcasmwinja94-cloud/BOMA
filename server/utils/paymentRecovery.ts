// Payment completion and reconciliation.
//
// A successful STK payment must survive a missed callback. Safaricom retries
// callbacks for a while, but a tunnel restart or a network flap can still lose
// the final one. Pending checkouts are therefore queried against Daraja:
//   - every 60 seconds in the background;
//   - in the background when a guest polls payment status;
//   - before an old pending checkout is replaced by a retry.
//
// Completion is always conditional on a real M-Pesa receipt. Nothing here ever
// invents a successful payment.
import { prisma } from "./prisma";
import { logAudit } from "../middleware/auth";
import { mpesaConfigured, normalizeKenyanPhone, stkQuery } from "./mpesa";
import { paymentReceiptEmail, sendMail } from "./mailer";
import { sendSms } from "./africastalking";

export const PAYMENT_PENDING_PREFIX = "MPESA-PENDING-";
const QUERY_THROTTLE_MS = 20_000;
const SWEEP_INTERVAL_MS = 60_000;
const MIN_PAYMENT_AGE_MS = 45_000;
// A real STK prompt resolves within minutes. Older PENDING rows are left for
// manual review instead of being queried forever (the sandbox in particular can
// keep stale checkouts "processing" indefinitely).
const MAX_RECONCILE_AGE_MS = 24 * 60 * 60 * 1000;

export type PaymentLike = {
  id: string;
  reservationId: string;
  status: string;
  amount: number;
  transactionId: string | null;
  attemptedAt: Date | null;
  createdAt: Date;
};

const inFlight = new Set<string>();
const lastQueriedAt = new Map<string, number>();

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Daraja's sandbox allows only a small burst of messages per minute
// (maxBurstMessageCount=3) and answers a burst with HTTP 429. Serialize every
// query and leave a gap so a sweep over several pending bookings does not
// trigger it.
let queryQueue: Promise<void> = Promise.resolve();
function withQuerySlot<T>(fn: () => Promise<T>): Promise<T> {
  const run = queryQueue.then(async () => {
    await delay(750);
    return fn();
  });
  queryQueue = run.then(() => undefined, () => undefined);
  return run;
}

// Marks the payment COMPLETED and, only when the booking is still PENDING,
// confirms it. A late payment for a cancelled or flagged booking is recorded
// for staff review but never silently resurrects that booking.
export async function completePayment(
  payment: PaymentLike,
  receipt: string,
  paidAmount?: number,
  source = "reconciler"
): Promise<boolean> {
  const finalAmount = Number.isFinite(paidAmount) && Number(paidAmount) > 0 ? Number(paidAmount) : payment.amount;
  const result = await prisma.$transaction(async (tx) => {
    const changed = await tx.payment.updateMany({
      where: { id: payment.id, status: { in: ["PENDING", "FAILED"] } },
      data: { status: "COMPLETED", transactionId: receipt, paidAt: new Date(), amount: finalAmount },
    });
    if (changed.count === 0) return { recorded: false, confirmed: false, reservationStatus: null as string | null };

    const reservation = await tx.reservation.findUnique({
      where: { id: payment.reservationId },
      select: { status: true },
    });
    let confirmed = false;
    if (reservation?.status === "PENDING") {
      await tx.reservation.update({
        where: { id: payment.reservationId },
        data: { status: "CONFIRMED", version: { increment: 1 } },
      });
      confirmed = true;
    }
    return { recorded: true, confirmed, reservationStatus: reservation?.status || null };
  });

  if (result.recorded) {
    await logAudit(
      null,
      "MPESA_PAYMENT_COMPLETE",
      "Payment",
      payment.reservationId,
      JSON.stringify({
        receipt,
        amount: finalAmount,
        source,
        confirmed: result.confirmed,
        reservationStatus: result.reservationStatus,
      }),
      "",
      `boma-${source}`
    );
    if (result.confirmed) {
      console.log(`[mpesa] payment COMPLETED for reservation ${payment.reservationId} receipt ${receipt} (${source}) — reservation confirmed.`);
    } else if (result.reservationStatus === "CANCELLED" || result.reservationStatus === "FLAGGED_DUPLICATE") {
      console.warn(
        `[mpesa] payment COMPLETED for reservation ${payment.reservationId} receipt ${receipt} (${source}) ` +
        `but the reservation is ${result.reservationStatus} — manual review/refund required.`
      );
    } else {
      // The guest was already confirmed (for example by staff at the desk).
      // Recording the payment is all that is needed; no refund is implied.
      console.log(
        `[mpesa] payment COMPLETED for reservation ${payment.reservationId} receipt ${receipt} (${source}) ` +
        `— reservation already ${result.reservationStatus || "confirmed"}.`
      );
    }

    // Tell the guest their payment landed. Fire-and-forget so a slow or
    // unconfigured mail/SMS provider never delays the Daraja callback.
    void notifyPaymentReceived(payment, receipt, finalAmount, result.reservationStatus).catch((e) =>
      console.warn("[mpesa] receipt notification failed:", (e as Error)?.message || e)
    );
  }
  return result.recorded;
}

// Emails and texts the M-Pesa receipt to the guest after a successful payment.
// Never throws: delivery problems are logged and the payment stays recorded.
async function notifyPaymentReceived(
  payment: PaymentLike,
  receipt: string,
  amount: number,
  reservationStatus: string | null
): Promise<void> {
  const reservation = await prisma.reservation.findUnique({
    where: { id: payment.reservationId },
    include: { client: true, service: true, confirmation: true },
  });
  if (!reservation) return;

  const code = reservation.confirmation?.confirmationCode || reservation.id.slice(0, 8);
  const total = Number(reservation.totalAmount || 0);
  const balance = Math.max(0, total - Number(amount || 0));
  const money = (value: number) => Number(value || 0).toLocaleString("en-KE");
  const cancelled = reservationStatus === "CANCELLED";
  const flagged = reservationStatus === "FLAGGED_DUPLICATE";

  const email = String(reservation.client?.email || "").trim();
  if (email) {
    try {
      const mail = paymentReceiptEmail({
        guestName: reservation.client?.fullName || "guest",
        code,
        serviceName: reservation.service?.name || "Boma reservation",
        receipt,
        amount,
        total,
        balance,
        currency: "KES",
        reservationStatus,
      });
      const sent = await sendMail({ to: email, ...mail });
      console.log(`[mpesa] receipt ${receipt} emailed to ${email} (${sent.mode})`);
    } catch (e) {
      console.warn(`[mpesa] receipt email failed for ${code}:`, (e as Error)?.message || e);
    }
  }

  const rawPhone = String(reservation.client?.phoneNumber || "").trim();
  const phone = normalizeKenyanPhone(rawPhone) || rawPhone;
  if (phone) {
    const message = cancelled
      ? `Boma: Payment of KES ${money(amount)} received for ${code} (receipt ${receipt}). This booking is cancelled - our team will contact you about a refund.`
      : flagged
        ? `Boma: Payment of KES ${money(amount)} received for ${code} (receipt ${receipt}). This booking is flagged for review - our team will contact you.`
        : `Boma: Payment of KES ${money(amount)} received for ${code}. Receipt ${receipt}. Balance KES ${money(balance)}. Asante!`;
    try {
      const sent = await sendSms(phone, message);
      console.log(`[mpesa] receipt ${receipt} SMS to ${phone} (${sent.mode}, ok=${sent.ok})`);
    } catch (e) {
      console.warn(`[mpesa] receipt SMS failed for ${code}:`, (e as Error)?.message || e);
    }
  }
}

// Marks a pending payment FAILED. Safe to call repeatedly and after a success:
// the conditional update can never downgrade a COMPLETED payment.
export async function failPayment(
  payment: PaymentLike,
  resultCode: string,
  resultDesc: string,
  source = "reconciler"
): Promise<boolean> {
  const failed = await prisma.payment.updateMany({
    where: { id: payment.id, status: "PENDING" },
    data: { status: "FAILED" },
  });
  if (failed.count === 0) return false;
  await logAudit(
    null,
    "MPESA_PAYMENT_FAILED",
    "Payment",
    payment.reservationId,
    JSON.stringify({ resultCode, resultDesc, source }),
    "",
    `boma-${source}`
  );
  console.warn(`[mpesa] payment FAILED for reservation ${payment.reservationId}: ${resultCode} ${resultDesc} (${source})`);
  return true;
}

export type ReconcileOutcome = "COMPLETED" | "FAILED" | "PENDING" | "SKIPPED";

export async function reconcilePayment(paymentId: string, opts: { force?: boolean } = {}): Promise<ReconcileOutcome> {
  if (!mpesaConfigured()) return "SKIPPED";
  if (inFlight.has(paymentId)) return "PENDING";

  let payment: PaymentLike | null = null;
  try {
    payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  } catch (e) {
    console.warn("[payments] reconciliation lookup failed:", (e as Error)?.message || e);
    return "PENDING";
  }

  if (!payment) return "SKIPPED";
  // Report the authoritative state to callers that are deciding whether a retry
  // is safe; a completed payment must never be replaced by a new checkout.
  if (payment.status === "COMPLETED") return "COMPLETED";
  if (payment.status === "FAILED") return "FAILED";
  if (payment.status !== "PENDING") return "SKIPPED";

  // Do not keep asking Daraja about a checkout that is older than any real STK
  // prompt could live. Returning PENDING also keeps the retry guard conservative.
  if (Date.now() - new Date(payment.createdAt).getTime() > MAX_RECONCILE_AGE_MS) return "PENDING";

  const checkoutId = payment.transactionId?.startsWith(PAYMENT_PENDING_PREFIX)
    ? payment.transactionId.slice(PAYMENT_PENDING_PREFIX.length)
    : null;
  if (!checkoutId) return "SKIPPED";

  const last = lastQueriedAt.get(paymentId) || 0;
  if (!opts.force && Date.now() - last < QUERY_THROTTLE_MS) return "PENDING";

  inFlight.add(paymentId);
  lastQueriedAt.set(paymentId, Date.now());
  try {
    const query = await withQuerySlot(() => stkQuery(checkoutId));
    if (query.state === "SUCCESS") {
      const done = await completePayment(payment, query.receipt, query.amount, "reconciler");
      return done ? "COMPLETED" : "SKIPPED";
    }
    if (query.state === "FAILED") {
      await failPayment(payment, query.resultCode, query.resultDesc, "reconciler");
      return "FAILED";
    }
    return "PENDING";
  } catch (e) {
    // A transient Daraja error must not fail a real payment; the next sweep
    // will ask again.
    console.warn(`[payments] reconciliation query failed for payment ${payment.id}: ${(e as Error)?.message || e}`);
    return "PENDING";
  } finally {
    inFlight.delete(paymentId);
  }
}

let sweeping = false;

export async function runPaymentReconciliation(): Promise<{ checked: number; completed: number; failed: number; pending: number }> {
  if (!mpesaConfigured()) return { checked: 0, completed: 0, failed: 0, pending: 0 };
  // A slow query must not let interval ticks stack into overlapping sweeps.
  if (sweeping) return { checked: 0, completed: 0, failed: 0, pending: 0 };
  sweeping = true;
  try {
    const cutoff = new Date(Date.now() - MIN_PAYMENT_AGE_MS);
    const oldest = new Date(Date.now() - MAX_RECONCILE_AGE_MS);
    const pending = await prisma.payment.findMany({
      where: {
        status: "PENDING",
        transactionId: { startsWith: PAYMENT_PENDING_PREFIX },
        createdAt: { gte: oldest },
        OR: [
          { attemptedAt: { lte: cutoff } },
          { attemptedAt: null, createdAt: { lte: cutoff } },
        ],
      },
      orderBy: { createdAt: "asc" },
      take: 20,
    });

    let completed = 0;
    let failed = 0;
    let stillPending = 0;
    for (const payment of pending) {
      const outcome = await reconcilePayment(payment.id);
      if (outcome === "COMPLETED") completed++;
      else if (outcome === "FAILED") failed++;
      else if (outcome === "PENDING") stillPending++;
    }
    return { checked: pending.length, completed, failed, pending: stillPending };
  } finally {
    sweeping = false;
  }
}

let timer: NodeJS.Timeout | null = null;

export function startPaymentReconciler(): void {
  if (timer) return;
  if (!mpesaConfigured()) {
    console.log("[payments] reconciler idle: M-Pesa is not configured");
    return;
  }
  const tick = () => {
    runPaymentReconciliation()
      .then((result) => {
        if (result.checked > 0) {
          console.log(
            `[payments] reconciliation: checked=${result.checked} completed=${result.completed} ` +
            `failed=${result.failed} pending=${result.pending}`
          );
        }
      })
      .catch((e) => console.warn("[payments] reconciliation sweep failed:", (e as Error)?.message || e));
  };
  // Give startup DB work a head start, then sweep once a minute.
  setTimeout(tick, 30_000).unref();
  timer = setInterval(tick, SWEEP_INTERVAL_MS);
  timer.unref();
  console.log(`[payments] reconciler started (every ${SWEEP_INTERVAL_MS / 1000}s)`);
}
