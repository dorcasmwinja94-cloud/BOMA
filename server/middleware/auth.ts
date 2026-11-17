import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../utils/prisma";
import { getJwtSecret } from "../utils/runtimeConfig";

export interface AuthReq extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
    fullName: string;
  };
}

export function authenticate(req: AuthReq, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing token" });
  }
  let secret: string;
  try {
    // A missing production secret is a server configuration error, not an
    // invalid user token. Surface it as a 500 rather than a misleading 401.
    secret = getJwtSecret();
  } catch (e) {
    return next(e);
  }
  try {
    const token = auth.slice(7);
    const decoded = jwt.verify(token, secret) as any;
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

export function requireRole(roles: string[]) {
  return (req: AuthReq, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  };
}

export async function logAudit(
  userId: string | null,
  action: string,
  entityType: string,
  entityId: string | null,
  changesJson: string | null,
  ip: string,
  ua: string
) {
  try {
    await prisma.auditLog.create({
      data: { userId, action, entityType, entityId, changesJson, ipAddress: ip, userAgent: ua },
    });
  } catch {
    // fail silently for audit
  }
}
