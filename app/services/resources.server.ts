import type { Resource } from "@prisma/client";
import type { ResourceDTO } from "~/lib/schemas/resource";
import { decrypt, encrypt, type EncryptedPayload } from "./crypto.server";

/** Non-secret, provider-specific details kept on Resource.config. */
export interface ResourceConfig {
  image?: string;
  port?: number;
  hostname?: string;
  machineId?: string;
  network?: string;
}

export function readConfig(r: Pick<Resource, "config">): ResourceConfig {
  return r.config && typeof r.config === "object" && !Array.isArray(r.config) ? (r.config as ResourceConfig) : {};
}

export function toResourceDTO(r: Resource): ResourceDTO {
  return {
    id: r.id,
    type: r.type,
    provider: r.provider,
    name: r.name,
    region: r.region,
    size: r.size,
    status: r.status,
    monthlyCostCents: r.monthlyCostCents,
    errorMessage: r.errorMessage,
    hostname: readConfig(r).hostname ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

// ─── Tenant connection secrets (DATABASE_URL, REDIS_URL) ────────────────────
// They use the "resource-secrets" subkey, separate from provider credentials,
// and the AAD binds each one to its resource row.

const aadFor = (resourceId: string) => `resource-secret:${resourceId}`;

export function encryptResourceSecret(resourceId: string, secret: string) {
  const enc = encrypt(secret, { purpose: "resource-secrets", aad: aadFor(resourceId) });
  return { secretCiphertext: enc.ciphertext, secretIv: enc.iv, secretAuthTag: enc.authTag };
}

export function decryptResourceSecret(
  r: Pick<Resource, "id" | "secretCiphertext" | "secretIv" | "secretAuthTag">,
): string | null {
  if (!r.secretCiphertext || !r.secretIv || !r.secretAuthTag) return null;
  const payload: EncryptedPayload = { ciphertext: r.secretCiphertext, iv: r.secretIv, authTag: r.secretAuthTag, keyVersion: 1 };
  return decrypt(payload, { purpose: "resource-secrets", aad: aadFor(r.id) });
}

export const CLEARED_SECRET = { secretCiphertext: null, secretIv: null, secretAuthTag: null } as const;

/** A tenant's live resources, newest first. Shared by the dashboard loader and GET /api/resources. */
export async function listTenantResources(ownerId: string) {
  const { prisma } = await import("./db.server");
  const rows = await prisma.resource.findMany({
    where: { ownerId, status: { not: "DELETED" } },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toResourceDTO);
}
