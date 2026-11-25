/**
 * Billing integration: real Postgres and the real webhook route, with the Paddle
 * API mocked at the fetch layer. Skipped unless TEST_DATABASE_URL is set.
 * It TRUNCATEs every table.
 */
import { createHmac, randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const DB = process.env.TEST_DATABASE_URL;
const SECRET = "pdl_ntfset_test";

type Call = { method: string; url: string; body: any; headers: Headers };
const calls: Call[] = [];
let remote: Record<string, any> = {}; // Paddle's current subscription state, keyed by ID
let apiDown = false;

const res = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let seq = 0;
const evt = (event_type: string, data: Record<string, unknown>) => ({
  event_id: `evt_${String(++seq).padStart(26, "0")}`,
  event_type,
  occurred_at: new Date().toISOString(),
  notification_id: `ntf_${seq}`,
  data,
});

const sub = (id: string, over: Partial<{ status: string; price: string; cancel: boolean; customer: string }> = {}) => ({
  id,
  status: over.status ?? "active",
  customer_id: over.customer ?? "ctm_1",
  items: [{ price: { id: over.price ?? "pri_pro" }, quantity: 1 }],
  current_billing_period: over.status === "canceled" ? null : { starts_at: "2026-11-25T00:00:00Z", ends_at: "2026-12-25T00:00:00Z" },
  scheduled_change: over.cancel ? { action: "cancel", effective_at: "2026-12-25T00:00:00Z" } : null,
});

describe.skipIf(!DB)("billing (integration)", () => {
  let prisma: typeof import("./db.server").prisma;
  let billing: typeof import("./billing.server");
  let webhook: typeof import("~/routes/webhooks.paddle").action;
  let alice: { id: string; email: string; paddleCustomerId: string | null };
  let mallory: { id: string };
  const ctx = { ipAddress: null, userAgent: "test" };

  const deliver = async (event: object, opts: { sign?: boolean; ts?: number } = {}) => {
    const raw = JSON.stringify(event);
    const ts = opts.ts ?? Math.floor(Date.now() / 1000);
    const h1 = createHmac("sha256", opts.sign === false ? "wrong" : SECRET).update(`${ts}:${raw}`).digest("hex");
    const response = await webhook({
      request: new Request("http://localhost/webhooks/paddle", {
        method: "POST",
        headers: { "paddle-signature": `ts=${ts};h1=${h1}`, "content-type": "application/json" },
        body: raw,
      }),
      params: {},
      context: {},
    });
    return { status: response.status, body: (await response.json()) as any };
  };

  const userPlan = async (id: string) => (await prisma.user.findUniqueOrThrow({ where: { id } })).plan;

  beforeAll(async () => {
    process.env.DATABASE_URL = DB;
    process.env.MASTER_ENCRYPTION_KEY = randomBytes(32).toString("hex");

    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push({ method, url: url.toString(), body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init?.headers) });
      if (apiDown) return res(503, { error: { detail: "down" } });
      if (method === "POST" && url.pathname === "/transactions") return res(201, { data: { id: `txn_${calls.length}` } });
      const m = url.pathname.match(/^\/subscriptions\/(sub_\w+)$/);
      if (m && method === "GET") return remote[m[1]] ? res(200, { data: remote[m[1]] }) : res(404, { error: {} });
      if (m && method === "PATCH") return res(200, { data: remote[m[1]] });
      if (url.pathname.endsWith("/cancel")) return res(200, { data: {} });
      if (url.pathname.endsWith("/portal-sessions")) return res(201, { data: { urls: { general: { overview: "https://portal.test/x" } } } });
      return res(404, { error: {} });
    });

    ({ prisma } = await import("./db.server"));
    billing = await import("./billing.server");
    ({ action: webhook } = await import("~/routes/webhooks.paddle"));
    const { saveProviderCredential } = await import("./credentials.server");

    await prisma.$executeRawUnsafe(
      `TRUNCATE "WebhookEvent","BillingCheckout","Subscription","AuditLog","Resource","ProviderCredential","AdminRole","User" CASCADE`,
    );
    const a = await prisma.user.create({ data: { email: "alice@test.dev" } });
    alice = { id: a.id, email: a.email, paddleCustomerId: null };
    mallory = await prisma.user.create({ data: { email: "mallory@test.dev" } });

    for (const [field, value] of [
      ["apiKey", "pdl_sdbx_apikey"],
      ["webhookSecret", SECRET],
      ["environment", "sandbox"],
      ["clientToken", "test_client"],
      ["priceIdPro", "pri_pro"],
      ["priceIdTeam", "pri_team"],
    ] as const) {
      await saveProviderCredential({ provider: "PADDLE", field, value, actorId: a.id, ...ctx });
    }
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await prisma?.$disconnect();
  });

  beforeEach(() => {
    calls.length = 0;
    apiDown = false;
  });

  let aliceTxn: string;

  it("starts checkout by creating a sandbox transaction and recording it", async () => {
    aliceTxn = await billing.startCheckout({ ...alice, context: ctx }, "PRO");
    const c = calls[0];
    expect(c.url).toBe("https://sandbox-api.paddle.com/transactions");
    expect(c.headers.get("authorization")).toBe("Bearer pdl_sdbx_apikey");
    expect(c.headers.get("paddle-version")).toBe("1");
    expect(c.body).toEqual({ items: [{ price_id: "pri_pro", quantity: 1 }], custom_data: { veltrix_user_id: alice.id } });
    expect(await prisma.billingCheckout.findUnique({ where: { transactionId: aliceTxn } })).toMatchObject({ userId: alice.id, plan: "PRO" });
  });

  it("rejects bad signatures and stale timestamps without changing anything", async () => {
    remote.sub_a = sub("sub_a");
    const e = evt("subscription.created", { id: "sub_a", transaction_id: aliceTxn });
    expect((await deliver(e, { sign: false })).status).toBe(401);
    expect((await deliver(e, { ts: Math.floor(Date.now() / 1000) - 600 })).status).toBe(401);
    expect(await userPlan(alice.id)).toBe("FREE");
    expect(await prisma.webhookEvent.count()).toBe(0);
  });

  it("activates the plan on subscription.created and stays idempotent on redelivery", async () => {
    const e = evt("subscription.created", { id: "sub_a", transaction_id: aliceTxn, status: "active" });
    expect(await deliver(e)).toEqual({ status: 200, body: { ok: true, result: "processed" } });
    expect(await userPlan(alice.id)).toBe("PRO");

    const s = await prisma.subscription.findUniqueOrThrow({ where: { userId: alice.id } });
    expect(s).toMatchObject({ paddleSubscriptionId: "sub_a", status: "ACTIVE", plan: "PRO", cancelAtPeriodEnd: false });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: alice.id } })).paddleCustomerId).toBe("ctm_1");

    calls.length = 0;
    expect((await deliver(e)).body.result).toBe("duplicate");
    expect(calls).toHaveLength(0);
  });

  it("ignores a forged subscription that names another user in custom_data", async () => {
    // Mallory checks out with Paddle.js directly, claiming to be Alice's teammate, with no server transaction.
    remote.sub_m = sub("sub_m", { price: "pri_team", customer: "ctm_m" });
    const e = evt("subscription.created", { id: "sub_m", transaction_id: "txn_forged", custom_data: { veltrix_user_id: mallory.id } });
    expect((await deliver(e)).body.result).toBe("ignored");
    expect(await userPlan(mallory.id)).toBe("FREE");
    expect(await prisma.auditLog.count({ where: { action: "billing.unmatched_subscription", targetId: "sub_m" } })).toBe(1);
  });

  it("applies Paddle's current state, so out-of-order events can't regress it", async () => {
    // Paddle now says: Team, cancels at period end.
    remote.sub_a = sub("sub_a", { price: "pri_team", cancel: true });
    expect((await deliver(evt("subscription.updated", { id: "sub_a", status: "active" }))).status).toBe(200);
    expect(await userPlan(alice.id)).toBe("TEAM");

    // An older "past_due/pro" event arrives late. The handler refetches the current state, which is unchanged.
    expect((await deliver(evt("subscription.past_due", { id: "sub_a", status: "past_due" }))).status).toBe(200);
    const s = await prisma.subscription.findUniqueOrThrow({ where: { userId: alice.id } });
    expect(s).toMatchObject({ plan: "TEAM", status: "ACTIVE", cancelAtPeriodEnd: true });
  });

  it("blocks a downgrade that current usage doesn't fit", async () => {
    remote.sub_a = sub("sub_a", { price: "pri_team" });
    await billing.syncSubscription("sub_a", alice.id);
    await prisma.resource.createMany({
      data: Array.from({ length: 6 }, (_, i) => ({
        ownerId: alice.id, type: "APP" as const, provider: "FLY" as const, name: `app-${i}`, region: "iad", size: "shared-1x-256", status: "ACTIVE" as const,
      })),
    });
    await expect(billing.changePlan({ ...alice, context: ctx }, "PRO")).rejects.toThrow(/exceed the PRO plan limits \(app\)/);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    await prisma.resource.deleteMany({ where: { ownerId: alice.id } });

    await billing.changePlan({ ...alice, context: ctx }, "PRO");
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toEqual({ items: [{ price_id: "pri_pro", quantity: 1 }], proration_billing_mode: "prorated_immediately" });
  });

  it("returns 500 without recording the event when Paddle's API fails, then succeeds on redelivery", async () => {
    const e = evt("subscription.canceled", { id: "sub_a", status: "canceled" });
    remote.sub_a = sub("sub_a", { status: "canceled", price: "pri_team" });

    apiDown = true;
    expect((await deliver(e)).status).toBe(500);
    expect(await prisma.webhookEvent.findUnique({ where: { id: e.event_id } })).toBeNull();
    expect(await userPlan(alice.id)).not.toBe("FREE");

    apiDown = false;
    expect((await deliver(e)).body.result).toBe("processed");
    expect(await userPlan(alice.id)).toBe("FREE");
    expect((await billing.getBillingState(alice.id)).subscription).toBeNull();
  });

  it("refuses a second checkout while a subscription is live", async () => {
    remote.sub_a = sub("sub_a");
    await billing.syncSubscription("sub_a", alice.id);
    await expect(billing.startCheckout({ ...alice, context: ctx }, "TEAM")).rejects.toThrow(/already have a subscription/);
  });
});
