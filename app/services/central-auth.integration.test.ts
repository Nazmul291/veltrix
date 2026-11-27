/**
 * NazmulCodes SSO, end to end through the real routes and requireUser, with a
 * real Postgres and the auth API mocked at the fetch layer (the SDK is unmodified).
 * Skipped unless TEST_DATABASE_URL is set. It TRUNCATEs every table.
 */
import { randomBytes } from "node:crypto";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const DB = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:5173";
const AUTH = "https://auth.test";
const API_KEY = `nc_live_${"ab".repeat(32)}`;
const REDIRECT_URI = `${ORIGIN}/auth/callback`;

// ─── Fake NazmulCodes Auth ──────────────────────────────────────────────────

type Central = { id: string; email: string; name: string | null; avatarUrl: string | null; twoFactorEnabled: boolean };
type Mode = "ok" | "invalid_client" | "client_suspended" | "down";

const fake = {
  codes: new Map<string, Central>(),
  used: new Set<string>(),
  mode: "ok" as Mode,
  verify: "valid" as "valid" | "invalid" | "access_denied",
  profile: null as Central | null,
  calls: [] as { path: string; body: any; auth: string | null }[],
};

function issueCode(user: Central) {
  const code = randomBytes(16).toString("hex");
  fake.codes.set(code, user);
  return code;
}

const apiError = (status: number, error: string) =>
  new Response(JSON.stringify({ error, message: `fake ${error}` }), { status, headers: { "content-type": "application/json" } });
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

async function fakeFetch(input: string | URL, init?: RequestInit) {
  const url = new URL(String(input));
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const auth = new Headers(init?.headers).get("authorization");
  fake.calls.push({ path: url.pathname, body, auth });

  if (fake.mode === "down") throw new TypeError("fetch failed");
  if (fake.mode === "invalid_client" || auth !== `Bearer ${API_KEY}`) return apiError(401, "invalid_client");
  if (fake.mode === "client_suspended") return apiError(403, "client_suspended");

  switch (url.pathname) {
    case "/api/v1/client-info":
      return ok({ clientId: "veltrix", name: "Veltrix", callbackUrls: [REDIRECT_URI] });
    case "/api/v1/token": {
      const user = fake.codes.get(body?.code);
      if (!user || fake.used.has(body.code) || body.redirect_uri !== REDIRECT_URI) return apiError(400, "invalid_grant");
      fake.used.add(body.code);
      return ok({ user });
    }
    case "/api/v1/verify-user":
      if (fake.verify === "access_denied") return apiError(403, "access_denied");
      return ok(fake.verify === "valid" ? { valid: true, user: fake.profile ?? undefined } : { valid: false });
  }
  return apiError(404, "not_found");
}

// ─── Cookie jar and route helpers ───────────────────────────────────────────

function cookieFrom(res: Response): string | null | undefined {
  const raw = res.headers.get("set-cookie");
  if (!raw) return undefined; // unchanged
  const pair = raw.split(";")[0];
  return /max-age=0|expires=thu, 01 jan 1970/i.test(raw) ? null : pair; // null means cleared
}

async function thrown(p: Promise<unknown>): Promise<Response> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  throw new Error("expected a thrown Response");
}

const ada: Central = { id: "cu_ada_000000000000000001", email: "ada@example.com", name: "Ada", avatarUrl: null, twoFactorEnabled: true };

describe.skipIf(!DB)("NazmulCodes SSO (integration)", () => {
  let prisma: typeof import("./db.server").prisma;
  let session: typeof import("./session.server");
  let loginLoader: typeof import("~/routes/auth.login").loader;
  let callbackLoader: typeof import("~/routes/auth.callback").loader;
  let logoutAction: typeof import("~/routes/logout").action;
  let resetClient: () => void;
  let invalidateCreds: () => void;

  const call = (fn: (args: LoaderFunctionArgs) => unknown, path: string, cookie?: string | null) =>
    fn({ request: new Request(`${ORIGIN}${path}`, { headers: cookie ? { Cookie: cookie } : {} }), params: {}, context: {} }) as Promise<Response>;

  /** /auth/login → the authorize URL (the fake auth site signs the user in) → /auth/callback. */
  async function signIn(user: Central, returnTo = "/") {
    const start = await call(loginLoader, `/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
    const authorize = new URL(start.headers.get("location")!);
    const cookie = cookieFrom(start)!;
    const back = await call(callbackLoader, `/auth/callback?code=${issueCode(user)}&state=${authorize.searchParams.get("state")}`, cookie);
    return { authorize, response: back, cookie: cookieFrom(back) ?? cookie };
  }

  const protectedRequest = (cookie: string | null, path = "/") =>
    new Request(`${ORIGIN}${path}`, { headers: cookie ? { Cookie: cookie } : {} });

  const setConfig = (env: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    invalidateCreds();
    resetClient();
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = DB;
    process.env.MASTER_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    vi.stubGlobal("fetch", fakeFetch);

    ({ prisma } = await import("./db.server"));
    session = await import("./session.server");
    ({ loader: loginLoader } = await import("~/routes/auth.login"));
    ({ loader: callbackLoader } = await import("~/routes/auth.callback"));
    ({ action: logoutAction } = await import("~/routes/logout"));
    ({ resetCentralAuthClient: resetClient } = await import("./central-auth.server"));
    ({ invalidateCredentialCache: invalidateCreds } = await import("./credentials.server"));

    await prisma.$executeRawUnsafe(
      `TRUNCATE "WebhookEvent","BillingCheckout","Subscription","AuditLog","Resource","ProviderCredential","AdminRole","User" CASCADE`,
    );
  });

  beforeEach(() => {
    // Config from environment fallbacks. No client ID, so the SDK resolves it once via client-info.
    setConfig({
      NAZMULCODES_AUTH_URL: AUTH,
      NAZMULCODES_AUTH_API_KEY: API_KEY,
      NAZMULCODES_AUTH_REDIRECT_URI: REDIRECT_URI,
      NAZMULCODES_AUTH_CLIENT_ID: undefined,
    });
    Object.assign(fake, { mode: "ok", verify: "valid", profile: null });
    fake.calls.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    // process.env is shared by test files that run in the same worker.
    for (const k of ["NAZMULCODES_AUTH_URL", "NAZMULCODES_AUTH_API_KEY", "NAZMULCODES_AUTH_REDIRECT_URI", "NAZMULCODES_AUTH_CLIENT_ID"]) delete process.env[k];
    vi.unstubAllGlobals();
    await prisma?.$disconnect();
  });

  it("login redirects to /authorize with a fresh state, the resolved client_id and the exact redirect_uri", async () => {
    const a = await call(loginLoader, "/auth/login");
    const b = await call(loginLoader, "/auth/login");
    const url = new URL(a.headers.get("location")!);

    expect(url.origin + url.pathname).toBe(`${AUTH}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ response_type: "code", client_id: "veltrix", redirect_uri: REDIRECT_URI });
    expect(url.searchParams.get("state")!.length).toBeGreaterThanOrEqual(32);
    expect(url.searchParams.get("state")).not.toBe(new URL(b.headers.get("location")!).searchParams.get("state"));
    expect(fake.calls.filter((c) => c.path === "/api/v1/client-info")).toHaveLength(1); // resolved once, then cached

    const raw = a.headers.get("set-cookie")!;
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    expect(raw).not.toContain(url.searchParams.get("state")!); // the state is inside a signed cookie, not in plain text
  });

  it("new user: signs in and creates the local user by centralUserId", async () => {
    const { response } = await signIn(ada, "/billing");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/billing");

    const user = await prisma.user.findUniqueOrThrow({ where: { centralUserId: ada.id } });
    expect(user).toMatchObject({ email: "ada@example.com", name: "Ada", disabledAt: null });
    expect(user.centralVerifiedAt).not.toBeNull();

    const token = fake.calls.find((c) => c.path === "/api/v1/token")!;
    expect(token.auth).toBe(`Bearer ${API_KEY}`);
    expect(Object.keys(token.body).sort()).toEqual(["code", "redirect_uri"]);
    expect(token.body.redirect_uri).toBe(REDIRECT_URI);
  });

  it("returning user: same local account, profile synced, no verify call while fresh", async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { centralUserId: ada.id } });
    const { cookie } = await signIn({ ...ada, email: "ada@new.example.com", name: "Ada L." });

    const user = await session.requireUser(protectedRequest(cookie));
    expect(user.id).toBe(before.id);
    expect(user).toMatchObject({ email: "ada@new.example.com", name: "Ada L.", centralUserId: ada.id });
    expect(await prisma.user.count({ where: { centralUserId: ada.id } })).toBe(1);
    expect(fake.calls.some((c) => c.path === "/api/v1/verify-user")).toBe(false);
  });

  it("never links accounts by email: a different central user with the same email gets their own account", async () => {
    const impostor: Central = { ...ada, id: "cu_impostor_00000000000001", name: "Not Ada" };
    const { cookie } = await signIn(impostor);
    const user = await session.requireUser(protectedRequest(cookie));
    const original = await prisma.user.findUniqueOrThrow({ where: { centralUserId: ada.id } });
    expect(user.id).not.toBe(original.id);
  });

  it("rejects a tampered state and a missing state, without exchanging the code", async () => {
    const start = await call(loginLoader, "/auth/login");
    const cookie = cookieFrom(start)!;
    const code = issueCode(ada);

    const tampered = await call(callbackLoader, `/auth/callback?code=${code}&state=attacker-chosen-state-value-123`, cookie);
    expect(tampered.headers.get("location")).toBe("/login?error=state");

    const missing = await call(callbackLoader, `/auth/callback?code=${code}`, cookie);
    expect(missing.headers.get("location")).toBe("/login?error=state");

    const noCookie = await call(callbackLoader, `/auth/callback?code=${code}&state=whatever-state-value-000`);
    expect(noCookie.headers.get("location")).toBe("/login?error=state");

    expect(fake.calls.some((c) => c.path === "/api/v1/token")).toBe(false);
  });

  it("a reused code (invalid_grant) restarts login once, then shows an error instead of looping", async () => {
    const code = issueCode(ada);
    const first = await call(loginLoader, "/auth/login?returnTo=/billing");
    const state1 = new URL(first.headers.get("location")!).searchParams.get("state");
    await call(callbackLoader, `/auth/callback?code=${code}&state=${state1}`, cookieFrom(first)); // uses the code

    // Same code again with a valid new state: the token endpoint says invalid_grant.
    const second = await call(loginLoader, "/auth/login?returnTo=/billing");
    const state2 = new URL(second.headers.get("location")!).searchParams.get("state");
    const restart = await call(callbackLoader, `/auth/callback?code=${code}&state=${state2}`, cookieFrom(second));
    expect(restart.headers.get("location")).toBe("/auth/login?returnTo=%2Fbilling");

    const third = await call(loginLoader, "/auth/login?returnTo=/billing", cookieFrom(restart));
    const state3 = new URL(third.headers.get("location")!).searchParams.get("state");
    const giveUp = await call(callbackLoader, `/auth/callback?code=${code}&state=${state3}`, cookieFrom(third));
    expect(giveUp.headers.get("location")).toBe("/login?error=expired");
  });

  it("reusing the exact callback URL: no second exchange when signed in, otherwise login restarts once", async () => {
    const start = await call(loginLoader, "/auth/login");
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    const callbackUrl = `/auth/callback?code=${issueCode(ada)}&state=${state}`;
    const signedIn = cookieFrom(await call(callbackLoader, callbackUrl, cookieFrom(start)))!;
    fake.calls.length = 0;

    // Reloaded while signed in: straight to the dashboard, with no token call.
    expect((await call(callbackLoader, callbackUrl, signedIn)).headers.get("location")).toBe("/dashboard");
    expect(fake.calls).toHaveLength(0);

    // Not signed in, with a session cookie but no pending login: restart once, then give up.
    const other = await call(loginLoader, "/auth/login");
    const noPending = cookieFrom(await call(callbackLoader, `/auth/callback?code=x&state=wrong-state-value-0000000`, cookieFrom(other)))!;
    const restart = await call(callbackLoader, callbackUrl, noPending);
    expect(restart.headers.get("location")).toBe("/auth/login?returnTo=%2Fdashboard");
    expect((await call(callbackLoader, callbackUrl, cookieFrom(restart))).headers.get("location")).toBe("/login?error=expired");

    // No cookie at all (cookies blocked): an error, never a redirect loop.
    expect((await call(callbackLoader, callbackUrl)).headers.get("location")).toBe("/login?error=state");
    expect(fake.calls.filter((c) => c.path === "/api/v1/token")).toHaveLength(0);
  });

  it("signed-out protected page → SSO login → back to the original page (and returnTo can't leave the site)", async () => {
    const redirect = await thrown(session.requireUser(protectedRequest(null, "/billing?tab=plans&_data=routes%2Fbilling")));
    const location = redirect.headers.get("location")!;
    expect(location).toBe("/auth/login?returnTo=%2Fbilling%3Ftab%3Dplans");

    const returnTo = new URL(location, ORIGIN).searchParams.get("returnTo")!;
    expect((await signIn(ada, returnTo)).response.headers.get("location")).toBe("/billing?tab=plans");

    for (const evil of ["//evil.com", "https://evil.com", "/\\evil.com", "/%0d%0aSet-Cookie:x"]) {
      expect((await signIn(ada, evil)).response.headers.get("location")).toBe(evil.startsWith("/%") ? "/%0d%0aSet-Cookie:x" : "/dashboard");
    }
  });

  it("re-verifies after 15 minutes (once for concurrent requests) and syncs the profile", async () => {
    const { cookie } = await signIn(ada);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 16 * 60_000 });
    fake.calls.length = 0;
    fake.profile = { ...ada, name: "Ada Lovelace" };

    await Promise.all([1, 2, 3].map(() => session.requireUser(protectedRequest(cookie))));
    expect(fake.calls.filter((c) => c.path === "/api/v1/verify-user")).toEqual([
      { path: "/api/v1/verify-user", body: { userId: ada.id }, auth: `Bearer ${API_KEY}` },
    ]);
    expect((await prisma.user.findUniqueOrThrow({ where: { centralUserId: ada.id } })).name).toBe("Ada Lovelace");

    // The new timestamp was persisted, so the next request doesn't check again.
    await session.requireUser(protectedRequest(cookie));
    expect(fake.calls.filter((c) => c.path === "/api/v1/verify-user")).toHaveLength(1);
  });

  it("verify-user valid=false signs the user out everywhere until they sign in again", async () => {
    const a = (await signIn(ada)).cookie;
    const b = (await signIn(ada)).cookie; // a second browser
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 16 * 60_000 });
    fake.verify = "invalid";

    const out = await thrown(session.requireUser(protectedRequest(a)));
    expect(out.headers.get("location")).toBe("/login?error=signed_out");
    expect(cookieFrom(out)).toBeNull();

    fake.calls.length = 0;
    const outB = await thrown(session.requireUser(protectedRequest(b)));
    expect(outB.headers.get("location")).toBe("/login?error=signed_out");
    expect(fake.calls).toHaveLength(0); // rejected locally through disabledAt

    vi.useRealTimers();
    fake.verify = "valid";
    const again = (await signIn(ada)).cookie; // reconnecting clears disabledAt
    await expect(session.requireUser(protectedRequest(again))).resolves.toMatchObject({ centralUserId: ada.id });
  });

  it("an outage fails open for the periodic check but closed for sensitive actions", async () => {
    const { cookie } = await signIn(ada);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 16 * 60_000 });
    vi.spyOn(console, "error").mockImplementation(() => {});
    fake.mode = "down";

    await expect(session.requireUser(protectedRequest(cookie))).resolves.toMatchObject({ centralUserId: ada.id });
    const refused = await thrown(session.requireUser(protectedRequest(cookie), { fresh: true }));
    expect(refused.status).toBe(503);
    expect(await refused.text()).not.toMatch(/fetch failed|nc_live/);
  });

  it("a suspended Veltrix app signs the user out with a friendly message", async () => {
    const { cookie } = await signIn(ada);
    vi.spyOn(console, "error").mockImplementation(() => {});
    fake.mode = "client_suspended";
    const out = await thrown(session.requireUser(protectedRequest(cookie), { fresh: true }));
    expect(out.headers.get("location")).toBe("/login?error=unavailable");
  });

  it("wrong API key, suspended app, outage or a malformed key → friendly error, details logged without secrets", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    // At login (the client-info lookup fails).
    for (const mode of ["invalid_client", "client_suspended", "down"] as const) {
      setConfig({});
      fake.mode = mode;
      expect((await call(loginLoader, "/auth/login")).headers.get("location")).toBe("/login?error=unavailable");
    }

    // At the callback (the token exchange fails).
    fake.mode = "ok";
    setConfig({ NAZMULCODES_AUTH_CLIENT_ID: "veltrix" });
    const start = await call(loginLoader, "/auth/login");
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    fake.mode = "invalid_client";
    const code = issueCode(ada);
    const back = await call(callbackLoader, `/auth/callback?code=${code}&state=${state}`, cookieFrom(start));
    expect(back.headers.get("location")).toBe("/login?error=unavailable");

    // A key that isn't nc_live_<64 hex>: the SDK constructor throws a plain Error.
    setConfig({ NAZMULCODES_AUTH_API_KEY: "sk_wrong" });
    expect((await call(loginLoader, "/auth/login")).headers.get("location")).toBe("/login?error=unavailable");

    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).toMatch(/client_rejected|client_suspended|unreachable|not_configured/);
    expect(logged).not.toContain(API_KEY);
    expect(logged).not.toContain(code);
    expect(logged).not.toContain(ada.email);
  });

  it("a missing table (migrations not run) is logged as internal with its Prisma code, not as the auth service being unreachable", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // The real production failure: the table doesn't exist, so Prisma throws P2021.
    await prisma.$executeRawUnsafe(`ALTER TABLE "ProviderCredential" RENAME TO "ProviderCredential_hidden"`);
    try {
      expect((await call(loginLoader, "/auth/login")).headers.get("location")).toBe("/login?error=unavailable");
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE "ProviderCredential_hidden" RENAME TO "ProviderCredential"`);
    }
    expect(errors).toHaveBeenCalledWith("[central-auth]", { op: "authorize", reason: "internal", status: 0, code: "P2021" });
  });

  it("access_denied on sign-in shows a friendly denial", async () => {
    const start = await call(loginLoader, "/auth/login");
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(apiError(403, "access_denied"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const back = await call(callbackLoader, `/auth/callback?code=${issueCode(ada)}&state=${state}`, cookieFrom(start));
    expect(back.headers.get("location")).toBe("/login?error=denied");
  });

  it("the homepage is public (no SSO redirect), while /dashboard and /admin require sign-in", async () => {
    const { loader: homeLoader } = await import("~/routes/_index");
    const { loader: dashboardLayout } = await import("~/routes/dashboard");
    const { loader: adminLayout } = await import("~/routes/admin");
    fake.calls.length = 0;

    const signedOutHome = await call(homeLoader, "/");
    expect(signedOutHome.status).toBe(200);
    expect(await signedOutHome.json()).toEqual({ signedIn: false });

    const toLogin = await thrown(call(dashboardLayout, "/dashboard/billing?x=1"));
    expect(toLogin.headers.get("location")).toBe("/auth/login?returnTo=%2Fdashboard%2Fbilling%3Fx%3D1");
    expect((await thrown(call(adminLayout, "/admin/providers"))).headers.get("location")).toBe("/auth/login?returnTo=%2Fadmin%2Fproviders");

    const { cookie } = await signIn(ada);
    expect(await (await call(homeLoader, "/", cookie)).json()).toEqual({ signedIn: true });
    // Signed in but not an admin: the admin area answers 404, so it doesn't reveal that it exists.
    expect((await thrown(call(adminLayout, "/admin/providers", cookie))).status).toBe(404);
    expect(fake.calls.filter((c) => c.path !== "/api/v1/client-info" && c.path !== "/api/v1/token")).toHaveLength(0);
  });

  it("logout ends only the Veltrix session, lands on the public homepage, and makes no call to the auth service", async () => {
    const { cookie } = await signIn(ada);
    fake.calls.length = 0;
    const res = (await logoutAction({
      request: new Request(`${ORIGIN}/logout`, { method: "POST", headers: { Cookie: cookie!, Origin: ORIGIN, Host: "localhost:5173" } }),
      params: {},
      context: {},
    })) as Response;
    expect(res.headers.get("location")).toBe("/");
    expect(cookieFrom(res)).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });
});
