/**
 * Brute-force / account-lockout test for the Boma login endpoint.
 *
 * Verifies:
 *  1. Wrong passwords are rejected with a decreasing attempt counter.
 *  2. The account locks on the configured 5th failure (HTTP 423).
 *  3. The correct password is also rejected while locked.
 *  4. After the lock expires, the correct password works again.
 *  5. All three seeded demo roles can log in.
 *
 * Run with the API on http://localhost:4000:
 *   node server/test-bruteforce.js
 */
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();
const API = process.env.API_URL || "http://localhost:4000";
const TEST_EMAIL = "bruteforce.test@boma.local";
const TEST_PASSWORD = "Brute@Test123";
const WRONG_PASSWORD = "WrongPassword!";

async function login(email, password) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  let body = {};
  try {
    body = await res.json();
  } catch (_) {}
  return { status: res.status, body };
}

function line(label, result) {
  const extra = result.body.error ? ` | ${result.body.error}` : "";
  const left =
    result.body.remainingAttempts !== undefined
      ? ` | remaining=${result.body.remainingAttempts}`
      : "";
  console.log(`${label}: HTTP ${result.status}${left}${extra}`);
}

async function main() {
  console.log("=== Boma BRUTE-FORCE / LOCKOUT TEST ===\n");

  // Fresh test account, so the demo accounts are never locked by this test.
  await prisma.auditLog.deleteMany({ where: { user: { email: TEST_EMAIL } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
  const testUser = await prisma.user.create({
    data: {
      fullName: "Brute Force Test",
      email: TEST_EMAIL,
      passwordHash: bcrypt.hashSync(TEST_PASSWORD, 10),
      role: "CLIENT",
      isActive: true,
    },
  });

  let failures = 0;
  const check = (condition, message) => {
    if (!condition) {
      failures++;
      console.log(`  FAIL: ${message}`);
    }
  };

  try {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const r = await login(TEST_EMAIL, WRONG_PASSWORD);
      line(`Wrong password #${attempt}`, r);
      if (attempt < 5) {
        check(r.status === 401, `attempt ${attempt} should return 401`);
        check(
          r.body.remainingAttempts === 5 - attempt,
          `attempt ${attempt} should report ${5 - attempt} remaining attempts`
        );
      } else {
        check(r.status === 423, "5th failure should lock the account (423)");
        check(r.body.locked === true, "5th failure should return locked=true");
      }
    }

    const dbUser = await prisma.user.findUnique({ where: { email: TEST_EMAIL } });
    check(dbUser.failedLoginAttempts === 5, "DB should record 5 failed attempts");
    check(!!dbUser.lockedUntil, "DB should store lockedUntil");
    console.log(
      `DB state: failedLoginAttempts=${dbUser.failedLoginAttempts}, lockedUntil=${dbUser.lockedUntil?.toISOString()}`
    );

    const lockedCorrect = await login(TEST_EMAIL, TEST_PASSWORD);
    line("Correct password while locked", lockedCorrect);
    check(lockedCorrect.status === 423, "correct password must be refused while locked");

    // Simulate the 15-minute lock expiring.
    await prisma.user.update({
      where: { id: testUser.id },
      data: { lockedUntil: new Date(Date.now() - 1000) },
    });
    const afterExpiry = await login(TEST_EMAIL, TEST_PASSWORD);
    line("Correct password after lock expiry", afterExpiry);
    check(afterExpiry.status === 200, "correct password should work after lock expiry");
    check(!!afterExpiry.body.token, "a JWT should be returned after unlock");

    // Regression: every seeded role can still sign in.
    console.log("\n--- Seeded demo accounts ---");
    const demos = [
      ["manager@orms.local", "Manager@123", "MANAGER"],
      ["officer@orms.local", "Officer@123", "RESERVATION_OFFICER"],
      ["client@orms.local", "Client@123", "CLIENT"],
    ];
    for (const [email, password, role] of demos) {
      const r = await login(email, password);
      line(email, r);
      check(r.status === 200, `${email} should log in`);
      check(r.body.user?.role === role, `${email} should return role ${role}`);
    }

    console.log(failures === 0 ? "\nRESULT: PASS - brute-force protection works and all demo logins succeed." : `\nRESULT: FAIL - ${failures} assertion(s) failed.`);
  } finally {
    await prisma.auditLog.deleteMany({ where: { userId: testUser.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: testUser.id } }).catch(() => {});
    await prisma.$disconnect();
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
