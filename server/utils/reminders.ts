// Automated guest reminders for confirmed reservations.
//
// A sweep runs every 15 minutes and sends two kinds of reminders:
//   REMINDER_48H      — check-in is tomorrow (roughly 24–48 hours ahead)
//   REMINDER_SAME_DAY — check-in is today
//
// Delivery uses the same SMTP / Africa's Talking channels as booking
// confirmations, with console logging when no provider is configured. Each sent
// reminder is recorded in the AuditLog so a guest never receives the same stage
// twice — even across server restarts. None of this ever throws: a delivery
// failure must not affect reservations.
import { prisma, dbState } from "./prisma";
import { sendMail, reminderEmail } from "./mailer";
import { sendSms } from "./africastalking";
import { logAudit } from "../middleware/auth";

const STAGE_48H = "REMINDER_48H";
const STAGE_SAME_DAY = "REMINDER_SAME_DAY";
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

// Booking dates are stored as UTC midnight, so compare calendar strings in the
// property's timezone (Africa/Nairobi) rather than local server time.
function calendarDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function nairobiToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function addDays(dateString: string, days: number): string {
  const d = new Date(`${dateString}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return calendarDate(d);
}

async function alreadySent(reservationId: string, action: string): Promise<boolean> {
  const existing = await prisma.auditLog.findFirst({
    where: { action, entityType: "Reservation", entityId: reservationId },
    select: { id: true },
  });
  return Boolean(existing);
}

async function deliverReminder(reservationId: string, stage: "48H" | "SAME_DAY") {
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: { service: true, client: true, confirmation: true },
  });
  if (!reservation?.confirmation) return false;
  if (reservation.status !== "CONFIRMED") return false;

  const code = reservation.confirmation.confirmationCode;
  const guestName = reservation.client?.fullName || "Guest";
  const checkIn = calendarDate(reservation.checkInDate);
  const checkOut = calendarDate(reservation.checkOutDate);
  const when = stage === "SAME_DAY" ? "today" : "tomorrow";
  const serviceName = reservation.service?.name || "Boma stay";
  const email = String(reservation.client?.email || "");
  const deliverableEmail = email && !email.startsWith("guest-");
  const phone = reservation.client?.phoneNumber || "";

  let emailed = false;
  let texted = false;
  if (deliverableEmail) {
    const mail = reminderEmail({ guestName, code, serviceName, checkIn, checkOut, guests: reservation.numberOfGuests, when });
    await sendMail({ to: email, ...mail }).catch((e) => console.warn("[reminders] email failed:", (e as Error)?.message || e));
    emailed = true;
  }
  if (phone) {
    const sms = `Boma reminder: booking ${code} (${serviceName}) starts ${when}, ${checkIn}. Free cancellation up to 48h before check-in. Call the reservations desk to change it.`;
    await sendSms(phone, sms).catch((e) => console.warn("[reminders] SMS failed:", (e as Error)?.message || e));
    texted = true;
  }

  // Record the stage only after the delivery attempt, so a crash between send
  // and audit can at worst repeat a reminder rather than silently skip one.
  await logAudit(
    null,
    stage === "SAME_DAY" ? STAGE_SAME_DAY : STAGE_48H,
    "Reservation",
    reservationId,
    JSON.stringify({ emailed, texted, checkIn, code }),
    "scheduler",
    "boma-reminder-scheduler"
  );
  console.log(`[reminders] ${stage === "SAME_DAY" ? "same-day" : "48h"} reminder for ${code} (email=${emailed}, sms=${texted})`);
  return true;
}

export async function runReminderSweep(now = new Date()): Promise<{ sent: number; skipped?: string }> {
  if (!dbState.ready) return { sent: 0, skipped: "database-down" };
  const today = nairobiToday(now);
  const tomorrow = addDays(today, 1);

  // Stage 1: check-in tomorrow → 24–48h ahead.
  const upcoming = await prisma.reservation.findMany({
    where: { status: "CONFIRMED", checkInDate: new Date(`${tomorrow}T00:00:00.000Z`) },
    select: { id: true },
  });
  let sent = 0;
  for (const { id } of upcoming) {
    if (await alreadySent(id, STAGE_48H)) continue;
    if (await deliverReminder(id, "48H")) sent++;
  }

  // Stage 2: check-in today → same-day ping.
  const sameDay = await prisma.reservation.findMany({
    where: { status: "CONFIRMED", checkInDate: new Date(`${today}T00:00:00.000Z`) },
    select: { id: true },
  });
  for (const { id } of sameDay) {
    if (await alreadySent(id, STAGE_SAME_DAY)) continue;
    if (await deliverReminder(id, "SAME_DAY")) sent++;
  }

  return { sent };
}

let timer: NodeJS.Timeout | null = null;

export function startReminderScheduler(): void {
  if (timer) return;
  const tick = () => {
    runReminderSweep().catch((e) => console.warn("[reminders] sweep failed:", (e as Error)?.message || e));
  };
  // Delay the first sweep so it never competes with startup DB work.
  setTimeout(tick, 60 * 1000).unref();
  timer = setInterval(tick, SWEEP_INTERVAL_MS);
  timer.unref();
  console.log(`[reminders] scheduler started (every ${SWEEP_INTERVAL_MS / 60000} minutes)`);
}
