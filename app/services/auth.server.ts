import type { VerifiedCentralUser } from "~/lib/nazmulcodes-auth.server";
import { writeAuditLog, type RequestContext } from "./audit.server";
import { isUniqueViolation } from "./credentials.server";
import { prisma } from "./db.server";

/**
 * Creates or updates the local user for a verified central user. The match is
 * by centralUserId only, never by email: central sign-ups can have unverified
 * emails, so matching on email would let someone take over an account.
 * A successful sign-in also clears disabledAt (e.g. after the user reconnects Veltrix).
 */
export async function upsertCentralUser(central: VerifiedCentralUser, ctx: RequestContext) {
  const profile = { email: central.email, name: central.name, avatarUrl: central.avatarUrl };
  const now = new Date();

  const attempt = async () => {
    const existing = await prisma.user.findUnique({ where: { centralUserId: central.id }, select: { id: true } });
    if (existing) {
      await prisma.user.update({ where: { id: existing.id }, data: { ...profile, centralVerifiedAt: now, disabledAt: null } });
      return { id: existing.id, created: false };
    }
    const created = await prisma.user.create({
      data: { centralUserId: central.id, ...profile, centralVerifiedAt: now },
      select: { id: true },
    });
    return { id: created.id, created: true };
  };

  let result: { id: string; created: boolean };
  try {
    result = await attempt();
  } catch (err) {
    // Two callbacks for the same new user at once: the other one created the user first.
    if (!isUniqueViolation(err)) throw err;
    result = await attempt();
  }

  await writeAuditLog(prisma, {
    actorId: result.id,
    action: result.created ? "user.signup" : "user.login",
    targetType: "User",
    targetId: result.id,
    metadata: { via: "nazmulcodes", twoFactor: central.twoFactorEnabled },
    context: ctx,
  });
  return result;
}
