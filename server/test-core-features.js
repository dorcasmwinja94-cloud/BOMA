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
  return { status: res.status, data, headers: res.headers };
}

async function login(email, password) {
  const r = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  if (r.status !== 200) throw new Error(`Login failed for ${email}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}

(async () => {
  const suffix = Date.now().toString().slice(-6);
  const email = `qa-${suffix}@Boma.local`;
  let userId;
  let clientToken;
  let reservationId;
  try {
    const manager = await login("manager@orms.local", "Manager@123");
    const officer = await login("officer@orms.local", "Officer@123");

    let r = await request("/api/users", {}, manager.token);
    console.log("GET users:", r.status, Array.isArray(r.data), "hash leaked:", JSON.stringify(r.data).includes("passwordHash"));

    r = await request("/api/users", {
      method: "POST",
      body: JSON.stringify({ fullName: "QA Client", email, role: "CLIENT", password: "QaClient@123", phoneNumber: "+254700111222" }),
    }, manager.token);
    console.log("POST user:", r.status, r.data?.email, "client:", r.data?.client?.id);
    userId = r.data?.id;
    if (r.status !== 201) throw new Error("create user failed");

    r = await request(`/api/users/${userId}`, {
      method: "PUT",
      body: JSON.stringify({ fullName: "QA Client Updated", isActive: true }),
    }, manager.token);
    console.log("PUT user:", r.status, r.data?.fullName);

    r = await request(`/api/users/${userId}/reset-password`, {
      method: "POST", body: JSON.stringify({ password: "QaClient@456" }),
    }, manager.token);
    console.log("Reset password:", r.status, r.data?.message);

    const client = await login(email, "QaClient@456");
    clientToken = client.token;

    const services = await request("/api/services");
    const hotel = services.data.find(s => s.serviceType === "ACCOMMODATION");

    r = await request("/api/reservations", {
      method: "POST",
      body: JSON.stringify({ serviceId: hotel.id, checkInDate: "2027-02-10", checkOutDate: "2027-02-13", numberOfGuests: 2, notes: "QA booking" }),
    }, clientToken);
    console.log("Client create reservation:", r.status, "amount:", r.data?.totalAmount, "code:", r.data?.confirmationCode);
    if (r.status !== 201) throw new Error("client reservation failed");
    reservationId = r.data.id;

    r = await request("/api/reservations", {}, clientToken);
    console.log("Client reservation scope:", r.status, r.data?.length, "all own:", Array.isArray(r.data) && r.data.every(x => x.id === reservationId));

    r = await request("/api/reservations", {
      method: "POST",
      body: JSON.stringify({ serviceId: hotel.id, checkInDate: "2027-02-10", checkOutDate: "2027-02-13", numberOfGuests: 2 }),
    }, clientToken);
    console.log("Duplicate check:", r.status, r.data?.flagged, r.data?.existingId);

    r = await request(`/api/reservations/${reservationId}`, {
      method: "PUT", body: JSON.stringify({ notes: "hacked", version: 1 }),
    }, clientToken);
    console.log("Client blocked from PUT:", r.status);

    r = await request(`/api/reservations/${reservationId}`, {
      method: "PUT", body: JSON.stringify({ numberOfGuests: 3, notes: "QA edited", version: 1 }),
    }, officer.token);
    console.log("Officer edit reservation:", r.status, "guests:", r.data?.numberOfGuests, "version:", r.data?.version, "amount:", r.data?.totalAmount);
    const versionAfterEdit = r.data?.version;

    r = await request(`/api/reservations/${reservationId}`, {
      method: "PUT", body: JSON.stringify({ notes: "stale", version: 1 }),
    }, officer.token);
    console.log("Stale version rejected:", r.status, r.data?.error);

    r = await request(`/api/reservations/${reservationId}/reschedule`, {
      method: "POST", body: JSON.stringify({ checkInDate: "2027-03-01", checkOutDate: "2027-03-04", version: versionAfterEdit }),
    }, clientToken);
    console.log("Client reschedule:", r.status, "version:", r.data?.version, "amount:", r.data?.totalAmount);

    r = await request(`/api/reservations/${reservationId}`, {
      method: "PUT", body: JSON.stringify({ status: "CONFIRMED", version: r.data?.version }),
    }, officer.token);
    console.log("Officer confirm:", r.status, r.data?.status);

    r = await request("/api/reports", {
      method: "POST", body: JSON.stringify({ reportType: "RESERVATIONS", from: "2027-01-01", to: "2027-12-31" }),
    }, manager.token);
    console.log("Generate report:", r.status, r.data?.id, r.data?.fileUrl);
    const reportId = r.data?.id;

    const exportRes = await fetch(`${BASE}/api/reports/${reportId}/export`, { headers: { Authorization: `Bearer ${manager.token}` } });
    const csv = await exportRes.text();
    console.log("Export report:", exportRes.status, exportRes.headers.get("content-type"), "has QA client:", csv.includes("QA Client Updated"), "lines:", csv.split("\r\n").length);

    r = await request(`/api/reservations/${reservationId}/cancel-self`, { method: "POST" }, clientToken);
    console.log("Client cancel:", r.status, r.data?.status);

    // Invalid client login after deactivation.
    r = await request(`/api/users/${userId}`, {
      method: "PUT", body: JSON.stringify({ isActive: false }),
    }, manager.token);
    console.log("Deactivate user:", r.status, r.data?.isActive);
    const deactivated = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password: "QaClient@456" }) });
    console.log("Deactivated login blocked:", deactivated.status);
  } finally {
    if (reservationId) {
      await prisma.payment.deleteMany({ where: { reservationId } }).catch(() => {});
      await prisma.confirmation.deleteMany({ where: { reservationId } }).catch(() => {});
      await prisma.syncLog.deleteMany({ where: { reservationId } }).catch(() => {});
      await prisma.reservation.deleteMany({ where: { id: reservationId } }).catch(() => {});
    }
    if (userId) {
      await prisma.client.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
    }
    await prisma.report.deleteMany({ where: { reportType: "RESERVATIONS", generatedAt: { gte: new Date(Date.now() - 10 * 60 * 1000) } } }).catch(() => {});
    await prisma.$disconnect();
  }
})().catch(async e => { console.error("TEST FAILED:", e); await prisma.$disconnect(); process.exit(1); });
