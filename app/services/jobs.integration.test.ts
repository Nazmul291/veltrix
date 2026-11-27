/**
 * Serverless job driving: the Vercel Cron endpoint, tenant-scoped sweeps and
 * sweep time budgets. No provider keys are configured, so each provisioning
 * attempt fails fast (FAILED), which is enough to count what a sweep touched.
 * Skipped unless TEST_DATABASE_URL is set. It TRUNCATEs every table.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeDatabaseUrl } from "./db.server";

describe("runtimeDatabaseUrl", () => {
  it("prefers the pooled URL", () => {
    const url = runtimeDatabaseUrl({ DATABASE_URL: "postgres://u:p@db.prisma.io:5432/postgres", DATABASE_URL_POOLED: "postgres://u:p@pooled.db.prisma.io:5432/postgres?sslmode=require" });
    expect(url).toBe("postgres://u:p@pooled.db.prisma.io:5432/postgres?sslmode=verify-full");
  });
  it("upgrades weaker sslmodes to verify-full and leaves local URLs alone", () => {
    for (const mode of ["prefer", "require", "verify-ca"]) {
      expect(runtimeDatabaseUrl({ DATABASE_URL: `postgres://u:p@h:5432/d?sslmode=${mode}&x=1` })).toBe("postgres://u:p@h:5432/d?sslmode=verify-full&x=1");
    }
    expect(runtimeDatabaseUrl({ DATABASE_URL: "postgres://u:p@h/d?sslmode=disable" })).toBe("postgres://u:p@h/d?sslmode=disable");
    expect(runtimeDatabaseUrl({ DATABASE_URL: "postgresql://postgres:e2e@127.0.0.1:55432/veltrix" })).toBe("postgresql://postgres:e2e@127.0.0.1:55432/veltrix");
  });
  it("falls back to the direct URL", () => {
    expect(runtimeDatabaseUrl({ DATABASE_URL: "postgres://u:p@localhost/db", DATABASE_URL_POOLED: " " })).toBe("postgres://u:p@localhost/db");
  });
});

const DB = process.env.TEST_DATABASE_URL;

describe.skipIf(!DB)("serverless job driving (integration)", () => {
  let prisma: typeof import("./db.server").prisma;
  let jobs: typeof import("./jobs.server");
  let cron: typeof import("~/routes/api.cron.sweep").loader;
  let alice: string;
  let bob: string;

  const pending = (ownerId: string, name: string) =>
    prisma.resource.create({ data: { ownerId, type: "POSTGRES", provider: "NEON", name, region: "aws-us-east-1", size: "free-0.25cu", status: "PENDING" } });
  const statusOf = async (id: string) => (await prisma.resource.findUniqueOrThrow({ where: { id } })).status;
  const callCron = (auth?: string) =>
    cron({ request: new Request("http://localhost/api/cron/sweep", { headers: auth ? { authorization: auth } : {} }), params: {}, context: {} }) as Promise<Response>;

  beforeAll(async () => {
    process.env.DATABASE_URL = DB;
    process.env.MASTER_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    ({ prisma } = await import("./db.server"));
    jobs = await import("./jobs.server");
    ({ loader: cron } = await import("~/routes/api.cron.sweep"));
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  beforeEach(async () => {
    delete process.env.CRON_SECRET;
    await prisma.$executeRawUnsafe(
      `TRUNCATE "WebhookEvent","BillingCheckout","Subscription","AuditLog","Resource","ProviderCredential","AdminRole","User" CASCADE`,
    );
    alice = (await prisma.user.create({ data: { email: "alice@test.dev" } })).id;
    bob = (await prisma.user.create({ data: { email: "bob@test.dev" } })).id;
  });

  afterAll(async () => {
    delete process.env.CRON_SECRET;
    vi.restoreAllMocks();
    await prisma?.$disconnect();
  });

  it("the cron endpoint refuses to run without CRON_SECRET, and rejects a wrong token", async () => {
    const r = await pending(alice, "db-one");
    expect((await callCron()).status).toBe(503);

    process.env.CRON_SECRET = "s3cret-cron-token";
    expect((await callCron()).status).toBe(401);
    expect((await callCron("Bearer wrong")).status).toBe(401);
    expect((await callCron("s3cret-cron-token")).status).toBe(401); // the Bearer prefix is required
    expect(await statusOf(r.id)).toBe("PENDING");
  });

  it("the cron endpoint sweeps due work for every tenant with the right token", async () => {
    process.env.CRON_SECRET = "s3cret-cron-token";
    const a = await pending(alice, "db-a");
    const b = await pending(bob, "db-b");
    const res = await callCron("Bearer s3cret-cron-token");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, processed: 2 });
    expect([await statusOf(a.id), await statusOf(b.id)]).toEqual(["FAILED", "FAILED"]);
  });

  it("kickTenantJobs moves only that tenant's due work, and skips leased rows", async () => {
    const mine = await pending(alice, "db-mine");
    const leased = await pending(alice, "db-leased");
    await prisma.resource.update({ where: { id: leased.id }, data: { status: "PROVISIONING", lockedUntil: new Date(Date.now() + 60_000) } });
    const theirs = await pending(bob, "db-theirs");

    await jobs.kickTenantJobs(alice);
    await vi.waitFor(async () => expect(await statusOf(mine.id)).toBe("FAILED"));
    expect(await statusOf(leased.id)).toBe("PROVISIONING");
    expect(await statusOf(theirs.id)).toBe("PENDING");
  });

  it("a sweep stops starting new work once its time budget is spent", async () => {
    for (let i = 0; i < 4; i++) await pending(alice, `db-${i}`);
    const processed = await jobs.sweepOnce({ budgetMs: -1 });
    expect(processed).toBe(0);
    expect(await jobs.sweepOnce({ budgetMs: 60_000 })).toBe(4);
  });
});
