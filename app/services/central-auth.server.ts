/**
 * NazmulCodes Auth (central SSO): a thin wrapper around the official SDK
 * (app/lib/nazmulcodes-auth.server.ts, vendored unchanged).
 *
 * - Config comes from Admin → Providers → NazmulCodes Auth (encrypted), with
 *   NAZMULCODES_AUTH_* environment fallbacks (see credentials.server.ts).
 * - Every SDK failure is mapped to a CentralAuthError with a small `reason`
 *   the routes can act on. Logs carry the operation, reason, status and error
 *   code only: never codes, API keys or user objects.
 */
import { Prisma } from "@prisma/client";
import {
  NazmulCodesAuthClient,
  NazmulCodesAuthError,
  type VerifiedCentralUser,
} from "~/lib/nazmulcodes-auth.server";
import { CredentialIntegrityError, ProviderNotConfiguredError, getProviderCredentials } from "./credentials.server";
import { fingerprint } from "./crypto.server";

export type CentralAuthReason =
  | "not_configured" // missing or malformed settings (including a key that isn't nc_live_…)
  | "unreachable" // network error, timeout or 5xx
  | "client_rejected" // invalid_client or origin_not_allowed: bad or rotated API key
  | "client_suspended" // Veltrix is suspended in the auth admin
  | "invalid_grant" // code wrong, expired, reused, or redirect_uri mismatch
  | "access_denied" // the central user is suspended
  | "invalid_request"
  | "internal"; // a Veltrix-side failure (e.g. the database), not the auth service

export class CentralAuthError extends Error {
  constructor(
    readonly reason: CentralAuthReason,
    readonly status: number,
    readonly code: string,
  ) {
    super(`NazmulCodes Auth ${reason} (${status} ${code})`);
    this.name = "CentralAuthError";
  }
}

const CODE_TO_REASON: Record<string, CentralAuthReason> = {
  invalid_grant: "invalid_grant",
  access_denied: "access_denied",
  client_suspended: "client_suspended",
  invalid_client: "client_rejected",
  origin_not_allowed: "client_rejected",
  invalid_request: "invalid_request",
  network_error: "unreachable",
};

function classify(err: unknown): CentralAuthError {
  if (err instanceof CentralAuthError) return err;
  if (err instanceof ProviderNotConfiguredError || err instanceof CredentialIntegrityError) {
    return new CentralAuthError("not_configured", 0, err.name);
  }
  if (err instanceof NazmulCodesAuthError) {
    const reason = CODE_TO_REASON[err.code] ?? (err.status === 0 || err.status >= 500 ? "unreachable" : "client_rejected");
    return new CentralAuthError(reason, err.status, err.code);
  }
  // The SDK constructor throws a plain Error for a malformed key or URL.
  if (err instanceof Error && (err.message.startsWith("NazmulCodesAuthClient") || err instanceof TypeError)) {
    return new CentralAuthError("not_configured", 0, "invalid_config");
  }
  // Anything else failed inside Veltrix (database, bug), not at the auth service.
  // Log the Prisma error code when there is one (e.g. P2021: table missing, so migrations weren't run).
  if (err instanceof Prisma.PrismaClientKnownRequestError) return new CentralAuthError("internal", 0, err.code);
  return new CentralAuthError("internal", 0, err instanceof Error ? err.name : "unknown");
}

function log(op: string, e: CentralAuthError) {
  const entry = { op, reason: e.reason, status: e.status, code: e.code };
  // invalid_grant (a reused or stale callback URL) is routine. Anything else needs attention.
  if (e.reason === "invalid_grant") console.warn("[central-auth]", entry);
  else console.error("[central-auth]", entry);
}

// ─── Client (rebuilt whenever the settings change) ──────────────────────────

const DEFAULT_AUTH_URL = "https://auth.nazmulcodes.org";
let cached: { key: string; client: NazmulCodesAuthClient } | null = null;

async function getClient(): Promise<NazmulCodesAuthClient> {
  const c = await getProviderCredentials("NAZMULCODES");
  const authBaseUrl = c.authUrl || DEFAULT_AUTH_URL;
  // The cache key holds a fingerprint of the API key, never the key itself.
  const key = [authBaseUrl, c.redirectUri, c.clientId ?? "", fingerprint(c.apiKey)].join("|");
  if (cached?.key === key) return cached.client;

  const client = new NazmulCodesAuthClient({
    authBaseUrl,
    apiKey: c.apiKey,
    redirectUri: c.redirectUri,
    clientId: c.clientId || undefined,
  });
  await client.resolveClientId(); // returns at once when clientId is configured
  cached = { key, client };
  return client;
}

/** For tests, and after settings change outside the credential cache. */
export function resetCentralAuthClient() {
  cached = null;
}

async function call<T>(op: string, fn: (client: NazmulCodesAuthClient) => T | Promise<T>): Promise<T> {
  try {
    return await fn(await getClient());
  } catch (err) {
    const e = classify(err);
    log(op, e);
    throw e;
  }
}

// ─── Operations ─────────────────────────────────────────────────────────────

export function newState(): string {
  return NazmulCodesAuthClient.generateState();
}

export function buildAuthorizationUrl(state: string): Promise<string> {
  return call("authorize", (c) => c.getAuthorizationUrl(state));
}

/** Single-use code, valid for 60s. Exchange it immediately. */
export function exchangeCode(code: string): Promise<VerifiedCentralUser> {
  return call("token", (c) => c.exchangeCodeForUser(code));
}

export function verifyCentralUser(centralUserId: string): Promise<{ valid: boolean; user?: VerifiedCentralUser }> {
  return call("verify-user", (c) => c.verifyUserStatus(centralUserId));
}

export type { VerifiedCentralUser };
