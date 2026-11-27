/**
 * Credential resolution order for NazmulCodes settings: database → environment variable → default.
 * Skipped unless TEST_DATABASE_URL is set. It TRUNCATEs every table.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB = process.env.TEST_DATABASE_URL;

describe.skipIf(!DB)("provider credentials with environment fallback", () => {
  let cred: typeof import("./credentials.server");
  let prisma: typeof import("./db.server").prisma;
  let actorId: string;

  const ENV_KEYS = ["NAZMULCODES_AUTH_API_KEY", "NAZMULCODES_AUTH_REDIRECT_URI", "NAZMULCODES_AUTH_URL", "NAZMULCODES_AUTH_CLIENT_ID"];

  beforeAll(async () => {
    process.env.DATABASE_URL = DB;
    process.env.MASTER_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    cred = await import("./credentials.server");
    ({ prisma } = await import("./db.server"));
    // Start clean. This runs after the imports on purpose: Prisma Client loads the
    // project's .env into process.env, and an earlier test file may have left values behind.
    for (const k of ENV_KEYS) delete process.env[k];
    await prisma.$executeRawUnsafe(
      `TRUNCATE "WebhookEvent","BillingCheckout","Subscription","AuditLog","Resource","ProviderCredential","AdminRole","User" CASCADE`,
    );
    actorId = (await prisma.user.create({ data: { email: "admin@test.dev" } })).id;
  });

  afterAll(async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    await prisma?.$disconnect();
  });

  it("reports which required fields are missing when nothing is configured", async () => {
    cred.invalidateCredentialCache();
    await expect(cred.getProviderCredentials("NAZMULCODES")).rejects.toMatchObject({ missing: ["apiKey", "redirectUri"] });
  });

  it("falls back to environment variables, and to the default auth URL", async () => {
    process.env.NAZMULCODES_AUTH_API_KEY = "nc_live_from_env";
    process.env.NAZMULCODES_AUTH_REDIRECT_URI = "http://localhost:5173/auth/callback";
    cred.invalidateCredentialCache();
    expect(await cred.getProviderCredentials("NAZMULCODES")).toEqual({
      apiKey: "nc_live_from_env",
      redirectUri: "http://localhost:5173/auth/callback",
      authUrl: "https://auth.nazmulcodes.org",
    });

    const status = (await cred.listProviderCredentialStatus()).NAZMULCODES;
    expect(status.find((s) => s.field === "apiKey")).toMatchObject({ configured: false, fromEnvironment: true });
    expect(status.find((s) => s.field === "clientId")).toMatchObject({ configured: false, fromEnvironment: false });
  });

  it("prefers the encrypted database value over the environment", async () => {
    await cred.saveProviderCredential({ provider: "NAZMULCODES", field: "apiKey", value: "nc_live_from_db", actorId, ipAddress: null, userAgent: "test" });
    const c = await cred.getProviderCredentials("NAZMULCODES");
    expect(c.apiKey).toBe("nc_live_from_db");
    expect(c.redirectUri).toBe("http://localhost:5173/auth/callback");

    const row = await prisma.providerCredential.findFirstOrThrow({ where: { provider: "NAZMULCODES", field: "apiKey" } });
    expect(row.ciphertext).not.toContain("nc_live");
    expect((await cred.listProviderCredentialStatus()).NAZMULCODES.find((s) => s.field === "apiKey")).toMatchObject({ configured: true, fromEnvironment: false });
  });
});
