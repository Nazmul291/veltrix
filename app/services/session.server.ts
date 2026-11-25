import { createCookieSessionStorage, redirect, type SessionStorage } from "@remix-run/node";
import type { AdminRoleType } from "@prisma/client";
import { deriveKey } from "./crypto.server";
import { prisma } from "./db.server";

let storage: SessionStorage | null = null;

/** The cookie-signing secret is derived from MASTER_ENCRYPTION_KEY, so there's no SESSION_SECRET variable. */
function getStorage(): SessionStorage {
  if (!storage) {
    storage = createCookieSessionStorage({
      cookie: {
        name: "__vx_session",
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: process.env.NODE_ENV === "production",
        maxAge: 60 * 60 * 12,
        secrets: [deriveKey("session").toString("base64")],
      },
    });
  }
  return storage;
}

/** Always starts a fresh session (never reuses the incoming cookie), which blocks session fixation. */
export async function createUserSession(userId: string, redirectTo: string) {
  const s = getStorage();
  const session = await s.getSession();
  session.set("userId", userId);
  return redirect(redirectTo, { headers: { "Set-Cookie": await s.commitSession(session) } });
}

async function readSession(request: Request) {
  return getStorage().getSession(request.headers.get("Cookie"));
}

/** The signed-in user's ID, or null. Doesn't check the database. Use requireUser for that. */
export async function getUserId(request: Request): Promise<string | null> {
  const userId = (await readSession(request)).get("userId");
  return typeof userId === "string" ? userId : null;
}

export async function logout(request: Request) {
  const s = getStorage();
  const session = await readSession(request);
  return redirect("/login", { headers: { "Set-Cookie": await s.destroySession(session) } });
}

export async function requireUser(request: Request) {
  const s = getStorage();
  const session = await s.getSession(request.headers.get("Cookie"));
  const userId = session.get("userId");

  if (typeof userId !== "string") {
    throw redirect(`/login?redirectTo=${encodeURIComponent(new URL(request.url).pathname)}`);
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, plan: true, paddleCustomerId: true, adminRole: { select: { role: true } } },
  });
  if (!user) throw redirect("/login", { headers: { "Set-Cookie": await s.destroySession(session) } });

  return user;
}

const ROLE_RANK: Record<AdminRoleType, number> = { SUPPORT: 1, ADMIN: 2, SUPER_ADMIN: 3 };

/** Returns 404 rather than 403, so non-admins can't tell the admin panel exists. */
export async function requireAdmin(request: Request, minimum: AdminRoleType = "ADMIN") {
  const user = await requireUser(request);
  const role = user.adminRole?.role;
  if (!role || ROLE_RANK[role] < ROLE_RANK[minimum]) throw new Response("Not Found", { status: 404 });
  return { id: user.id, email: user.email, role };
}

/**
 * CSRF defence in depth, on top of SameSite=Lax: a state-changing request must
 * carry an Origin header that matches the host serving it.
 */
export function assertSameOrigin(request: Request) {
  if (request.method === "GET" || request.method === "HEAD") return;
  const origin = request.headers.get("Origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  let originHost: string | null = null;
  try {
    originHost = origin ? new URL(origin).host : null;
  } catch {
    originHost = null;
  }
  if (!originHost || !host || originHost !== host) throw new Response("Forbidden", { status: 403 });
}
