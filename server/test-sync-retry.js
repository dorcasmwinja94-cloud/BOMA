const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const BASE = "http://localhost:4000";

async function request(path, options = {}, token) {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { ...options, headers });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

(async () => {
  let reservationId;
  try {
    const login = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "officer@orms.local", password: "Officer@123" }),
    });
    if (login.status !== 200) throw new Error(`Officer login failed: ${login.status}`);
    const token = login.data.token;

    const clients = await request("/api/clients", {}, token);
    const services = await request("/api/services");
    const service = services.data[0];
    if (!clients.data.length || !service) throw new Error("Fixture data missing");

    const suffix = Date.now().toString().slice(-6);
    const checkIn = `2031-06-${String(10 + (Number(suffix) % 15)).padStart(2, "0")}`;
    const checkOut = `2031-06-${String(12 + (Number(suffix) % 15)).padStart(2, "0")}`;

    const created = await request("/api/reservations", {
      method: "POST",
      body: JSON.stringify({
        clientId: clients.data[0].id,
        serviceId: service.id,
        checkInDate: checkIn,
        checkOutDate: checkOut,
        numberOfGuests: 2,
        notes: "sync retry QA",
      }),
    }, token);
    if (created.status !== 201) throw new Error(`Create failed: ${created.status} ${JSON.stringify(created.data)}`);
    reservationId = created.data.id;
    const before = await prisma.reservation.findUnique({ where: { id: reservationId } });
    console.log("Created:", created.status, "initial sync:", before.syncStatus);

    const retried = await request("/api/sync-logs/retry", {
      method: "POST",
      body: JSON.stringify({ reservationId }),
    }, token);
    console.log("Retry response:", retried.status, "status:", retried.data?.status, "lastSyncedAt set:", Boolean(retried.data?.lastSyncedAt));

    const after = await prisma.reservation.findUnique({ where: { id: reservationId } });
    const logs = await prisma.syncLog.findMany({ where: { reservationId } });
    console.log("Reservation sync after retry:", after.syncStatus);
    console.log("All logs synced:", logs.every(l => l.status === "SYNCED"), "count:", logs.length);
    console.log("lastSyncedAt present:", logs.every(l => Boolean(l.lastSyncedAt)));

    if (after.syncStatus !== "SYNCED" || !logs.every(l => l.status === "SYNCED" && l.lastSyncedAt)) {
      throw new Error("Sync retry did not complete successfully");
    }

    // A second retry creates a fresh successful sync attempt (used by the officer row action).
    const second = await request("/api/sync-logs/retry", {
      method: "POST",
      body: JSON.stringify({ reservationId }),
    }, token);
    console.log("Second retry:", second.status, second.data?.status);
  } finally {
    if (reservationId) {
      await prisma.syncLog.deleteMany({ where: { reservationId } });
      await prisma.confirmation.deleteMany({ where: { reservationId } });
      await prisma.payment.deleteMany({ where: { reservationId } });
      await prisma.reservation.deleteMany({ where: { id: reservationId } });
      console.log("Temporary reservation cleaned up.");
    }
    await prisma.$disconnect();
  }
})().catch(async error => {
  console.error("SYNC TEST FAILED:", error.message);
  await prisma.$disconnect();
  process.exit(1);
});
