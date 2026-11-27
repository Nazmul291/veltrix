import { createCookieSessionStorage, redirect, type Session, type SessionStorage } from "@remix-run/node";
import type { AdminRoleType } from "@prisma/client";
import { safeRedirect } from "~/lib/safe-redirect";
import { writeAuditLog } from "./audit.server";
import { CentralAuthError, verifyCentralUser } from "./central-auth.server";
import { deriveKey } from "./crypto.server";
import { prisma } from "./db.server";

/** How often requireUser re-checks the user with NazmulCodes Auth (verify-user). */
export const VERIFY_INTERVAL_MS = 15 * 60_000;

interface SessionData {
  userId: string;
  centralUserId: string;
  /** ms epoch of the last successful check. The DB copy (User.centralVerifiedAt) is shared by all of the user's sessions. */
  verifiedAt: number;
  /** One-time login state (set by /auth/login, cleared by /auth/callback). */
  oauthState: string;
  returnTo: string;
  /** Set after one automatic restart for invalid_grant, to stop login loops. */
  oauthRetried: boolean;
}

let storage: SessionStorage<SessionData> | null = null;

/**
 * Signed cookie. sameSite must be "lax", not "strict": the browser comes back
 * from auth.nazmulcodes.org as a cross-site top-level navigation, and a strict
 * cookie (with its oauthState) would be left off that request.
 * The signing secret is derived from MASTER_ENCRYPTION_KEY.
 */
function getStorage(): SessionStorage<SessionData> {
  storage ??= createCookieSessionStorage<SessionData>({
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
  return storage;
}

export function getSession(request: Request) {
  return getStorage().getSession(request.headers.get("Cookie"));
}

export function commitSession(session: Session<SessionData>) {
  return getStorage().commitSession(session);
}

/** Always a brand-new session (the incoming cookie is never reused), which blocks session fixation. */
export async function createUserSession(input: { userId: string; centralUserId: string; redirectTo: string }) {
  const s = getStorage();
  const session = await s.getSession();
  session.set("userId", input.userId);
  session.set("centralUserId", input.centralUserId);
  session.set("verifiedAt", Date.now());
  return redirect(safeRedirect(input.redirectTo), { headers: { "Set-Cookie": await s.commitSession(session) } });
}

/** The signed-in user's ID from the cookie alone (no DB or SSO check). Use requireUser for access control. */
export async function getUserId(request: Request): Promise<string | null> {
  const session = await getSession(request);
  const userId = session.get("userId");
  return typeof userId === "string" && typeof session.get("centralUserId") === "string" ? userId : null;
}

async function signedOut(session: Session<SessionData>, error?: "signed_out" | "unavailable") {
  return redirect(error ? `/login?error=${error}` : "/login", {
    headers: { "Set-Cookie": await getStorage().destroySession(session) },
  });
}

/**
 * Ends only the Veltrix session. The user stays signed in at auth.nazmulcodes.org (SSO).
 * Lands on the public homepage. It isn't protected, so the browser isn't sent straight back into SSO.
 */
export async function logout(request: Request) {
  return redirect("/", { headers: { "Set-Cookie": await getStorage().destroySession(await getSession(request)) } });
}

/** Where to send a signed-out request: straight into SSO, then back to the page it asked for. */
function loginRedirect(request: Request) {
  const url = new URL(request.url);
  url.searchParams.delete("_data"); // Remix data requests: return to the page, not the data endpoint
  url.searchParams.delete("index");
  const returnTo = request.method === "GET" ? url.pathname + url.search : "/";
  return redirect(`/auth/login?returnTo=${encodeURIComponent(safeRedirect(returnTo))}`);
}

// ─── Periodic and fresh checks with NazmulCodes Auth ────────────────────────

type CheckOutcome = "valid" | "revoked" | "app_suspended" | "unavailable";

/** One verify-user call per user at a time, even when a page fires several loaders at once. */
const inflight = new Map<string, Promise<CheckOutcome>>();

function checkCentralStatus(userId: string, centralUserId: string): Promise<CheckOutcome> {
  let p = inflight.get(centralUserId);
  if (!p) {
    p = runCheck(userId, centralUserId).finally(() => inflight.delete(centralUserId));
    inflight.set(centralUserId, p);
  }
  return p;
}

async function runCheck(userId: string, centralUserId: string): Promise<CheckOutcome> {
  try {
    const res = await verifyCentralUser(centralUserId);
    if (!res.valid) {
      await revokeLocalAccess(userId, "verify_user_invalid");
      return "revoked";
    }
    const profile = res.user && res.user.id === centralUserId ? res.user : null;
    await prisma.user.update({
      where: { id: userId },
      data: {
        centralVerifiedAt: new Date(),
        ...(profile ? { email: profile.email, name: profile.name, avatarUrl: profile.avatarUrl } : {}),
      },
    });
    return "valid";
  } catch (err) {
    if (!(err instanceof CentralAuthError)) throw err;
    if (err.reason === "access_denied") {
      await revokeLocalAccess(userId, "access_denied");
      return "revoked";
    }
    if (err.reason === "client_suspended") return "app_suspended";
    return "unavailable"; // already logged by central-auth.server
  }
}

/** Marks the user disabled, so every one of their sessions is rejected until they sign in successfully again. */
async function revokeLocalAccess(userId: string, why: string) {
  await prisma.user.update({ where: { id: userId }, data: { disabledAt: new Date() } });
  await writeAuditLog(prisma, {
    actorId: null,
    action: "user.central_access_revoked",
    targetType: "User",
    targetId: userId,
    metadata: { why },
    context: { ipAddress: null, userAgent: "system:central-auth" },
  });
}

export interface RequireUserOptions {
  /**
   * Re-check with NazmulCodes Auth now, whatever the 15-minute timer says. Use
   * before sensitive actions. Fails closed: if the auth service can't be
   * reached, the action is refused (503) but the user stays signed in.
   */
  fresh?: boolean;
}

/**
 * Access control for every protected loader, action and API route:
 * 1. No session → straight to SSO login, coming back to this page afterwards.
 * 2. Re-verify with verify-user when the last check is older than 15 minutes (or `fresh`).
 * 3. valid=false or access_denied → sign out (and disable the user's other sessions).
 *
 * A periodic check fails open when the auth service is unreachable: the session
 * stays and the next request tries again, so an outage there doesn't sign out
 * every Veltrix user. Sensitive actions use `fresh`, which fails closed.
 */
export async function requireUser(request: Request, opts: RequireUserOptions = {}) {
  const session = await getSession(request);
  const userId = session.get("userId");
  const centralUserId = session.get("centralUserId");
  if (typeof userId !== "string" || typeof centralUserId !== "string") throw loginRedirect(request);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      avatarUrl: true,
      plan: true,
      paddleCustomerId: true,
      centralUserId: true,
      centralVerifiedAt: true,
      disabledAt: true,
      adminRole: { select: { role: true } },
    },
  });
  if (!user || user.centralUserId !== centralUserId) throw await signedOut(session);
  if (user.disabledAt) throw await signedOut(session, "signed_out");

  const lastVerified = Math.max(Number(session.get("verifiedAt")) || 0, user.centralVerifiedAt?.getTime() ?? 0);
  if (opts.fresh || Date.now() - lastVerified > VERIFY_INTERVAL_MS) {
    const outcome = await checkCentralStatus(user.id, centralUserId);
    if (outcome === "revoked") throw await signedOut(session, "signed_out");
    if (outcome === "app_suspended") throw await signedOut(session, "unavailable");
    if (outcome === "unavailable" && opts.fresh) {
      throw new Response("Sign-in service is temporarily unavailable. Please try again in a moment.", { status: 503 });
    }
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    plan: user.plan,
    paddleCustomerId: user.paddleCustomerId,
    centralUserId,
    adminRole: user.adminRole,
  };
}

const ROLE_RANK: Record<AdminRoleType, number> = { SUPPORT: 1, ADMIN: 2, SUPER_ADMIN: 3 };

/** Returns 404 rather than 403, so non-admins can't tell the admin panel exists. */
export async function requireAdmin(request: Request, minimum: AdminRoleType = "ADMIN", opts: RequireUserOptions = {}) {
  const user = await requireUser(request, opts);
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
