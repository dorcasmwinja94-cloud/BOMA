import { prisma } from "./utils/prisma";
import { hashPassword } from "./utils/auth";

async function seed() {
  if (process.env.SEED_ALLOW_RESET !== "1") {
    console.error(
      "Refusing to seed: this script deletes ALL reservations, clients, services and users in the database.\n" +
      "If you really intend to reset a development database, run it with SEED_ALLOW_RESET=1."
    );
    process.exit(1);
  }
  await prisma.auditLog.deleteMany({});
  await prisma.syncLog.deleteMany({});
  await prisma.confirmation.deleteMany({});
  await prisma.reservation.deleteMany({});
  await prisma.service.deleteMany({});
  await prisma.client.deleteMany({});
  await prisma.user.deleteMany({});

  const manager = await prisma.user.create({
    data: {
      fullName: "Grace Wanjiku",
      email: "manager@orms.local",
      passwordHash: hashPassword("Manager@123"),
      role: "MANAGER",
      isActive: true,
    },
  });
  const officer = await prisma.user.create({
    data: {
      fullName: "Sarah Jenkins",
      email: "officer@orms.local",
      passwordHash: hashPassword("Officer@123"),
      role: "RESERVATION_OFFICER",
      isActive: true,
    },
  });
  const clientUser = await prisma.user.create({
    data: {
      fullName: "James Mwangi",
      email: "client@orms.local",
      passwordHash: hashPassword("Client@123"),
      role: "CLIENT",
      isActive: true,
    },
  });

  const client = await prisma.client.create({
    data: {
      userId: clientUser.id,
      fullName: "James Mwangi",
      email: "client@orms.local",
      phoneNumber: "+1234567890",
      address: "123 Client St",
    },
  });

  await prisma.service.createMany({
    data: [
      { name: "Seaside Suite", serviceType: "ACCOMMODATION", location: "Beachfront", capacity: 2, pricePerUnit: 250 },
      { name: "Mountain Trek", serviceType: "TOUR", location: "Alps", capacity: 10, pricePerUnit: 120 },
      { name: "Airport Shuttle", serviceType: "TRANSPORT", location: "Airport", capacity: 4, pricePerUnit: 45 },
    ],
  });

  console.log("Seed complete.");
  process.exit(0);
}

seed().catch((e) => { console.error(e); process.exit(1); });
