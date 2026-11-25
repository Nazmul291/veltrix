/**
 * Provider credential vault.
 *
 * The only module that decrypts provider keys. Provider services
 * (fly/neon/upstash.server.ts) call `getProviderCredentials("FLY")` when they
 * need a key. Plaintext never leaves the server process: loaders and actions
 * only ever get `listProviderCredentialStatus()` metadata.
 */
import { Prisma } from "@prisma/client";
import { getProviderFields, type ProviderId, type ProviderSecrets } from "~/lib/providers";
import type { CredentialFieldStatus } from "~/lib/schemas/provider-credential";
import { writeAuditLog, type RequestContext } from "./audit.server";
import { DecryptionError, decrypt, encrypt, fingerprint } from "./crypto.server";
import { prisma } from "./db.server";

export class ProviderNotConfiguredError extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly missing: string[],
  ) {
    super(`Provider ${provider} is not configured (missing: ${missing.join(", ")}). Configure it at /admin/providers.`);
    this.name = "ProviderNotConfiguredError";
  }
}

export class CredentialIntegrityError extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly field: string,
    readonly version: number,
  ) {
    super(`Stored credential ${provider}.${field} v${version} failed authentication. It may have been tampered with, or the master key changed.`);
    this.name = "CredentialIntegrityError";
  }
}

const aadFor = (provider: ProviderId, field: string, version: number) =>
  `provider-credential:${provider}:${field}:v${version}`;

// ─── Read path (server-side API calls) ──────────────────────────────────────

/**
 * Short in-process cache, so a burst of provisioning calls doesn't decrypt the
 * same key many times. A rotation clears it on this instance. Other instances
 * pick up the change within CACHE_TTL_MS.
 */
const CACHE_TTL_MS = 60_000;
const cache = new Map<ProviderId, { value: Record<string, string>; expiresAt: number }>();

export function invalidateCredentialCache(provider?: ProviderId) {
  if (provider) cache.delete(provider);
  else cache.clear();
}

export async function getProviderCredentials<P extends ProviderId>(provider: P): Promise<ProviderSecrets<P>> {
  const hit = cache.get(provider);
  if (hit && hit.expiresAt > Date.now()) return hit.value as ProviderSecrets<P>;

  const rows = await prisma.providerCredential.findMany({
    where: { provider, status: "ACTIVE" },
    orderBy: { version: "asc" },
    select: { id: true, field: true, version: true, ciphertext: true, iv: true, authTag: true, keyVersion: true },
  });

  const secrets: Record<string, string> = {};
  for (const row of rows) {
    if (!row.ciphertext || !row.iv || !row.authTag) continue;
    try {
      secrets[row.field] = decrypt(
        { ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag, keyVersion: row.keyVersion },
        { purpose: "credentials", aad: aadFor(provider, row.field, row.version) },
      );
    } catch (err) {
      if (err instanceof DecryptionError) throw new CredentialIntegrityError(provider, row.field, row.version);
      throw err;
    }
  }

  const missing = getProviderFields(provider)
    .filter((f) => f.required && !secrets[f.key])
    .map((f) => f.key);
  if (missing.length > 0) throw new ProviderNotConfiguredError(provider, missing);

  cache.set(provider, { value: secrets, expiresAt: Date.now() + CACHE_TTL_MS });

  // Best-effort usage stamp, written only on a cache miss so it stays cheap.
  void prisma.providerCredential
    .updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  return secrets as ProviderSecrets<P>;
}

// ─── Write path (admin panel) ───────────────────────────────────────────────

interface MutationActor extends RequestContext {
  actorId: string;
}

export interface SaveResult {
  version: number;
  fingerprint: string;
  unchanged: boolean;
}

/**
 * Create or rotate a credential field. It runs in a single transaction:
 * 1. Retire the current ACTIVE version: status ROTATED, ciphertext destroyed.
 * 2. Insert version N+1, encrypted with AAD bound to (provider, field, N+1).
 * 3. Write the audit log entry.
 * If two admins rotate at the same moment, the @@unique(provider, field, version)
 * constraint fails one of them with P2002. The caller reports that as a conflict.
 */
export async function saveProviderCredential(
  input: { provider: ProviderId; field: string; value: string } & MutationActor,
): Promise<SaveResult> {
  const { provider, field, value } = input;
  const fp = fingerprint(value);

  const result = await prisma.$transaction(async (tx) => {
    const current = await tx.providerCredential.findFirst({
      where: { provider, field },
      orderBy: { version: "desc" },
      select: { version: true, status: true, fingerprint: true },
    });

    if (current?.status === "ACTIVE" && current.fingerprint === fp) {
      return { version: current.version, fingerprint: fp, unchanged: true };
    }

    const version = (current?.version ?? 0) + 1;
    const now = new Date();
    const enc = encrypt(value, { purpose: "credentials", aad: aadFor(provider, field, version) });

    const retired = await tx.providerCredential.updateMany({
      where: { provider, field, status: "ACTIVE" },
      data: { status: "ROTATED", rotatedAt: now, ciphertext: null, iv: null, authTag: null },
    });

    const created = await tx.providerCredential.create({
      data: {
        provider,
        field,
        version,
        status: "ACTIVE",
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        authTag: enc.authTag,
        keyVersion: enc.keyVersion,
        fingerprint: fp,
        createdById: input.actorId,
      },
      select: { id: true },
    });

    await writeAuditLog(tx, {
      actorId: input.actorId,
      action: retired.count > 0 ? "provider_credential.rotated" : "provider_credential.created",
      targetType: "ProviderCredential",
      targetId: created.id,
      metadata: { provider, field, version, fingerprint: fp, previousVersion: current?.version ?? null },
      context: input,
    });

    return { version, fingerprint: fp, unchanged: false };
  });

  invalidateCredentialCache(provider);
  return result;
}

/** Revokes the active version and destroys its ciphertext. Returns false if nothing was active. */
export async function revokeProviderCredential(
  input: { provider: ProviderId; field: string } & MutationActor,
): Promise<boolean> {
  const { provider, field } = input;

  const revoked = await prisma.$transaction(async (tx) => {
    const active = await tx.providerCredential.findFirst({
      where: { provider, field, status: "ACTIVE" },
      select: { id: true, version: true, fingerprint: true },
    });
    if (!active) return false;

    await tx.providerCredential.update({
      where: { id: active.id },
      data: { status: "REVOKED", revokedAt: new Date(), ciphertext: null, iv: null, authTag: null },
    });

    await writeAuditLog(tx, {
      actorId: input.actorId,
      action: "provider_credential.revoked",
      targetType: "ProviderCredential",
      targetId: active.id,
      metadata: { provider, field, version: active.version, fingerprint: active.fingerprint },
      context: input,
    });
    return true;
  });

  invalidateCredentialCache(provider);
  return revoked;
}

// ─── Metadata for the admin UI (no secrets) ─────────────────────────────────

export async function listProviderCredentialStatus(): Promise<Record<ProviderId, CredentialFieldStatus[]>> {
  const rows = await prisma.providerCredential.findMany({
    where: { status: "ACTIVE" },
    // The explicit select keeps ciphertext, IV and tag out of the result.
    select: {
      provider: true,
      field: true,
      version: true,
      fingerprint: true,
      createdAt: true,
      lastUsedAt: true,
      createdBy: { select: { email: true } },
    },
  });

  const byKey = new Map(rows.map((r) => [`${r.provider}:${r.field}`, r]));
  const providers = ["FLY", "NEON", "UPSTASH", "PADDLE"] as const satisfies readonly ProviderId[];

  return Object.fromEntries(
    providers.map((p) => [
      p,
      getProviderFields(p).map((f): CredentialFieldStatus => {
        const row = byKey.get(`${p}:${f.key}`);
        return {
          field: f.key,
          configured: Boolean(row),
          version: row?.version ?? null,
          fingerprint: row?.fingerprint ?? null,
          updatedAt: row?.createdAt.toISOString() ?? null,
          updatedBy: row?.createdBy?.email ?? null,
          lastUsedAt: row?.lastUsedAt?.toISOString() ?? null,
        };
      }),
    ]),
  ) as Record<ProviderId, CredentialFieldStatus[]>;
}

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}
