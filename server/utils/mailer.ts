// Email delivery for booking confirmations and password resets.
// Configure SMTP_* env vars for real delivery (SMTP_HOST, SMTP_PORT, SMTP_USER,
// SMTP_PASS, SMTP_FROM, SMTP_SECURE). Without SMTP_HOST every message is logged
// to the server console instead — useful for development, never silent.
import nodemailer from "nodemailer";

export type MailResult = { mode: "smtp" | "log"; messageId?: string };

const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";
const FROM = process.env.SMTP_FROM || "Boma <no-reply@boma.local>";

function transport() {
  if (!process.env.SMTP_HOST) return null;
  const port = Number(process.env.SMTP_PORT || 587);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === "true" || port === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}

export function mailerMode(): "smtp" | "log" {
  return process.env.SMTP_HOST ? "smtp" : "log";
}

export async function sendMail(mail: { to: string; subject: string; html: string; text?: string }): Promise<MailResult> {
  const t = transport();
  if (!t) {
    console.log(`[mail:log] To: ${mail.to} | Subject: ${mail.subject}\n${mail.text || mail.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()}\n`);
    return { mode: "log" };
  }
  const info = await t.sendMail({ from: FROM, ...mail });
  return { mode: "smtp", messageId: info.messageId };
}

const shell = (content: string) => `
<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:560px;margin:auto;background:#0F172A;color:#E2E8F0;border-radius:14px;overflow:hidden">
  <div style="padding:18px 24px;background:#0F172A;border-bottom:1px solid #1E293B">
    <div style="font-size:20px;font-weight:700;color:#FFFFFF;letter-spacing:.3px">Boma</div>
    <div style="font-size:12px;color:#2563EB;text-transform:uppercase;letter-spacing:2px">Online Reservation</div>
  </div>
  <div style="padding:24px;background:#FFFFFF;color:#0F172A">${content}</div>
  <div style="padding:14px 24px;font-size:11px;color:#94A3B8;background:#0F172A">Boma · Reservations desk · reply to this email to reach the lodge</div>
</div>`;

export function confirmationEmail(input: { guestName: string; code: string; serviceName: string; checkIn: string; checkOut: string; total: number; currency?: string }) {
  const currency = input.currency || "KES";
  const total = Number(input.total || 0).toLocaleString();
  const html = shell(`
    <h2 style="margin:0 0 12px">Your booking is confirmed</h2>
    <p style="margin:0 0 12px">Hi ${escapeHtml(input.guestName)},</p>
    <p style="margin:0 0 16px">Thank you for booking with Boma. Keep this email as proof of reservation.</p>
    <div style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:12px;padding:16px;margin:16px 0;text-align:center">
      <div style="font-size:12px;color:#475569;text-transform:uppercase;letter-spacing:1px">Confirmation code</div>
      <div style="font-size:32px;font-weight:800;color:#1D4ED8;letter-spacing:4px;margin-top:6px">${escapeHtml(input.code)}</div>
    </div>
    <table style="width:100%;font-size:14px;border-collapse:collapse">
      <tr><td style="padding:6px 0;color:#475569">Service</td><td style="padding:6px 0;text-align:right;font-weight:600">${escapeHtml(input.serviceName)}</td></tr>
      <tr><td style="padding:6px 0;color:#475569">Dates</td><td style="padding:6px 0;text-align:right">${escapeHtml(input.checkIn)} → ${escapeHtml(input.checkOut)}</td></tr>
      <tr><td style="padding:6px 0;color:#475569">Total</td><td style="padding:6px 0;text-align:right;font-weight:600">${currency} ${total}</td></tr>
    </table>
    <p style="margin:16px 0 0"><a href="${CLIENT_URL}/client" style="display:inline-block;background:#2563EB;color:#FFFFFF;padding:10px 18px;border-radius:8px;text-decoration:none">View my bookings</a></p>
  `);
  const text = `Boma — booking confirmed\nCode: ${input.code}\nService: ${input.serviceName}\nDates: ${input.checkIn} to ${input.checkOut}\nTotal: ${currency} ${total}`;
  return { subject: `Boma confirmation ${input.code}`, html, text };
}

export function paymentReceiptEmail(input: {
  guestName: string;
  code: string;
  serviceName: string;
  receipt: string;
  amount: number;
  total: number;
  balance: number;
  currency?: string;
  reservationStatus?: string | null;
}) {
  const currency = input.currency || "KES";
  const money = (value: number) => Number(value || 0).toLocaleString();
  const status = String(input.reservationStatus || "");
  const note = status === "CANCELLED"
    ? "This booking is cancelled. Our reservations team will review the payment and contact you about a refund."
    : status === "FLAGGED_DUPLICATE"
      ? "This booking is flagged as a possible duplicate. Our reservations team will review the payment and contact you."
      : "Your reservation is confirmed. Keep this receipt for your records.";
  const html = shell(`
    <h2 style="margin:0 0 12px">Payment received</h2>
    <p style="margin:0 0 12px">Hi ${escapeHtml(input.guestName)},</p>
    <p style="margin:0 0 16px">We have received your M-Pesa payment for booking <strong>${escapeHtml(input.code)}</strong>.</p>
    <div style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:12px;padding:16px;margin:16px 0;text-align:center">
      <div style="font-size:12px;color:#475569;text-transform:uppercase;letter-spacing:1px">M-Pesa receipt</div>
      <div style="font-size:26px;font-weight:800;color:#1D4ED8;letter-spacing:2px;margin-top:6px">${escapeHtml(input.receipt)}</div>
    </div>
    <table style="width:100%;font-size:14px;border-collapse:collapse">
      <tr><td style="padding:6px 0;color:#475569">Service</td><td style="padding:6px 0;text-align:right;font-weight:600">${escapeHtml(input.serviceName)}</td></tr>
      <tr><td style="padding:6px 0;color:#475569">Amount paid</td><td style="padding:6px 0;text-align:right;font-weight:600">${currency} ${money(input.amount)}</td></tr>
      <tr><td style="padding:6px 0;color:#475569">Booking total</td><td style="padding:6px 0;text-align:right">${currency} ${money(input.total)}</td></tr>
      <tr><td style="padding:6px 0;color:#475569">Balance</td><td style="padding:6px 0;text-align:right">${currency} ${money(input.balance)}</td></tr>
    </table>
    <p style="margin:16px 0 0;font-size:13px;color:#475569">${escapeHtml(note)}</p>
    <p style="margin:12px 0 0"><a href="${CLIENT_URL}/client" style="display:inline-block;background:#2563EB;color:#FFFFFF;padding:10px 18px;border-radius:8px;text-decoration:none">View my bookings</a></p>
  `);
  const text = `Boma — payment received\nReceipt: ${input.receipt}\nBooking: ${input.code}\nService: ${input.serviceName}\nAmount paid: ${currency} ${money(input.amount)}\nBooking total: ${currency} ${money(input.total)}\nBalance: ${currency} ${money(input.balance)}\n${note}`;
  return { subject: `Boma payment receipt ${input.receipt}`, html, text };
}

export function reminderEmail(input: { guestName: string; code: string; serviceName: string; checkIn: string; checkOut: string; guests: number; when: string }) {
  const html = shell(`
    <h2 style="margin:0 0 12px">Reminder: your Boma booking is ${escapeHtml(input.when)}</h2>
    <p style="margin:0 0 12px">Hi ${escapeHtml(input.guestName)},</p>
    <p style="margin:0 0 16px">This is a friendly reminder about your upcoming reservation. Here are the details you will need at check-in.</p>
    <div style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:12px;padding:16px;margin:16px 0;text-align:center">
      <div style="font-size:12px;color:#475569;text-transform:uppercase;letter-spacing:1px">Confirmation code</div>
      <div style="font-size:32px;font-weight:800;color:#1D4ED8;letter-spacing:4px;margin-top:6px">${escapeHtml(input.code)}</div>
    </div>
    <table style="width:100%;font-size:14px;border-collapse:collapse">
      <tr><td style="padding:6px 0;color:#475569">Service</td><td style="padding:6px 0;text-align:right;font-weight:600">${escapeHtml(input.serviceName)}</td></tr>
      <tr><td style="padding:6px 0;color:#475569">Check-in</td><td style="padding:6px 0;text-align:right">${escapeHtml(input.checkIn)}</td></tr>
      <tr><td style="padding:6px 0;color:#475569">Check-out</td><td style="padding:6px 0;text-align:right">${escapeHtml(input.checkOut)}</td></tr>
      <tr><td style="padding:6px 0;color:#475569">Guests</td><td style="padding:6px 0;text-align:right">${input.guests}</td></tr>
    </table>
    <p style="margin:16px 0 0;font-size:13px;color:#475569">Need to change or cancel? Free cancellation applies up to 48 hours before check-in; later cancellations may forfeit the deposit. Contact the reservations desk as early as possible.</p>
    <p style="margin:12px 0 0"><a href="${CLIENT_URL}/client" style="display:inline-block;background:#2563EB;color:#FFFFFF;padding:10px 18px;border-radius:8px;text-decoration:none">View my bookings</a></p>
  `);
  const text = `Boma reminder — your booking ${input.code} is ${input.when}\nService: ${input.serviceName}\nCheck-in: ${input.checkIn}\nCheck-out: ${input.checkOut}\nGuests: ${input.guests}\nFree cancellation up to 48 hours before check-in.`;
  return { subject: `Boma reminder — ${input.code} is ${input.when}`, html, text };
}

export function passwordResetEmail(input: { name: string; token: string }) {
  const link = `${CLIENT_URL}/reset-password?token=${encodeURIComponent(input.token)}`;
  const html = shell(`
    <h2 style="margin:0 0 12px">Reset your password</h2>
    <p style="margin:0 0 12px">Hi ${escapeHtml(input.name)},</p>
    <p style="margin:0 0 16px">Use the button below within 1 hour to set a new password. If you did not request this, ignore this email.</p>
    <p style="margin:16px 0"><a href="${link}" style="display:inline-block;background:#2563EB;color:#FFFFFF;padding:10px 18px;border-radius:8px;text-decoration:none">Choose a new password</a></p>
    <p style="margin:0 0 8px;font-size:13px;color:#475569">Or paste this link into your browser:</p>
    <p style="margin:0 0 0;font-size:12px;color:#475569;word-break:break-all">${escapeHtml(link)}</p>
  `);
  const text = `Boma — password reset\n${link}\nThis link expires in 1 hour.`;
  return { subject: "Reset your Boma password", html, text };
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" } as Record<string, string>)[c]);
}
