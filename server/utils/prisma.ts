import { PrismaClient } from "@prisma/client";
export const prisma = new PrismaClient();
export const dbState = { ready: false };
