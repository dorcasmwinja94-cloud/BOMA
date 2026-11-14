const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const serviceUpdates = [
  {
    name: "Deluxe Hotel Room",
    description: "Spacious air-conditioned room with king-sized bed, Wi-Fi, satellite TV, work desk, minibar and en-suite bathroom. Complimentary breakfast included. Located in a Kenyan eco-lodge with savannah views.",
    imageUrl: "https://images.unsplash.com/photo-1571896349842-33c89424de2d?w=800&q=80&auto=format&fit=crop",
    images: [
      "https://images.unsplash.com/photo-1571896349842-33c89424de2d?w=800&q=80&auto=format&fit=crop",
      "https://images.unsplash.com/photo-1590490360182-c33d57733427?w=800&q=80&auto=format&fit=crop",
    ],
  },
  {
    name: "Maasai Mara Safari",
    description: "Full-day guided safari in Maasai Mara National Reserve. Game drives in a 4×4 safari vehicle, packed lunch and bottled water included. Pick-up and drop-off from Nairobi.",
    imageUrl: "https://images.unsplash.com/photo-1547471080-7cc2caa01a7e?w=800&q=80&auto=format&fit=crop",
    images: [
      "https://images.unsplash.com/photo-1547471080-7cc2caa01a7e?w=800&q=80&auto=format&fit=crop",
      "https://images.unsplash.com/photo-1516426122078-c23e76319801?w=800&q=80&auto=format&fit=crop",
    ],
  },
  {
    name: "Diani Beach Excursion",
    description: "Half-day excursion to Diani Beach with snorkeling, camel rides and lunch at a beachfront restaurant. Transport and beach entry included.",
    imageUrl: "https://images.unsplash.com/photo-1519046904884-53103b34b206?w=800&q=80&auto=format&fit=crop",
    images: [
      "https://images.unsplash.com/photo-1519046904884-53103b34b206?w=800&q=80&auto=format&fit=crop",
      "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=800&q=80&auto=format&fit=crop",
    ],
  },
  {
    name: "Airport Transfer",
    description: "Private round-trip airport transfer service between Jomo Kenyatta International Airport (JKIA) and your hotel or Nairobi address. Professional driver and 24/7 availability.",
    imageUrl: "https://images.unsplash.com/photo-1494515843206-f3117d3f51b7?w=800&q=80&auto=format&fit=crop",
    images: [
      "https://images.unsplash.com/photo-1494515843206-f3117d3f51b7?w=800&q=80&auto=format&fit=crop",
      "https://images.unsplash.com/photo-1550355291-bbee04a92027?w=800&q=80&auto=format&fit=crop",
    ],
  },
  {
    name: "Conference Hall",
    description: "Fully equipped conference hall with projector, sound system, Wi-Fi, and catering options. Seats up to 50 guests theatre-style. Ideal for corporate meetings and workshops.",
    imageUrl: "https://images.unsplash.com/photo-1524178232363-1fb2b075b655?w=800&q=80&auto=format&fit=crop",
    images: [
      "https://images.unsplash.com/photo-1524178232363-1fb2b075b655?w=800&q=80&auto=format&fit=crop",
      "https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=800&q=80&auto=format&fit=crop",
    ],
  },
];

(async () => {
  for (const update of serviceUpdates) {
    const service = await prisma.service.findFirst({ where: { name: update.name } });
    if (!service) { console.log("NOT FOUND:", update.name); continue; }
    await prisma.service.update({
      where: { id: service.id },
      data: { description: update.description, imageUrl: update.imageUrl, images: update.images },
    });
    console.log("UPDATED:", update.name);
  }
  await prisma.$disconnect();
})().catch(async e => {
  console.error("UPDATE FAILED:", e.message);
  await prisma.$disconnect();
  process.exit(1);
});