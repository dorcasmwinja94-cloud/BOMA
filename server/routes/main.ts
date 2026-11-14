import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { AuthReq, authenticate, requireRole, logAudit } from "../middleware/auth";
import { prisma, dbState } from "../utils/prisma";
import { hashPassword, verifyPassword } from "../utils/auth";
import jwt from "jsonwebtoken";
const { v4: uuidv4 } = require("uuid") as { v4: () => string };
import { sendMail, confirmationEmail, passwordResetEmail, mailerMode } from "../utils/mailer";
import { sendSms } from "../utils/africastalking";
import { mpesaConfigured, stkPush, normalizeKenyanPhone, MPESA_ENV, MPESA_SANDBOX } from "../utils/mpesa";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "secret";
const MAX_LOGIN_ATTEMPTS = Number(process.env.MAX_LOGIN_ATTEMPTS || 5);
const LOCKOUT_MINUTES = Number(process.env.LOCKOUT_MINUTES || 15);
const ROLES = ["MANAGER", "RESERVATION_OFFICER", "CLIENT"];
const RESERVATION_STATUSES = ["PENDING", "CONFIRMED", "CANCELLED", "FLAGGED_DUPLICATE"];
const SYNC_STATUSES = ["SYNCED", "PENDING_RETRY", "FAILED"];

const USER_SELECT = {
  id: true,
  fullName: true,
  email: true,
  role: true,
  isActive: true,
  failedLoginAttempts: true,
  lockedUntil: true,
  createdAt: true,
  updatedAt: true,
  client: { select: { id: true, phoneNumber: true, address: true } },
} as const;

function parseDate(value: unknown): Date | null {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function nightsBetween(checkIn: Date, checkOut: Date): number {
  return Math.max(1, Math.ceil((checkOut.getTime() - checkIn.getTime()) / 86400000));
}

// ACCOMMODATION is priced per night, TOUR per guest, TRANSPORT per booking.
// -------- NOTIFICATIONS --------
// Emails and texts booking confirmations and updates delivery tracking on the
// confirmation row. Never throws â€” a delivery failure must not undo a booking.
async function sendReservationConfirmation(reservationId: string) {
  const full = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: { service: true, client: true, confirmation: true },
  });
  if (!full?.confirmation) return;
  const code = full.confirmation.confirmationCode;
  const guestName = full.client?.fullName || "Guest";
  const checkIn = full.checkInDate.toISOString().slice(0, 10);
  const checkOut = full.checkOutDate.toISOString().slice(0, 10);
  const placeholder = String(full.client?.email || "").startsWith("guest-");
  const summary = `${full.service?.name || "Boma stay"} Â· ${checkIn} to ${checkOut} Â· Confirmation ${code}`;
  try {
    if (full.client?.email && !placeholder) {
      const mail = confirmationEmail({ guestName, code, serviceName: full.service?.name || "Boma stay", checkIn, checkOut, total: full.totalAmount });
      await sendMail({ to: full.client.email, ...mail });
    } else {
      console.log(`[mail:log] No deliverable email for reservation ${reservationId} â€” confirmation ${code} stored for in-person delivery.`);
    }
    if (full.client?.phoneNumber) {
      await sendSms(full.client.phoneNumber, `Boma: booking confirmed. Code ${code}. ${summary}. We look forward to welcoming you.`);
    }
    await prisma.confirmation.update({ where: { id: full.confirmation.id }, data: { deliveryStatus: "SENT", updatedAt: new Date() } });
  } catch (e) {
    console.warn("[notify] confirmation delivery failed:", (e as Error)?.message || e);
    await prisma.confirmation.update({ where: { id: full.confirmation.id }, data: { deliveryStatus: "FAILED", updatedAt: new Date() } }).catch(() => {});
  }
}

// System principal for guest bookings from the public site. Reservation.createdById
// is a required FK to User, so public bookings are attributed to a deliberately
// non-authenticating account ("Boma Public Website") instead of a demo login.
let publicActorId: string | null = null;
async function getPublicActorId(): Promise<string> {
  if (publicActorId) return publicActorId;
  const existing = await prisma.user.findUnique({ where: { email: "public@boma.local" } });
  if (existing) { publicActorId = existing.id; return existing.id; }
  const created = await prisma.user.create({
    data: { fullName: "Boma Public Website", email: "public@boma.local", passwordHash: `disabled-${uuidv4()}${uuidv4()}`, role: "CLIENT" },
  });
  publicActorId = created.id;
  return created.id;
}

// Shared M-Pesa STK logic for authenticated and public initiation. Returns a
// discriminated union: on failure `status`/`body` should be sent as-is; on
// success `body` is the 202 payload and `checkoutRequestId` is available for audit.
async function attemptStk(reservation: any, phoneInput: string) {
  const phone = normalizeKenyanPhone(String(phoneInput || ""));
  if (!phone) return { ok: false as const, status: 400 as const, body: { error: "A valid Kenyan M-Pesa phone number is required (e.g. 07XXXXXXXX)." } };
  if (reservation.status === "CANCELLED") {
    return { ok: false as const, status: 409 as const, body: { error: "This reservation is cancelled. Please create a new booking to pay.", code: "RESERVATION_CANCELLED" } };
  }
  // Never overwrite an active checkout: a retry while a prompt is outstanding
  // would replace the first checkout ID, so its success callback could no
  // longer be matched. Prompts expire after roughly three minutes.
  const existingPayment = Array.isArray(reservation.payments) ? reservation.payments[0] : null;
  if (existingPayment?.status === "COMPLETED") {
    return { ok: false as const, status: 409 as const, body: { error: "This reservation is already paid.", code: "MPESA_ALREADY_PAID", receipt: existingPayment.transactionId } };
  }
  if (existingPayment?.status === "PENDING") {
    const lastAttempt = existingPayment.attemptedAt || existingPayment.createdAt;
    const ageMs = Date.now() - new Date(lastAttempt).getTime();
    if (Number.isFinite(ageMs) && ageMs < 3 * 60 * 1000) {
      return {
        ok: false as const,
        status: 409 as const,
        body: {
          error: "An M-Pesa payment request is already in progress for this booking. Check your phone for the prompt; if it did not arrive, wait a moment and try again.",
          code: "MPESA_PENDING",
          retryAfterSeconds: Math.max(1, Math.ceil((3 * 60 * 1000 - ageMs) / 1000)),
        },
      };
    }
  }
  if (!mpesaConfigured()) {
    console.warn(`[mpesa] initiation rejected â€” missing env: ${MPESA_ENV.filter((k) => !process.env[k]).join(", ") || "unknown"}`);
    return { ok: false as const, status: 503 as const, body: { error: "M-Pesa payments are not configured on this server yet. Your reservation is saved â€” please pay at the front desk on arrival.", code: "MPESA_NOT_CONFIGURED" } };
  }
  // Upfront deposit: MPESA_DEPOSIT_PERCENT may be set to e.g. 30 so guests pay a
  // deposit instead of the full amount. Defaults to 100 (full payment).
  const totalAmount = Math.max(1, Math.round(Number(reservation.totalAmount) || 0));
  const depositPercent = Math.min(100, Math.max(1, Math.round(Number(process.env.MPESA_DEPOSIT_PERCENT || 100)) || 100));
  const amount = Math.max(1, Math.round((totalAmount * depositPercent) / 100));
  try {
    const stk = await stkPush({ phone, amount, accountReference: reservation.id.slice(0, 12), description: `Boma ${reservation.id.slice(0, 6)}` });
    const pendingRef = `MPESA-PENDING-${stk.checkoutRequestId}`;
    await prisma.payment.upsert({
      where: { reservationId: reservation.id },
      create: { reservationId: reservation.id, method: "MPESA", transactionId: pendingRef, amount, currency: "KES", status: "PENDING", attemptedAt: new Date() },
      update: { method: "MPESA", transactionId: pendingRef, amount, status: "PENDING", paidAt: null, attemptedAt: new Date() },
    });
    return { ok: true as const, amount, phone, checkoutRequestId: stk.checkoutRequestId, body: { status: "PENDING", message: stk.customerMessage, amount, totalAmount, depositPercent, phone, sandbox: MPESA_SANDBOX } };
  } catch (e) {
    console.error("[mpesa] STK push error:", (e as Error)?.message || e);
    return { ok: false as const, status: 502 as const, body: { error: `M-Pesa could not be reached right now. Please try again or pay at the front desk. (${(e as Error)?.message?.slice(0, 200) || "upstream error"})` } };
  }
}

// Atomically checks for duplicates and creates the reservation, its
// confirmation code and its initial sync record inside one serializable
// transaction, so two simultaneous requests cannot both claim the same slot
// (classic check-then-insert race) and a booking can never be committed without
// the confirmation Objective III requires. Serialization conflicts (P2034) and
// the rare confirmation-code collision (P2002) are retried.
async function createReservationAtomic(data: any, duplicateWhere: any) {
  // P2034 = serialization/deadlock conflict, P2002 = confirmation-code collision,
  // P2028/P1017 = the pooler dropped the connection mid-transaction. All are safe
  // to retry: if a prior attempt actually committed, the fresh duplicate check
  // returns the existing booking instead of creating a second one.
  const RETRYABLE = new Set(["P2034", "P2002", "P2028", "P1017"]);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const duplicate = await tx.reservation.findFirst({ where: duplicateWhere });
        if (duplicate) return { duplicate, reservation: null as any, code: null as any };
        const reservation = await tx.reservation.create({ data });
        const code = await nextConfirmationCode(tx);
        await tx.confirmation.create({
          data: {
            reservationId: reservation.id,
            confirmationCode: code,
            deliveryStatus: "PENDING",
            payloadJson: JSON.stringify({ code, reservationId: reservation.id }),
          },
        });
        await tx.syncLog.create({
          data: { reservationId: reservation.id, status: "PENDING_RETRY", retryCount: 0, errorMessage: null },
        });
        return { duplicate: null as any, reservation, code };
      }, { isolationLevel: "Serializable" });
    } catch (e: any) {
      if (RETRYABLE.has(e?.code) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  throw new Error("Reservation transaction failed after retry");
}

function calculateTotal(service: { serviceType: string; pricePerUnit: number }, checkIn: Date, checkOut: Date, guests: number): number {
  if (service.serviceType === "ACCOMMODATION") {
    return Math.round(service.pricePerUnit * nightsBetween(checkIn, checkOut));
  }
  if (service.serviceType === "TOUR") {
    return Math.round(service.pricePerUnit * Math.max(1, guests));
  }
  return Math.round(service.pricePerUnit);
}

async function nextConfirmationCode(db: any = prisma): Promise<string> {
  for (let i = 0; i < 25; i++) {
    const code = `Boma-${Math.floor(1000 + Math.random() * 9000)}`;
    const existing = await db.confirmation.findUnique({ where: { confirmationCode: code } });
    if (!existing) return code;
  }
  return `Boma-${Date.now().toString().slice(-6)}`;
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n");
}

// Brute-force protection: cap login attempts per IP as well as per account.
const loginLimiter = rateLimit({
  windowMs: LOCKOUT_MINUTES * 60 * 1000,
  limit: 25,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many login attempts from this IP. Please try again later." },
});

// -------- AUTH --------
router.post("/auth/login", loginLimiter, async (req: Request, res: Response) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  const user = await prisma.user.findUnique({ where: { email } });

  // Do not reveal whether the account exists.
  if (!user || !user.isActive) {
    return res.status(401).json({ error: "Invalid email or password." });
  }

  const now = new Date();

  // Still locked? Report how long is left without touching the counter.
  if (user.lockedUntil && user.lockedUntil > now) {
    const retryAfter = Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 1000);
    return res.status(423).json({
      error: `Account locked after too many failed attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
      retryAfter,
      locked: true,
    });
  }

  // An expired lock starts a fresh run of attempts.
  const previousAttempts = user.lockedUntil ? 0 : user.failedLoginAttempts;

  if (!verifyPassword(password, user.passwordHash)) {
    const attempts = previousAttempts + 1;

    if (attempts >= MAX_LOGIN_ATTEMPTS) {
      const lockedUntil = new Date(now.getTime() + LOCKOUT_MINUTES * 60 * 1000);
      await prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: attempts, lockedUntil },
      });
      await logAudit(user.id, "LOGIN_FAILED", "User", user.id, JSON.stringify({ attempts }), req.ip || "", req.headers["user-agent"] || "");
      await logAudit(user.id, "ACCOUNT_LOCKED", "User", user.id, JSON.stringify({ lockedUntil, attempts }), req.ip || "", req.headers["user-agent"] || "");
      return res.status(423).json({
        error: `Account locked after ${MAX_LOGIN_ATTEMPTS} failed attempts. Try again in ${LOCKOUT_MINUTES} minute(s).`,
        retryAfter: LOCKOUT_MINUTES * 60,
        locked: true,
      });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: attempts, lockedUntil: null },
    });
    await logAudit(user.id, "LOGIN_FAILED", "User", user.id, JSON.stringify({ attempts }), req.ip || "", req.headers["user-agent"] || "");
    return res.status(401).json({
      error: "Invalid email or password.",
      remainingAttempts: MAX_LOGIN_ATTEMPTS - attempts,
    });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginAttempts: 0, lockedUntil: null },
  });
  await logAudit(user.id, "LOGIN", "User", user.id, null, req.ip || "", req.headers["user-agent"] || "");
  const token = jwt.sign({ id: user.id, email: user.email, role: user.role, fullName: user.fullName }, JWT_SECRET, { expiresIn: "8h" });
  res.json({ token, user: { id: user.id, fullName: user.fullName, email: user.email, role: user.role } });
});

router.get("/auth/me", authenticate, (req: AuthReq, res: Response) => {
  res.json({ user: req.user });
});

// -------- USERS (MANAGER ONLY) --------
router.get("/users", authenticate, requireRole(["MANAGER"]), async (req: AuthReq, res: Response) => {
  const users = await prisma.user.findMany({ select: USER_SELECT, orderBy: { createdAt: "asc" } });
  res.json(users);
});

router.post("/users", authenticate, requireRole(["MANAGER"]), async (req: AuthReq, res: Response) => {
  const { fullName, password, phoneNumber, address } = req.body;
  const role = String(req.body?.role || "");
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!fullName || !email || !role) return res.status(400).json({ error: "Name, email and role are required." });
  if (!ROLES.includes(role)) return res.status(400).json({ error: "Invalid user role." });
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: "A user with that email already exists." });
  const hash = hashPassword(password || "Client@123");
  const user = await prisma.user.create({
    data: { fullName, email, passwordHash: hash, role: role as any, isActive: true, failedLoginAttempts: 0, lockedUntil: null },
  });
  if (role === "CLIENT") {
    await prisma.client.create({
      data: {
        userId: user.id,
        fullName,
        email,
        phoneNumber: String(phoneNumber || ""),
        address: address || null,
      },
    });
  }
  await logAudit(req.user!.id, "CREATE", "User", user.id, JSON.stringify({ ...req.body, password: undefined }), req.ip || "", req.headers["user-agent"] || "");
  const created = await prisma.user.findUnique({ where: { id: user.id }, select: USER_SELECT });
  res.status(201).json(created);
});

router.put("/users/:id", authenticate, requireRole(["MANAGER"]), async (req: AuthReq, res: Response) => {
  const id = req.params.id;
  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: "User not found." });

  const { fullName, password, phoneNumber, address } = req.body;
  const role = req.body?.role === undefined ? existing.role : String(req.body.role);
  const email = req.body?.email === undefined ? existing.email : String(req.body.email).trim().toLowerCase();
  const isActive = req.body?.isActive === undefined ? existing.isActive : Boolean(req.body.isActive);

  if (role && !ROLES.includes(role)) return res.status(400).json({ error: "Invalid user role." });
  if (!email) return res.status(400).json({ error: "Email is required." });
  if (id === req.user!.id && (!isActive || role !== "MANAGER")) {
    return res.status(400).json({ error: "You cannot deactivate or change the role of your own account." });
  }
  const duplicate = await prisma.user.findFirst({ where: { email, id: { not: id } } });
  if (duplicate) return res.status(409).json({ error: "A user with that email already exists." });

  const data: any = { email, role, isActive };
  if (fullName) data.fullName = String(fullName);
  if (password) data.passwordHash = hashPassword(String(password));
  if (isActive && existing.lockedUntil) {
    data.failedLoginAttempts = 0;
    data.lockedUntil = null;
  }
  const updated = await prisma.user.update({ where: { id }, data, select: USER_SELECT });

  if (role === "CLIENT") {
    const client = await prisma.client.findFirst({ where: { userId: id } });
    if (client) {
      await prisma.client.update({
        where: { id: client.id },
        data: {
          fullName: data.fullName || existing.fullName,
          email,
          ...(phoneNumber !== undefined ? { phoneNumber: String(phoneNumber) } : {}),
          ...(address !== undefined ? { address: address || null } : {}),
        },
      });
    } else {
      await prisma.client.create({
        data: {
          userId: id,
          fullName: data.fullName || existing.fullName,
          email,
          phoneNumber: String(phoneNumber || ""),
          address: address || null,
        },
      });
    }
  }

  await logAudit(req.user!.id, "UPDATE", "User", id, JSON.stringify({ ...req.body, password: password ? "reset" : undefined }), req.ip || "", req.headers["user-agent"] || "");
  res.json(updated);
});

router.post("/users/:id/reset-password", authenticate, requireRole(["MANAGER"]), async (req: AuthReq, res: Response) => {
  const id = req.params.id;
  const password = String(req.body?.password || "");
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) return res.status(404).json({ error: "User not found." });
  await prisma.user.update({
    where: { id },
    data: { passwordHash: hashPassword(password), failedLoginAttempts: 0, lockedUntil: null },
  });
  await logAudit(req.user!.id, "RESET_PASSWORD", "User", id, null, req.ip || "", req.headers["user-agent"] || "");
  res.json({ message: "Password reset successfully." });
});

// -------- CLIENTS --------
router.get("/clients", authenticate, requireRole(["MANAGER", "RESERVATION_OFFICER"]), async (req: AuthReq, res: Response) => {
  const clients = await prisma.client.findMany({ orderBy: { fullName: "asc" } });
  res.json(clients);
});

router.post("/clients", authenticate, requireRole(["MANAGER", "RESERVATION_OFFICER"]), async (req: AuthReq, res: Response) => {
  const { fullName, email, phoneNumber, address, userId } = req.body;
  if (!fullName || !email) return res.status(400).json({ error: "Full name and email are required." });
  const client = await prisma.client.create({ data: { fullName, email, phoneNumber: phoneNumber || "", address, userId } });
  await logAudit(req.user!.id, "CREATE", "Client", client.id, JSON.stringify(req.body), req.ip || "", req.headers["user-agent"] || "");
  res.status(201).json(client);
});

// -------- SERVICES --------
router.get("/services", async (req: Request, res: Response) => {
  const services = await prisma.service.findMany({ where: { isActive: true } });
  res.json(services);
});

// -------- RESERVATIONS --------
router.get("/reservations", authenticate, async (req: AuthReq, res: Response) => {
  const { role, id } = req.user!;
  let where: any = {};
  if (role === "CLIENT") {
    const client = await prisma.client.findFirst({ where: { userId: id } });
    if (!client) return res.json([]);
    where.clientId = client.id;
  }
  const reservations = await prisma.reservation.findMany({
    where,
    include: { client: true, service: true, confirmation: true, syncLogs: true, payments: true },
    orderBy: { createdAt: "desc" },
  });
  res.json(reservations);
});

router.get("/reservations/:id", authenticate, async (req: AuthReq, res: Response) => {
  const resObj = await prisma.reservation.findUnique({
    where: { id: req.params.id },
    include: { client: true, service: true, confirmation: true, syncLogs: true, createdBy: true },
  });
  if (!resObj) return res.status(404).json({ error: "Not found" });
  if (req.user!.role === "CLIENT") {
    const client = await prisma.client.findFirst({ where: { userId: req.user!.id } });
    if (!client || resObj.clientId !== client.id) return res.status(403).json({ error: "Forbidden" });
  }
  res.json(resObj);
});

router.post("/reservations", authenticate, async (req: AuthReq, res: Response) => {
  const { serviceId, notes } = req.body;
  const checkInDate = parseDate(req.body.checkInDate);
  const checkOutDate = parseDate(req.body.checkOutDate);
  const numberOfGuests = Number(req.body.numberOfGuests || 0);
  if (!serviceId || !checkInDate || !checkOutDate) {
    return res.status(400).json({ error: "Service, check-in date and check-out date are required." });
  }
  if (checkOutDate < checkInDate) {
    return res.status(400).json({ error: "Check-out date cannot be before check-in date." });
  }
  if (!Number.isInteger(numberOfGuests) || numberOfGuests < 1) {
    return res.status(400).json({ error: "Number of guests must be at least 1." });
  }

  const service = await prisma.service.findUnique({ where: { id: serviceId } });
  if (!service || !service.isActive) return res.status(404).json({ error: "Service not found or inactive." });
  if (numberOfGuests > service.capacity) {
    return res.status(400).json({ error: `${service.name} accepts a maximum of ${service.capacity} guests.` });
  }

  let clientId = req.body.clientId;
  if (req.user!.role === "CLIENT") {
    let client = await prisma.client.findFirst({ where: { userId: req.user!.id } });
    if (!client) {
      client = await prisma.client.create({
        data: { userId: req.user!.id, fullName: req.user!.fullName, email: req.user!.email, phoneNumber: "" },
      });
    }
    clientId = client.id;
  }
  if (!clientId) return res.status(400).json({ error: "Client is required." });
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client) return res.status(404).json({ error: "Client not found." });

  // Atomically re-check for duplicates and create the reservation.
  const totalAmount = calculateTotal(service, checkInDate, checkOutDate, numberOfGuests);
  const { duplicate, reservation, code } = await createReservationAtomic(
    {
      clientId,
      serviceId,
      createdById: req.user!.id,
      checkInDate,
      checkOutDate,
      numberOfGuests,
      totalAmount,
      status: "PENDING",
      syncStatus: "PENDING_RETRY",
      version: 1,
      notes: notes || null,
    },
    { clientId, serviceId, checkInDate, checkOutDate, status: { not: "CANCELLED" } }
  );
  if (duplicate) {
    return res.status(409).json({
      error: "Duplicate active reservation",
      flagged: true,
      message: "An active reservation already exists for the same client, service and dates.",
      existingId: duplicate.id,
      link: `/reservations/${duplicate.id}`,
    });
  }

  sendReservationConfirmation(reservation.id).catch((e) => console.warn("[notify] confirmation dispatch failed:", e?.message || e));

  await logAudit(req.user!.id, "CREATE", "Reservation", reservation.id, JSON.stringify({ ...req.body, totalAmount }), req.ip || "", req.headers["user-agent"] || "");
  res.status(201).json({ ...reservation, confirmationCode: code, flaggedDuplicate: false });
});

router.put("/reservations/:id", authenticate, async (req: AuthReq, res: Response) => {
  const id = req.params.id;
  const existing = await prisma.reservation.findUnique({ where: { id }, include: { service: true } });
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (req.user!.role === "CLIENT") {
    return res.status(403).json({ error: "Clients must use the reschedule or cancel actions." });
  }

  const version = Number(req.body.version);
  if (!Number.isInteger(version)) return res.status(400).json({ error: "A version number is required for updates." });
  if (version !== existing.version) {
    await logAudit(req.user!.id, "UPDATE", "Reservation", id, JSON.stringify({ error: "Version mismatch", expected: existing.version, got: version }), req.ip || "", req.headers["user-agent"] || "");
    return res.status(409).json({ error: "Version conflict - this reservation was changed by another user. Refresh and try again.", currentVersion: existing.version });
  }

  const data: any = {};
  const nextCheckIn = req.body.checkInDate === undefined ? existing.checkInDate : parseDate(req.body.checkInDate);
  const nextCheckOut = req.body.checkOutDate === undefined ? existing.checkOutDate : parseDate(req.body.checkOutDate);
  const nextGuests = req.body.numberOfGuests === undefined ? existing.numberOfGuests : Number(req.body.numberOfGuests);
  if (!nextCheckIn || !nextCheckOut) return res.status(400).json({ error: "Check-in and check-out dates must be valid." });
  if (nextCheckOut < nextCheckIn) return res.status(400).json({ error: "Check-out date cannot be before check-in date." });
  if (!Number.isInteger(nextGuests) || nextGuests < 1) return res.status(400).json({ error: "Number of guests must be at least 1." });
  if (nextGuests > existing.service.capacity) return res.status(400).json({ error: `This service accepts a maximum of ${existing.service.capacity} guests.` });

  const datesChanged = req.body.checkInDate !== undefined || req.body.checkOutDate !== undefined || req.body.numberOfGuests !== undefined;
  if (req.body.checkInDate !== undefined) data.checkInDate = nextCheckIn;
  if (req.body.checkOutDate !== undefined) data.checkOutDate = nextCheckOut;
  if (req.body.numberOfGuests !== undefined) data.numberOfGuests = nextGuests;
  if (datesChanged) data.totalAmount = calculateTotal(existing.service, nextCheckIn, nextCheckOut, nextGuests);
  if (req.body.notes !== undefined) data.notes = req.body.notes || null;
  if (req.body.status !== undefined) {
    if (!RESERVATION_STATUSES.includes(String(req.body.status))) return res.status(400).json({ error: "Invalid reservation status." });
    data.status = req.body.status;
  }
  if (req.body.syncStatus !== undefined) {
    if (!SYNC_STATUSES.includes(String(req.body.syncStatus))) return res.status(400).json({ error: "Invalid sync status." });
    data.syncStatus = req.body.syncStatus;
  }
  if (Object.keys(data).length === 0) return res.status(400).json({ error: "No editable reservation fields were supplied." });

  const updated = await prisma.reservation.update({
    where: { id },
    data: { ...data, version: { increment: 1 } },
    include: { client: true, service: true, confirmation: true, syncLogs: true, payments: true },
  });
  await logAudit(req.user!.id, "UPDATE", "Reservation", id, JSON.stringify(req.body), req.ip || "", req.headers["user-agent"] || "");
  res.json(updated);
});

router.post("/reservations/:id/cancel", authenticate, async (req: AuthReq, res: Response) => {
  const id = req.params.id;
  const existing = await prisma.reservation.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (req.user!.role === "CLIENT") {
    const client = await prisma.client.findFirst({ where: { userId: req.user!.id } });
    if (!client || existing.clientId !== client.id) return res.status(403).json({ error: "Forbidden" });
  }
  if (existing.status === "CANCELLED") return res.status(400).json({ error: "This reservation is already cancelled." });
  const updated = await prisma.reservation.update({
    where: { id },
    data: { status: "CANCELLED", version: { increment: 1 } },
    include: { client: true, service: true, confirmation: true, syncLogs: true, payments: true },
  });
  await logAudit(req.user!.id, "CANCEL", "Reservation", id, null, req.ip || "", req.headers["user-agent"] || "");
  res.json(updated);
});

// -------- CONFIRMATIONS --------
router.get("/confirmations", authenticate, async (req: AuthReq, res: Response) => {
  const { role, id } = req.user!;
  let where: any = {};
  if (role === "CLIENT") {
    const client = await prisma.client.findFirst({ where: { userId: id } });
    if (client) {
      const resIds = (await prisma.reservation.findMany({ where: { clientId: client.id }, select: { id: true } })).map(r => r.id);
      where.reservationId = { in: resIds };
    }
  }
  const confirmations = await prisma.confirmation.findMany({ where, include: { reservation: { include: { client: true, service: true } } } });
  res.json(confirmations);
});

router.get("/confirmations/search", authenticate, async (req: AuthReq, res: Response) => {
  const q = (req.query.q as string) || "";
  let clientId: string | null = null;
  if (req.user!.role === "CLIENT") {
    const client = await prisma.client.findFirst({ where: { userId: req.user!.id } });
    if (!client) return res.json([]);
    clientId = client.id;
  }
  const byCode = await prisma.confirmation.findUnique({ where: { confirmationCode: q }, include: { reservation: { include: { client: true, service: true } } } });
  if (byCode) {
    if (clientId && byCode.reservation.clientId !== clientId) return res.json([]);
    return res.json([byCode]);
  }
  const clients = await prisma.client.findMany({
    where: { ...(clientId ? { id: clientId } : {}), OR: [{ fullName: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }] },
  });
  const clientIds = clients.map(c => c.id);
  const confirmations = await prisma.confirmation.findMany({
    where: { reservation: { clientId: { in: clientIds } } },
    include: { reservation: { include: { client: true, service: true } } },
  });
  res.json(confirmations);
});

router.post("/confirmations/:id/resend", authenticate, async (req: AuthReq, res: Response) => {
  const confirmation = await prisma.confirmation.findUnique({
    where: { id: req.params.id },
    include: { reservation: true },
  });
  if (!confirmation) return res.status(404).json({ error: "Not found" });
  if (req.user!.role === "CLIENT") {
    const client = await prisma.client.findFirst({ where: { userId: req.user!.id } });
    if (!client || confirmation.reservation.clientId !== client.id) return res.status(403).json({ error: "Forbidden" });
  }
  // Actually deliver the confirmation (email + SMS) and record the outcome.
  await sendReservationConfirmation(confirmation.reservationId);
  const updated = await prisma.confirmation.findUnique({ where: { id: confirmation.id } });
  await logAudit(req.user!.id, "RESEND_CONFIRMATION", "Confirmation", confirmation.id, null, req.ip || "", req.headers["user-agent"] || "");
  res.json(updated);
});

// -------- SYNC LOGS --------
router.get("/sync-logs", authenticate, requireRole(["MANAGER", "RESERVATION_OFFICER"]), async (req: AuthReq, res: Response) => {
  const logs = await prisma.syncLog.findMany({ include: { reservation: { include: { client: true, service: true } } }, orderBy: { attemptedAt: "desc" } });
  res.json(logs);
});

router.post("/sync-logs/retry", authenticate, requireRole(["MANAGER", "RESERVATION_OFFICER"]), async (req: AuthReq, res: Response) => {
  const reservationId = String(req.body?.reservationId || "");
  const reservation = await prisma.reservation.findUnique({ where: { id: reservationId } });
  if (!reservation) return res.status(404).json({ error: "Reservation not found." });

  const now = new Date();
  const log = await prisma.syncLog.create({
    data: { reservationId, status: "SYNCED", retryCount: 1, errorMessage: null, attemptedAt: now, lastSyncedAt: now },
  });
  await prisma.syncLog.updateMany({
    where: { reservationId, id: { not: log.id }, status: { not: "SYNCED" } },
    data: { status: "SYNCED", errorMessage: null, lastSyncedAt: now },
  });
  await prisma.reservation.update({ where: { id: reservationId }, data: { syncStatus: "SYNCED" } });
  await logAudit(req.user!.id, "SYNC_RETRY", "SyncLog", log.id, JSON.stringify({ reservationId, result: "SYNCED" }), req.ip || "", req.headers["user-agent"] || "");
  res.json(log);
});

router.post("/sync-logs/retry/:id", authenticate, requireRole(["MANAGER", "RESERVATION_OFFICER"]), async (req: AuthReq, res: Response) => {
  const log = await prisma.syncLog.findUnique({ where: { id: req.params.id } });
  if (!log) return res.status(404).json({ error: "Sync log not found." });
  if (log.status === "SYNCED") return res.status(400).json({ error: "This sync attempt has already completed successfully." });

  const now = new Date();
  const updated = await prisma.syncLog.update({
    where: { id: log.id },
    data: { status: "SYNCED", retryCount: log.retryCount + 1, attemptedAt: now, lastSyncedAt: now, errorMessage: null },
  });
  await prisma.reservation.update({ where: { id: log.reservationId }, data: { syncStatus: "SYNCED" } });
  await logAudit(req.user!.id, "SYNC_RETRY", "SyncLog", log.id, JSON.stringify({ result: "SYNCED" }), req.ip || "", req.headers["user-agent"] || "");
  res.json(updated);
});

// -------- AUDIT LOGS --------
router.get("/audit-logs", authenticate, requireRole(["MANAGER", "RESERVATION_OFFICER"]), async (req: AuthReq, res: Response) => {
  const logs = await prisma.auditLog.findMany({
    include: { user: { select: { id: true, fullName: true, email: true, role: true } } },
    orderBy: { timestamp: "desc" },
    take: 200,
  });
  res.json(logs);
});

// -------- REPORTS --------
router.get("/reports", authenticate, requireRole(["MANAGER"]), async (req: AuthReq, res: Response) => {
  const reports = await prisma.report.findMany({
    include: { generatedBy: { select: { fullName: true, email: true } } },
    orderBy: { generatedAt: "desc" },
  });
  res.json(reports);
});

router.post("/reports", authenticate, requireRole(["MANAGER"]), async (req: AuthReq, res: Response) => {
  const reportType = String(req.body?.reportType || "RESERVATIONS").toUpperCase();
  if (!["RESERVATIONS", "REVENUE", "OCCUPANCY"].includes(reportType)) {
    return res.status(400).json({ error: "Report type must be RESERVATIONS, REVENUE or OCCUPANCY." });
  }
  const filtersJson = JSON.stringify({
    from: req.body?.from || "",
    to: req.body?.to || "",
  });
  const report = await prisma.report.create({
    data: { generatedById: req.user!.id, reportType, filtersJson, status: "COMPLETED", fileUrl: null },
  });
  await prisma.report.update({
    where: { id: report.id },
    data: { fileUrl: `/api/reports/${report.id}/export` },
  });
  await logAudit(req.user!.id, "GENERATE_REPORT", "Report", report.id, filtersJson, req.ip || "", req.headers["user-agent"] || "");
  const created = await prisma.report.findUnique({
    where: { id: report.id },
    include: { generatedBy: { select: { fullName: true, email: true } } },
  });
  res.status(201).json(created);
});

router.get("/reports/:id/export", authenticate, requireRole(["MANAGER"]), async (req: AuthReq, res: Response) => {
  const report = await prisma.report.findUnique({ where: { id: req.params.id } });
  if (!report) return res.status(404).json({ error: "Report not found." });

  let filters: any = {};
  try { filters = JSON.parse(report.filtersJson || "{}"); } catch { filters = {}; }
  const dateFilter: any = {};
  if (filters.from) {
    const from = parseDate(filters.from);
    if (from) dateFilter.gte = from;
  }
  if (filters.to) {
    const to = parseDate(filters.to);
    if (to) {
      to.setHours(23, 59, 59, 999);
      dateFilter.lte = to;
    }
  }

  const reservations = await prisma.reservation.findMany({
    where: Object.keys(dateFilter).length ? { checkInDate: dateFilter } : {},
    include: { client: true, service: true, confirmation: true },
    orderBy: { checkInDate: "asc" },
  });

  const fmtDate = (value: Date | string | null | undefined) => value ? new Date(value).toISOString().slice(0, 10) : "";
  let headers: string[] = [];
  let rows: unknown[][] = [];

  if (report.reportType === "RESERVATIONS") {
    headers = ["Reservation", "Client", "Email", "Service", "Type", "Check-in", "Check-out", "Guests", "Amount (KES)", "Status", "Sync", "Confirmation", "Created"];
    rows = reservations.map(r => [
      r.id, r.client.fullName, r.client.email, r.service.name, r.service.serviceType,
      fmtDate(r.checkInDate), fmtDate(r.checkOutDate), r.numberOfGuests, r.totalAmount,
      r.status, r.syncStatus, r.confirmation?.confirmationCode || "", fmtDate(r.createdAt),
    ]);
  } else {
    const active = reservations.filter(r => r.status !== "CANCELLED");
    const groups = new Map<string, { name: string; type: string; capacity: number; bookings: number; guests: number; revenue: number }>();
    for (const r of active) {
      const current = groups.get(r.serviceId) || {
        name: r.service.name, type: r.service.serviceType, capacity: r.service.capacity,
        bookings: 0, guests: 0, revenue: 0,
      };
      current.bookings += 1;
      current.guests += r.numberOfGuests;
      current.revenue += r.totalAmount;
      groups.set(r.serviceId, current);
    }
    if (report.reportType === "REVENUE") {
      headers = ["Service", "Type", "Bookings", "Guests", "Revenue (KES)"];
      rows = Array.from(groups.values()).map(g => [g.name, g.type, g.bookings, g.guests, Math.round(g.revenue)]);
    } else {
      headers = ["Service", "Type", "Capacity", "Bookings", "Guests", "Revenue (KES)"];
      rows = Array.from(groups.values()).map(g => [g.name, g.type, g.capacity, g.bookings, g.guests, Math.round(g.revenue)]);
    }
  }

  const csv = toCsv(headers, rows);
  const filename = `Boma-${report.reportType.toLowerCase()}-${report.id}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  await logAudit(req.user!.id, "DOWNLOAD_REPORT", "Report", report.id, null, req.ip || "", req.headers["user-agent"] || "");
  res.send("\uFEFF" + csv);
});

// -------- MANAGER DASHBOARD STATS --------
router.get("/dashboard/summary", authenticate, requireRole(["MANAGER"]), async (req: AuthReq, res: Response) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const totalToday = await prisma.reservation.count({ where: { createdAt: { gte: today } } });
  const confirmed = await prisma.reservation.count({ where: { status: "CONFIRMED" } });
  const pending = await prisma.reservation.count({ where: { status: "PENDING" } });
  const flagged = await prisma.reservation.count({ where: { status: "FLAGGED_DUPLICATE" } });
  const revenue = await prisma.reservation.aggregate({ _sum: { totalAmount: true }, where: { status: "CONFIRMED" } });
  const occupancy = await prisma.service.aggregate({ _sum: { capacity: true }, _count: { id: true } });
  res.json({ totalToday, confirmed, pending, flagged, revenue: revenue._sum.totalAmount || 0, occupancy });
});

// -------- INDUSTRY UPGRADES --------
router.get("/payments", authenticate, requireRole(["MANAGER", "RESERVATION_OFFICER"]), async (req: AuthReq, res: Response) => {
  const payments = await (prisma as any).payment?.findMany?.({ include: { reservation: true } }) || [];
  res.json(payments);
});
// Payment initiation requires M-Pesa (Daraja) credentials in the environment â€”
// the server never fabricates a completed payment. Without them initiation is
// rejected honestly with 503 so staff can fall back to confirming on arrival.
router.post("/payments/mpesa/initiate", authenticate, async (req: AuthReq, res: Response) => {
  const reservationId = String(req.body?.reservationId || "");
  if (!reservationId) return res.status(400).json({ error: "reservationId is required." });
  const reservation = await prisma.reservation.findUnique({ where: { id: reservationId }, include: { client: true, service: true, payments: true } });
  if (!reservation) return res.status(404).json({ error: "Reservation not found." });
  if (req.user!.role === "CLIENT") {
    const owned = await prisma.client.findFirst({ where: { userId: req.user!.id } });
    if (!owned || reservation.clientId !== owned.id) return res.status(403).json({ error: "You can only pay for your own reservations." });
  }
  const existing = reservation.payments?.[0];
  if (existing?.status === "COMPLETED") return res.status(409).json({ error: "This reservation is already paid.", receipt: existing.transactionId });

  const attempt = await attemptStk(reservation, String(req.body?.phone || reservation.client?.phoneNumber || ""));
  if (!attempt.ok) return res.status(attempt.status).json(attempt.body);
  await logAudit(req.user!.id, "MPESA_INITIATE", "Payment", reservation.id, JSON.stringify({ phone: attempt.phone, amount: attempt.amount, checkoutRequestId: attempt.checkoutRequestId }), req.ip || "", req.headers["user-agent"] || "");
  res.status(202).json(attempt.body);
});

// Public initiation for guests who booked without an account. The booking's
// confirmation code is the bearer secret alongside the unguessable reservation UUID.
router.post("/public/payments/mpesa/initiate", async (req: Request, res: Response) => {
  const reservationId = String(req.body?.reservationId || "");
  const confirmationCode = String(req.body?.confirmationCode || "").trim();
  if (!reservationId || !confirmationCode) return res.status(400).json({ error: "reservationId and confirmationCode are required." });
  const reservation = await prisma.reservation.findUnique({ where: { id: reservationId }, include: { client: true, payments: true, confirmation: true } });
  if (!reservation || reservation.confirmation?.confirmationCode !== confirmationCode) return res.status(404).json({ error: "Reservation not found." });
  const existing = reservation.payments?.[0];
  if (existing?.status === "COMPLETED") return res.status(409).json({ error: "This reservation is already paid." });

  const attempt = await attemptStk(reservation, String(req.body?.phone || reservation.client?.phoneNumber || ""));
  if (!attempt.ok) return res.status(attempt.status).json(attempt.body);
  await logAudit(null, "MPESA_PUBLIC_INITIATE", "Payment", reservation.id, JSON.stringify({ phone: attempt.phone, amount: attempt.amount, checkoutRequestId: attempt.checkoutRequestId }), req.ip || "", req.headers["user-agent"] || "");
  res.status(202).json(attempt.body);
});

// Public payment status poll â€” same bearer pair as public initiation.
router.get("/public/payments/status/:reservationId", async (req: Request, res: Response) => {
  const confirmationCode = String(req.query.code || "").trim();
  const reservation = await prisma.reservation.findUnique({ where: { id: req.params.reservationId }, include: { confirmation: true } });
  if (!reservation || reservation.confirmation?.confirmationCode !== confirmationCode) return res.status(404).json({ error: "Reservation not found." });
  const payment = await prisma.payment.findUnique({ where: { reservationId: reservation.id } });
  if (!payment) return res.json({ status: "NONE" });
  res.json({ status: payment.status, method: payment.method, amount: payment.amount, currency: payment.currency, receipt: payment.status === "COMPLETED" ? payment.transactionId : null, paidAt: payment.paidAt });
});

// Safaricom Daraja calls this endpoint (publicly, no auth) with the outcome of
// the STK prompt. Always answer 200 to avoid retry storms; unknown callbacks are
// logged and accepted. On success the reservation is auto-confirmed.
router.post("/payments/mpesa/callback", async (req: Request, res: Response) => {
  const ack = () => res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  try {
    const cb = req.body?.Body?.stkCallback;
    if (!cb?.CheckoutRequestID) { console.warn("[mpesa] callback without CheckoutRequestID:", JSON.stringify(req.body)?.slice(0, 300)); return ack(); }
    const pendingRef = `MPESA-PENDING-${cb.CheckoutRequestID}`;
    const payment = await prisma.payment.findFirst({ where: { transactionId: pendingRef }, include: { reservation: true } });
    if (!payment) { console.warn(`[mpesa] callback for unknown payment ${pendingRef} â€” acknowledging without action.`); return ack(); }
    if (payment.status === "COMPLETED") return ack(); // idempotent
    if (payment.status === "REFUNDED") { console.warn(`[mpesa] callback for refunded payment ${pendingRef} — ignored.`); return ack(); }
    if (Number(cb.ResultCode) === 0) {
      const items: any[] = cb.CallbackMetadata?.Item || [];
      const meta = (name: string) => items.find((i) => i?.Name === name)?.Value;
      const receipt = String(meta("MpesaReceiptNumber") || "").trim();
      const paidAmount = Number(meta("Amount"));
      // Never mark a payment complete without Safaricom's receipt. If the
      // callback is malformed, return 500 so Safaricom retries instead of
      // silently losing a real payment.
      if (!receipt) {
        console.error(`[mpesa] success callback without a receipt for ${pendingRef} — asking Safaricom to retry.`);
        return res.status(500).json({ ResultCode: 1, ResultDesc: "Missing receipt, retry" });
      }
      if (Number.isFinite(paidAmount) && paidAmount + 0.5 < Number(payment.amount)) {
        console.error(`[mpesa] amount mismatch for ${pendingRef}: expected ${payment.amount}, got ${paidAmount}`);
        return res.status(500).json({ ResultCode: 1, ResultDesc: "Amount mismatch, retry" });
      }
      // Payment and reservation confirmation must commit together; otherwise a
      // guest could be charged while the booking stays PENDING.
      const completed = await prisma.$transaction(async (tx) => {
        const changed = await tx.payment.updateMany({
          where: { id: payment.id, status: { in: ["PENDING", "FAILED"] } },
          data: { status: "COMPLETED", transactionId: receipt, paidAt: new Date(), amount: Number.isFinite(paidAmount) && paidAmount > 0 ? paidAmount : payment.amount },
        });
        if (changed.count === 0) return false;
        await tx.reservation.update({ where: { id: payment.reservationId }, data: { status: "CONFIRMED", version: { increment: 1 } } });
        return true;
      });
      if (!completed) { console.warn(`[mpesa] duplicate callback for ${pendingRef} — already processed.`); return ack(); }
      try {
        await logAudit(null, "MPESA_PAYMENT_COMPLETE", "Payment", payment.reservationId, JSON.stringify({ receipt, amount: meta("Amount") }), req.ip || "", req.headers["user-agent"] || "");
      } catch (e) {
        console.error("[mpesa] payment completed but audit log failed:", (e as Error)?.message || e);
      }
      console.log(`[mpesa] payment COMPLETED for reservation ${payment.reservationId} receipt ${receipt}`);
    } else {
      const failed = await prisma.payment.updateMany({ where: { id: payment.id, status: "PENDING" }, data: { status: "FAILED" } });
      if (failed.count > 0) {
        try {
          await logAudit(null, "MPESA_PAYMENT_FAILED", "Payment", payment.reservationId, JSON.stringify({ resultCode: cb.ResultCode, resultDesc: cb.ResultDesc }), req.ip || "", req.headers["user-agent"] || "");
        } catch (e) {
          console.error("[mpesa] failed payment but audit log failed:", (e as Error)?.message || e);
        }
        console.warn(`[mpesa] payment FAILED for reservation ${payment.reservationId}: ${cb.ResultCode} ${cb.ResultDesc || ""}`);
      }
    }
  } catch (e) {
    console.error("[mpesa] callback processing error:", (e as Error)?.message || e);
    // A 5xx makes Safaricom retry; a 200 here would discard a real payment.
    return res.status(500).json({ ResultCode: 1, ResultDesc: "Processing error, retry" });
  }
  return ack();
});

// Reservation owner (CLIENT) or staff can poll payment status â€” used by the
// client portal after STK push and after returning from the PIN prompt.
router.get("/payments/status/:reservationId", authenticate, async (req: AuthReq, res: Response) => {
  const { reservationId } = req.params;
  if (req.user!.role === "CLIENT") {
    const reservation = await prisma.reservation.findUnique({ where: { id: reservationId } });
    if (!reservation) return res.status(404).json({ error: "Reservation not found." });
    const owned = await prisma.client.findFirst({ where: { userId: req.user!.id } });
    if (!owned || reservation.clientId !== owned.id) return res.status(403).json({ error: "Not your reservation." });
  }
  const payment = await prisma.payment.findUnique({ where: { reservationId } });
  if (!payment) return res.json({ status: "NONE" });
  res.json({ status: payment.status, method: payment.method, amount: payment.amount, currency: payment.currency, receipt: payment.status === "COMPLETED" ? payment.transactionId : null, paidAt: payment.paidAt });
});

// Staff-only refund (records the refund against the completed payment).
router.post("/payments/:id/refund", authenticate, requireRole(["MANAGER", "RESERVATION_OFFICER"]), async (req: AuthReq, res: Response) => {
  const payment = await prisma.payment.findUnique({ where: { id: req.params.id } });
  if (!payment) return res.status(404).json({ error: "Payment not found." });
  if (payment.status !== "COMPLETED") return res.status(409).json({ error: "Only completed payments can be refunded." });
  const updated = await prisma.payment.update({ where: { id: payment.id }, data: { status: "REFUNDED" } });
  await logAudit(req.user!.id, "MPESA_REFUND", "Payment", payment.id, JSON.stringify({ amount: payment.amount, reservationId: payment.reservationId }), req.ip || "", req.headers["user-agent"] || "");
  res.json({ status: updated.status, id: updated.id });
});
router.get("/confirmations/:id/qr", authenticate, async (req: AuthReq, res: Response) => {
  const conf = await prisma.confirmation.findUnique({ where: { id: req.params.id }, include: { reservation: { include: { client: true, service: true } } } });
  if (!conf) return res.status(404).json({ error: "Not found" });
  res.json({ qrData: `Boma|${conf.confirmationCode}|${conf.reservation.id}|${conf.reservation.client?.fullName || ""}`, code: conf.confirmationCode, reservationId: conf.reservationId, url: `/api/qr/${conf.id}` });
});
router.post("/reservations/:id/reschedule", authenticate, async (req: AuthReq, res: Response) => {
  const id = req.params.id;
  const existing = await prisma.reservation.findUnique({ where: { id }, include: { service: true } });
  if (!existing) return res.status(404).json({ error: "Reservation not found." });
  if (req.user!.role === "CLIENT") {
    const client = await prisma.client.findFirst({ where: { userId: req.user!.id } });
    if (!client || existing.clientId !== client.id) return res.status(403).json({ error: "Forbidden" });
  }
  if (existing.status === "CANCELLED") return res.status(400).json({ error: "A cancelled reservation cannot be rescheduled." });
  const version = Number(req.body.version);
  if (!Number.isInteger(version)) return res.status(400).json({ error: "A version number is required for rescheduling." });
  if (version !== existing.version) {
    return res.status(409).json({ error: "Version conflict - this reservation was changed elsewhere. Refresh and try again.", currentVersion: existing.version });
  }
  const checkInDate = parseDate(req.body.checkInDate);
  const checkOutDate = parseDate(req.body.checkOutDate);
  if (!checkInDate || !checkOutDate) return res.status(400).json({ error: "Valid check-in and check-out dates are required." });
  if (checkOutDate < checkInDate) return res.status(400).json({ error: "Check-out date cannot be before check-in date." });
  const totalAmount = calculateTotal(existing.service, checkInDate, checkOutDate, existing.numberOfGuests);
  const updated = await prisma.reservation.update({
    where: { id },
    data: { checkInDate, checkOutDate, totalAmount, version: { increment: 1 }, updatedAt: new Date() },
    include: { client: true, service: true, confirmation: true, syncLogs: true, payments: true },
  });
  await logAudit(req.user!.id, "RESCHEDULE", "Reservation", id, JSON.stringify(req.body), req.ip || "", req.headers["user-agent"] || "");
  res.json(updated);
});
router.post("/reservations/:id/cancel-self", authenticate, async (req: AuthReq, res: Response) => {
  const id = req.params.id;
  const existing = await prisma.reservation.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: "Reservation not found." });
  if (req.user!.role === "CLIENT") {
    const client = await prisma.client.findFirst({ where: { userId: req.user!.id } });
    if (!client || existing.clientId !== client.id) return res.status(403).json({ error: "Forbidden" });
  }
  if (existing.status === "CANCELLED") return res.status(400).json({ error: "This reservation is already cancelled." });
  const updated = await prisma.reservation.update({
    where: { id },
    data: { status: "CANCELLED", version: { increment: 1 } },
    include: { client: true, service: true, confirmation: true, syncLogs: true, payments: true },
  });
  await logAudit(req.user!.id, "CANCEL_SELF", "Reservation", id, null, req.ip || "", req.headers["user-agent"] || "");
  res.json(updated);
});

// -------- PUBLIC SERVICE CATALOG --------
const SERVICE_FALLBACK = [
  { id: "fallback-airport-transfer", name: "Airport Transfer", description: "Private round-trip transfer between JKIA and your hotel. Professional driver, 24/7 availability.", imageUrl: "https://images.unsplash.com/photo-1494515843206-f3117d3f51b7?w=800&q=80&auto=format&fit=crop", images: ["https://images.unsplash.com/photo-1494515843206-f3117d3f51b7?w=800&q=80&auto=format&fit=crop"], pricePerUnit: 45, serviceType: "TRANSPORT", capacity: 6, location: "Nairobi (JKIA)" },
  { id: "fallback-conference-hall", name: "Conference Hall", description: "Fully equipped conference hall with projector, sound system and Wi-Fi. Seats up to 50 guests theatre-style.", imageUrl: "https://images.unsplash.com/photo-1524178232363-1fb2b075b655?w=800&q=80&auto=format&fit=crop", images: ["https://images.unsplash.com/photo-1524178232363-1fb2b075b655?w=800&q=80&auto=format&fit=crop"], pricePerUnit: 500, serviceType: "ACCOMMODATION", capacity: 50, location: "Mombasa" },
  { id: "fallback-deluxe-room", name: "Deluxe Hotel Room", description: "Spacious air-conditioned room with king-sized bed, Wi-Fi, satellite TV and en-suite bathroom. Breakfast included.", imageUrl: "https://images.unsplash.com/photo-1571896349842-33c89424de2d?w=800&q=80&auto=format&fit=crop", images: ["https://images.unsplash.com/photo-1571896349842-33c89424de2d?w=800&q=80&auto=format&fit=crop"], pricePerUnit: 120, serviceType: "ACCOMMODATION", capacity: 4, location: "Nairobi" },
  { id: "fallback-diani-beach", name: "Diani Beach Excursion", description: "Half-day excursion to Diani Beach with snorkeling and lunch at a beachfront restaurant.", imageUrl: "https://images.unsplash.com/photo-1519046904884-53103b34b206?w=800&q=80&auto=format&fit=crop", images: ["https://images.unsplash.com/photo-1519046904884-53103b34b206?w=800&q=80&auto=format&fit=crop"], pricePerUnit: 80, serviceType: "TOUR", capacity: 20, location: "Diani Beach, Kwale" },
  { id: "fallback-maasai-mara", name: "Maasai Mara Safari", description: "Full-day guided safari in the Maasai Mara National Reserve. Game drives, packed lunch and transfers included.", imageUrl: "https://images.unsplash.com/photo-1547471080-7cc2caa01a7e?w=800&q=80&auto=format&fit=crop", images: ["https://images.unsplash.com/photo-1547471080-7cc2caa01a7e?w=800&q=80&auto=format&fit=crop"], pricePerUnit: 350, serviceType: "TOUR", capacity: 12, location: "Maasai Mara National Reserve" },
];
let servicesCache: any[] | null = null;

router.get("/public/services", async (req: Request, res: Response) => {
  if (dbState.ready) {
    try {
      const services = await prisma.service.findMany({
        where: { isActive: true },
        orderBy: { name: "asc" },
        select: {
          id: true, name: true, description: true, imageUrl: true, images: true,
          pricePerUnit: true, serviceType: true, capacity: true, location: true,
        },
      });
      servicesCache = services;
      return res.json(services);
    } catch (e) {
      console.warn("[public/services] DB query failed, serving fallback:", (e as Error)?.message || e);
    }
  }
  // Degraded path: serve the last good response, else a static fallback list.
  res.setHeader("X-Source", "fallback");
  res.json(servicesCache || SERVICE_FALLBACK);
});

// -------- PUBLIC SELF-REGISTRATION --------
router.post("/public/register", async (req: Request, res: Response) => {
  const { fullName, email, password, phoneNumber, address } = req.body || {};
  if (!fullName || !email || !password) {
    return res.status(400).json({ error: "Full name, email and password are required." });
  }
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });
  const normalizedEmail = String(email).trim().toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existing) return res.status(409).json({ error: "A user with that email already exists." });

  const hash = hashPassword(password);
  const user = await prisma.user.create({
    data: { fullName, email: normalizedEmail, passwordHash: hash, role: "CLIENT", isActive: true, failedLoginAttempts: 0, lockedUntil: null },
  });
  await prisma.client.create({
    data: {
      userId: user.id, fullName, email: normalizedEmail,
      phoneNumber: String(phoneNumber || ""), address: address || null,
      isGuest: true,
    },
  });
  await logAudit(null, "CREATE", "Client", user.id, JSON.stringify({ fullName, email: normalizedEmail }), req.ip || "", req.headers["user-agent"] || "");
  res.status(201).json({ message: "Account created successfully. You can now sign in." });
});

// -------- PUBLIC PASSWORD RESET --------
router.post("/public/password-reset-request", async (req: Request, res: Response) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: "Email is required." });
  const normalizedEmail = String(email).trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (!user) {
    return res.json({ message: "If an account exists for this email, a reset link has been sent." });
  }
  const token = uuidv4();
  const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordResetToken: token, passwordResetExpires: expires },
  });
  await logAudit(user.id, "PASSWORD_RESET_REQUEST", "User", user.id, null, req.ip || "", req.headers["user-agent"] || "");
  const response: any = { message: "If an account exists for this email, a reset link has been sent." };
  try {
    const mail = passwordResetEmail({ name: user.fullName || user.email, token });
    const result = await sendMail({ to: user.email, ...mail });
    if (result.mode === "log") response.devToken = token; // no SMTP configured â€” surface the token for development only
  } catch (e) {
    console.warn("[notify] password reset email failed:", (e as Error)?.message || e);
    if (mailerMode() === "log") response.devToken = token;
  }
  res.json(response);
});

router.post("/public/password-reset", async (req: Request, res: Response) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: "Reset token and new password are required." });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });

  const user = await prisma.user.findFirst({
    where: { passwordResetToken: token, passwordResetExpires: { gt: new Date() } },
  });
  if (!user) return res.status(400).json({ error: "Invalid or expired reset token." });

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: hashPassword(password), passwordResetToken: null, passwordResetExpires: null, failedLoginAttempts: 0, lockedUntil: null },
  });
  await logAudit(user.id, "PASSWORD_RESET", "User", user.id, null, req.ip || "", req.headers["user-agent"] || "");
  res.json({ message: "Password reset successfully. You can now sign in with your new password." });
});

// -------- PUBLIC BOOKING PATH (guest or logged-in) --------
router.post("/public/reservations", async (req: Request, res: Response) => {
  const { serviceId, checkInDate, checkOutDate, numberOfGuests, notes, fullName, email, phoneNumber } = req.body || {};
  const ci = parseDate(checkInDate);
  const co = parseDate(checkOutDate);
  const guests = Number(numberOfGuests || 0);
  if (!serviceId || !ci || !co) return res.status(400).json({ error: "Service, check-in date and check-out date are required." });
  if (co < ci) return res.status(400).json({ error: "Check-out date cannot be before check-in date." });
  if (!Number.isInteger(guests) || guests < 1) return res.status(400).json({ error: "Number of guests must be at least 1." });

  const service = await prisma.service.findUnique({ where: { id: serviceId } });
  if (!service || !service.isActive) return res.status(404).json({ error: "Service not found or inactive." });
  if (guests > service.capacity) return res.status(400).json({ error: `${service.name} accepts a maximum of ${service.capacity} guests.` });

  let clientId: string;
  if (email) {
    const normalizedEmail = String(email).trim().toLowerCase();
    let client = await prisma.client.findFirst({ where: { email: normalizedEmail } });
    if (!client) {
      client = await prisma.client.create({
        data: { fullName: fullName || normalizedEmail, email: normalizedEmail, phoneNumber: phoneNumber || "", address: null, isGuest: true },
      });
    }
    clientId = client.id;
  } else {
    const client = await prisma.client.create({
      data: { fullName: fullName || "Guest", email: `guest-${uuidv4().slice(0, 8)}@boma.local`, phoneNumber: phoneNumber || "", address: null, isGuest: true },
    });
    clientId = client.id;
  }

  const totalAmount = calculateTotal(service, ci, co, guests);
  const publicActor = await getPublicActorId();
  const { duplicate, reservation, code } = await createReservationAtomic(
    { clientId, serviceId, createdById: publicActor, checkInDate: ci, checkOutDate: co, numberOfGuests: guests, totalAmount, status: "PENDING", syncStatus: "PENDING_RETRY", version: 1, notes: notes || null },
    { clientId, serviceId, checkInDate: ci, checkOutDate: co, status: { not: "CANCELLED" } }
  );
  if (duplicate) return res.status(409).json({ error: "Duplicate active reservation", flagged: true, existingId: duplicate.id });

  sendReservationConfirmation(reservation.id).catch((e) => console.warn("[notify] confirmation dispatch failed:", e?.message || e));
  await logAudit(publicActor, "CREATE", "Reservation", reservation.id, JSON.stringify({ ...req.body, totalAmount }), req.ip || "", req.headers["user-agent"] || "");

  res.status(201).json({ ...reservation, confirmationCode: code, flaggedDuplicate: false });
});

export default router;
