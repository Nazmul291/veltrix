import { writeAuditLog, type RequestContext } from "./audit.server";
import { isUniqueViolation } from "./credentials.server";
import { prisma } from "./db.server";
import { getDummyHash, hashPassword, needsRehash, verifyPassword } from "./password.server";

export type AuthResult = { ok: true; userId: string } | { ok: false };

/**
 * Checks an email and password. An unknown email, a user without a password,
 * and a wrong password all take the same scrypt time and return the same { ok: false },
 * so the result never reveals which emails have accounts.
 */
export async function authenticate(email: string, password: string, ctx: RequestContext): Promise<AuthResult> {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, passwordHash: true } });
  const valid = await verifyPassword(password, user?.passwordHash ?? (await getDummyHash()));

  if (!user || !user.passwordHash || !valid) {
    await writeAuditLog(prisma, {
      actorId: user?.id ?? null,
      action: "user.login_failed",
      targetType: "User",
      targetId: user?.id ?? null,
      // Record the attempted email only when an account exists, so typos and other people's addresses aren't stored.
      metadata: user ? { email } : {},
      context: ctx,
    });
    return { ok: false };
  }

  if (needsRehash(user.passwordHash)) {
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(password) } });
  }

  await writeAuditLog(prisma, { actorId: user.id, action: "user.login", targetType: "User", targetId: user.id, context: ctx });
  return { ok: true, userId: user.id };
}

export type RegisterResult = { ok: true; userId: string } | { ok: false; reason: "email_taken" };

export async function registerUser(
  input: { email: string; password: string; name?: string },
  ctx: RequestContext,
): Promise<RegisterResult> {
  const passwordHash = await hashPassword(input.password);
  try {
    const user = await prisma.user.create({
      data: { email: input.email, name: input.name || null, passwordHash },
      select: { id: true },
    });
    await writeAuditLog(prisma, { actorId: user.id, action: "user.signup", targetType: "User", targetId: user.id, context: ctx });
    return { ok: true, userId: user.id };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: "email_taken" };
    throw err;
  }
}
