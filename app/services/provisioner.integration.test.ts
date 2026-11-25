/**
 * Integration test for the provisioner against a real Postgres, with the
 * provider HTTP APIs mocked at the fetch layer.
 *
 *   TEST_DATABASE_URL=postgresql://… npx vitest run provisioner
 *
 * Skipped when TEST_DATABASE_URL is unset. It TRUNCATEs every table, so never point it at real data.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const DB = process.env.TEST_DATABASE_URL;

type Call = { method: string; path: string; body: any; auth: string | null };
type Handler = (method: string, url: URL) => Response | Promise<Response>;

const calls: Call[] = [];
let handler: Handler = () => new Response(null, { status: 500 });
const res = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe.skipIf(!DB)("provisioner (integration)", () => {
  let m: {
    prisma: typeof import("./db.server").prisma;
    provisionResource: typeof import("./provisioner.server").provisionResource;
    deprovisionResource: typeof import("./provisioner.server").deprovisionResource;
    requestDeletion: typeof import("./provisioner.server").requestDeletion;
    decryptResourceSecret: typeof import("./resources.server").decryptResourceSecret;
    saveProviderCredential: typeof import("./credentials.server").saveProviderCredential;
    revokeProviderCredential: typeof import("./credentials.server").revokeProviderCredential;
  };
  let ownerId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = DB;
    process.env.MASTER_ENCRYPTION_KEY = randomBytes(32).toString("hex");

    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      calls.push({ method, path: url.pathname + url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.get("authorization") });
      return handler(method, url);
    });

    const [db, prov, res, cred] = await Promise.all([
      import("./db.server"),
      import("./provisioner.server"),
      import("./resources.server"),
      import("./credentials.server"),
    ]);
    m = { prisma: db.prisma, ...prov, decryptResourceSecret: res.decryptResourceSecret, saveProviderCredential: cred.saveProviderCredential, revokeProviderCredential: cred.revokeProviderCredential };

    await m.prisma.$executeRawUnsafe(`TRUNCATE "AuditLog","Resource","ProviderCredential","AdminRole","User" CASCADE`);
    ownerId = (await m.prisma.user.create({ data: { email: "tenant@test.dev" } })).id;

    const ctx = { actorId: ownerId, ipAddress: null, userAgent: "test" };
    for (const [provider, field, value] of [
      ["FLY", "apiToken", "fly-token"],
      ["FLY", "orgSlug", "my-org"],
      ["NEON", "apiKey", "neon-key"],
      ["UPSTASH", "email", "ops@test.dev"],
      ["UPSTASH", "apiKey", "up-key"],
    ] as const) {
      await m.saveProviderCredential({ provider, field, value, ...ctx });
    }
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await m?.prisma.$disconnect();
  });

  beforeEach(() => {
    calls.length = 0;
  });

  const newResource = (type: "APP" | "WORKER" | "POSTGRES" | "REDIS", name: string, extra: Record<string, unknown> = {}) =>
    m.prisma.resource.create({
      data: {
        ownerId,
        type,
        name,
        provider: type === "POSTGRES" ? "NEON" : type === "REDIS" ? "UPSTASH" : "FLY",
        region: type === "POSTGRES" ? "aws-us-east-1" : type === "REDIS" ? "us-east-1" : "iad",
        size: type === "POSTGRES" ? "launch-1cu" : type === "REDIS" ? "payg" : "shared-1x-256",
        status: "PENDING",
        ...extra,
      },
    });

  const neonHappy: Handler = (method, url) => {
    if (method === "POST" && url.pathname === "/api/v2/projects") {
      return res(201, {
        project: { id: "proj-1" },
        connection_uris: [{ connection_uri: "postgresql://app:s3cr3t-pw@ep-1.neon.tech/neondb", connection_parameters: { host: "ep-1.neon.tech" } }],
        operations: [{ id: "op-1", status: "running" }],
      });
    }
    if (url.pathname === "/api/v2/projects/proj-1/operations/op-1") return res(200, { operation: { id: "op-1", status: "finished" } });
    if (method === "DELETE" && url.pathname === "/api/v2/projects/proj-1") return res(200, { project: { id: "proj-1" } });
    return res(404, { message: "unexpected " + url.pathname });
  };

  it("provisions Postgres on Neon and stores the connection string encrypted", async () => {
    handler = neonHappy;
    const r = await newResource("POSTGRES", "main-db");
    await m.provisionResource(r.id);

    const row = await m.prisma.resource.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.status).toBe("ACTIVE");
    expect(row.externalId).toBe("proj-1");
    expect(row.lockedUntil).toBeNull();
    expect((row.config as any).hostname).toBe("ep-1.neon.tech");
    expect(row.secretCiphertext).not.toContain("s3cr3t");
    expect(m.decryptResourceSecret(row)).toBe("postgresql://app:s3cr3t-pw@ep-1.neon.tech/neondb");

    const create = calls.find((c) => c.method === "POST")!;
    expect(create.auth).toBe("Bearer neon-key");
    expect(create.body.project).toMatchObject({
      name: `vx-${r.id}`,
      region_id: "aws-us-east-1",
      default_endpoint_settings: { autoscaling_limit_min_cu: 0.25, autoscaling_limit_max_cu: 1 },
    });
    expect(create.body.project.org_id).toBeUndefined();
  });

  it("only one worker wins when two race for the same row", async () => {
    let creates = 0;
    handler = async (method, url) => {
      if (method === "POST") {
        creates++;
        await new Promise((r) => setTimeout(r, 150));
      }
      return neonHappy(method, url);
    };
    const r = await newResource("POSTGRES", "race-db");
    await Promise.all([m.provisionResource(r.id), m.provisionResource(r.id), m.provisionResource(r.id)]);
    expect(creates).toBe(1);
    expect((await m.prisma.resource.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("ACTIVE");
  });

  it("fails Upstash permanently when no password comes back, and deletes the orphan", async () => {
    handler = (method, url) => {
      if (method === "POST" && url.pathname === "/v2/redis/database") return res(200, { database_id: "db-1", endpoint: "ok-cat-1", port: 6379 });
      if (method === "DELETE" && url.pathname === "/v2/redis/database/db-1") return res(200, "OK");
      return res(404);
    };
    const r = await newResource("REDIS", "cache");
    await m.provisionResource(r.id);

    const row = await m.prisma.resource.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.status).toBe("FAILED");
    expect(row.externalId).toBeNull();
    expect(row.errorMessage).toBe("The upstream provider rejected the request.");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /v2/redis/database", "DELETE /v2/redis/database/db-1"]);
    expect(calls[0].auth).toBe(`Basic ${Buffer.from("ops@test.dev:up-key").toString("base64")}`);
    expect(calls[0].body).toEqual({ database_name: `vx-${r.id}`, platform: "aws", primary_region: "us-east-1", tls: true, plan: "payg" });
  });

  it("retries a Fly app after a transient error and resumes idempotently", async () => {
    const r = await newResource("APP", "web");
    const app = `vx-${r.id}`;

    // Attempt 1: the app is created, then the machine create returns 503.
    handler = (method, url) => {
      if (method === "POST" && url.pathname === "/v1/apps") return res(201, {});
      if (url.pathname === `/v1/apps/${app}/ip_assignments`) return res(200, {});
      if (method === "GET" && url.pathname === `/v1/apps/${app}/machines`) return res(200, []);
      if (method === "POST" && url.pathname === `/v1/apps/${app}/machines`) return res(503, { error: "capacity" });
      return res(404);
    };
    await m.provisionResource(r.id);
    let row = await m.prisma.resource.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(1);
    expect(row.externalId).toBe(app);
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(row.errorMessage).toMatch(/keep retrying/);

    // While the retry delay is pending, workers leave the row alone.
    calls.length = 0;
    await m.provisionResource(r.id);
    expect(calls).toHaveLength(0);

    // Attempt 2: the app already exists (422) and belongs to our org, so it's reused.
    await m.prisma.resource.update({ where: { id: r.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    handler = (method, url) => {
      if (method === "POST" && url.pathname === "/v1/apps") return res(422, { error: "already exists" });
      if (method === "GET" && url.pathname === `/v1/apps/${app}`) return res(200, { organization: { slug: "my-org" } });
      if (url.pathname === `/v1/apps/${app}/ip_assignments`) return res(422, { error: "already allocated" });
      if (method === "GET" && url.pathname === `/v1/apps/${app}/machines`) return res(200, []);
      if (method === "POST" && url.pathname === `/v1/apps/${app}/machines`) return res(200, { id: "m-1" });
      if (url.pathname === `/v1/apps/${app}/machines/m-1/wait`) return res(200, { ok: true });
      return res(404);
    };
    await m.provisionResource(r.id);
    row = await m.prisma.resource.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.status).toBe("ACTIVE");
    expect(row.attempts).toBe(2);
    expect(row.config).toMatchObject({ machineId: "m-1", hostname: `${app}.fly.dev`, network: `vx-net-${ownerId}` });
    expect(m.decryptResourceSecret(row)).toBeNull();

    const appCreate = calls.find((c) => c.path === "/v1/apps")!;
    expect(appCreate.auth).toBe("Bearer fly-token");
    expect(appCreate.body).toEqual({ app_name: app, org_slug: "my-org", network: `vx-net-${ownerId}` });
    const machine = calls.find((c) => c.method === "POST" && c.path.endsWith("/machines"))!.body;
    expect(machine.region).toBe("iad");
    expect(machine.config.image).toBe("flyio/hellofly:latest");
    expect(machine.config.guest).toEqual({ cpu_kind: "shared", cpus: 1, memory_mb: 256 });
    expect(machine.config.services[0]).toMatchObject({ internal_port: 8080, autostart: true });
  });

  it("deletes a resource upstream, clears its secret, and frees the name", async () => {
    handler = neonHappy;
    const r = await m.prisma.resource.findFirstOrThrow({ where: { name: "main-db" } });

    const req = await m.requestDeletion(r.id, "someone-else");
    expect(req.ok).toBe(false); // another tenant's ID looks like it doesn't exist

    const ok = await m.requestDeletion(r.id, ownerId);
    expect(ok.ok && ok.resource.status).toBe("DELETING");
    await m.deprovisionResource(r.id);

    const row = await m.prisma.resource.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.status).toBe("DELETED");
    expect(row.secretCiphertext).toBeNull();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toContain("DELETE /api/v2/projects/proj-1");

    await expect(newResource("POSTGRES", "main-db")).resolves.toBeTruthy(); // the name is reusable
    await expect(newResource("POSTGRES", "main-db")).rejects.toMatchObject({ code: "P2002" }); // but only one live copy
  });

  it("fails with a generic message when a provider isn't configured", async () => {
    await m.revokeProviderCredential({ provider: "FLY", field: "apiToken", actorId: ownerId, ipAddress: null, userAgent: "test" });
    const r = await newResource("WORKER", "jobs");
    await m.provisionResource(r.id);

    const row = await m.prisma.resource.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.status).toBe("FAILED");
    expect(row.externalId).toBeNull();
    expect(row.errorMessage).toBe("This service is temporarily unavailable. Our team has been notified.");
    expect(calls).toHaveLength(0);
  });
});
