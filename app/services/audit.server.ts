import type { Prisma, PrismaClient } from "@prisma/client";

export interface RequestContext {
  ipAddress: string | null;
  userAgent: string | null;
}

export function getRequestContext(request: Request): RequestContext {
  const h = request.headers;
  const ip = h.get("fly-client-ip") ?? h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  return { ipAddress: ip, userAgent: h.get("user-agent")?.slice(0, 512) ?? null };
}

type Db = PrismaClient | Prisma.TransactionClient;

export interface AuditEntry {
  actorId: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  /** Never put secret values in here. */
  metadata?: Prisma.InputJsonValue;
  context?: RequestContext;
}

export function writeAuditLog(db: Db, entry: AuditEntry) {
  return db.auditLog.create({
    data: {
      actorId: entry.actorId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId ?? null,
      metadata: entry.metadata ?? {},
      ipAddress: entry.context?.ipAddress ?? null,
      userAgent: entry.context?.userAgent ?? null,
    },
  });
}
