/**
 * Provisioning state machine.
 *
 *   PENDING ─claim→ PROVISIONING ─ok→ ACTIVE ─request→ DELETING ─ok→ DELETED
 *                       │ transient error, attempts left → PENDING (delayed by lockedUntil)
 *                       └ permanent error or attempts used up → FAILED (upstream cleaned up)
 *
 * Concurrency: a worker claims a row with a conditional UPDATE that sets a lease
 * (lockedUntil). Only one worker in the cluster can hold the lease. If a worker
 * crashes, its lease expires and the sweeper re-claims the row.
 *
 * Leaks: every provider function reports the upstream ID through onExternalId
 * as soon as it exists, so every failure path can delete what was created.
 */
import type { Prisma, Resource } from "@prisma/client";
import { writeAuditLog } from "./audit.server";
import { CredentialIntegrityError, ProviderNotConfiguredError } from "./credentials.server";
import { prisma } from "./db.server";
import { destroyApp, provisionFlyResource } from "./fly.server";
import { ProviderApiError } from "./http.server";
import { deleteProject, provisionNeonDatabase } from "./neon.server";
import { CLEARED_SECRET, encryptResourceSecret, readConfig } from "./resources.server";
import { deleteDatabase, provisionUpstashRedis } from "./upstash.server";

export const LEASE_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [30_000, 120_000, 300_000];

const SYSTEM = { ipAddress: null, userAgent: "system:provisioner" };

interface Outcome {
  externalId: string;
  secret: string | null;
  config: Record<string, unknown>;
}

// ─── Claiming ───────────────────────────────────────────────────────────────

async function claim(id: string, statuses: ("PENDING" | "PROVISIONING" | "DELETING")[], nextStatus: "PROVISIONING" | "DELETING") {
  const now = new Date();
  const { count } = await prisma.resource.updateMany({
    where: { id, status: { in: statuses }, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
    data: { status: nextStatus, lockedUntil: new Date(now.getTime() + LEASE_MS), attempts: { increment: 1 } },
  });
  return count === 1 ? prisma.resource.findUnique({ where: { id } }) : null;
}

// ─── Upstream dispatch (each provider stays in its own module) ──────────────

function runProvider(r: Resource, onExternalId: (id: string) => Promise<void>): Promise<Outcome> {
  const cfg = readConfig(r);
  switch (r.type) {
    case "APP":
    case "WORKER":
      return provisionFlyResource(
        { resourceId: r.id, ownerId: r.ownerId, kind: r.type, region: r.region, size: r.size, image: cfg.image, port: cfg.port },
        onExternalId,
      );
    case "POSTGRES":
      return provisionNeonDatabase({ resourceId: r.id, region: r.region, size: r.size }, onExternalId);
    case "REDIS":
      return provisionUpstashRedis({ resourceId: r.id, region: r.region, size: r.size }, onExternalId);
  }
}

async function teardownUpstream(r: Pick<Resource, "type" | "externalId">): Promise<void> {
  if (!r.externalId) return;
  switch (r.type) {
    case "APP":
    case "WORKER":
      return destroyApp(r.externalId);
    case "POSTGRES":
      return deleteProject(r.externalId);
    case "REDIS":
      return deleteDatabase(r.externalId);
  }
}

/** Message safe to show the tenant. The detailed error is logged on the server only. */
function tenantMessage(err: unknown): string {
  if (err instanceof ProviderNotConfiguredError || err instanceof CredentialIntegrityError) {
    return "This service is temporarily unavailable. Our team has been notified.";
  }
  if (err instanceof ProviderApiError) {
    return err.retryable ? "The upstream provider is having trouble. We'll keep retrying." : "The upstream provider rejected the request.";
  }
  return "Provisioning failed due to an internal error.";
}

function isRetryable(err: unknown): boolean {
  return err instanceof ProviderApiError && err.retryable;
}

// ─── Provision ──────────────────────────────────────────────────────────────

export async function provisionResource(id: string): Promise<void> {
  const r = await claim(id, ["PENDING", "PROVISIONING"], "PROVISIONING");
  if (!r) return; // another worker has it, or it's not provisionable

  // Unlike Fly app names, Neon project and Upstash database IDs aren't
  // deterministic. Anything left by an earlier failed attempt is removed before starting over.
  if (r.externalId && (r.type === "POSTGRES" || r.type === "REDIS")) {
    try {
      await teardownUpstream(r);
      await prisma.resource.update({ where: { id }, data: { externalId: null } });
      r.externalId = null;
    } catch (err) {
      return handleFailure(r, err);
    }
  }

  const onExternalId = async (externalId: string) => {
    r.externalId = externalId;
    await prisma.resource.update({ where: { id }, data: { externalId } });
  };

  try {
    const outcome = await runProvider(r, onExternalId);
    const config = { ...readConfig(r), ...stripUndefined(outcome.config) } as Prisma.InputJsonObject;

    await prisma.$transaction([
      prisma.resource.update({
        where: { id },
        data: {
          status: "ACTIVE",
          externalId: outcome.externalId,
          config,
          ...(outcome.secret ? encryptResourceSecret(id, outcome.secret) : CLEARED_SECRET),
          errorMessage: null,
          lockedUntil: null,
        },
      }),
      prisma.auditLog.create({
        data: {
          actorId: null,
          action: "resource.provisioned",
          targetType: "Resource",
          targetId: id,
          metadata: { type: r.type, provider: r.provider, externalId: outcome.externalId, attempts: r.attempts },
          userAgent: SYSTEM.userAgent,
        },
      }),
    ]);
  } catch (err) {
    await handleFailure(r, err);
  }
}

async function handleFailure(r: Resource, err: unknown): Promise<void> {
  console.error("[provisioner] provision failed", {
    resourceId: r.id,
    type: r.type,
    attempt: r.attempts,
    error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
  });

  if (isRetryable(err) && r.attempts < MAX_ATTEMPTS) {
    const delay = RETRY_DELAYS_MS[r.attempts - 1] ?? RETRY_DELAYS_MS.at(-1)!;
    await prisma.resource.update({
      where: { id: r.id },
      data: { status: "PENDING", lockedUntil: new Date(Date.now() + delay), errorMessage: tenantMessage(err) },
    });
    return;
  }

  // Permanent failure: delete what was created upstream, so nothing keeps billing.
  let cleaned = true;
  try {
    await teardownUpstream(r);
  } catch (cleanupErr) {
    cleaned = false;
    console.error("[provisioner] cleanup failed, leaving externalId for manual review", {
      resourceId: r.id,
      externalId: r.externalId,
      error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
    });
  }

  await prisma.resource.update({
    where: { id: r.id },
    data: {
      status: "FAILED",
      lockedUntil: null,
      errorMessage: tenantMessage(err),
      ...(cleaned ? { externalId: null } : {}),
      ...CLEARED_SECRET,
    },
  });
  await writeAuditLog(prisma, {
    actorId: null,
    action: "resource.provision_failed",
    targetType: "Resource",
    targetId: r.id,
    metadata: {
      attempts: r.attempts,
      error: err instanceof Error ? err.name : "unknown",
      upstreamCleaned: cleaned,
      externalId: r.externalId,
    },
    context: SYSTEM,
  });
}

// ─── Delete ─────────────────────────────────────────────────────────────────

export type DeletionRequest = { ok: true; resource: Resource } | { ok: false; reason: string };

/** Called from the tenant-facing action. Checks ownership, then moves the row to DELETING. */
export async function requestDeletion(id: string, ownerId: string): Promise<DeletionRequest> {
  const r = await prisma.resource.findFirst({ where: { id, ownerId } });
  if (!r || r.status === "DELETED") return { ok: false, reason: "Resource not found." };
  if (r.status === "DELETING") return { ok: true, resource: r };
  if (r.status === "PROVISIONING" || r.status === "PENDING") {
    return { ok: false, reason: "Wait for provisioning to finish before deleting." };
  }

  // Nothing exists upstream, so the row can go straight to DELETED.
  if (!r.externalId) {
    const resource = await prisma.resource.update({
      where: { id },
      data: { status: "DELETED", deletedAt: new Date(), lockedUntil: null, ...CLEARED_SECRET },
    });
    return { ok: true, resource };
  }

  const { count } = await prisma.resource.updateMany({
    where: { id, ownerId, status: { in: ["ACTIVE", "FAILED"] } },
    data: { status: "DELETING", lockedUntil: null, attempts: 0, errorMessage: null },
  });
  if (count === 0) return { ok: false, reason: "Resource changed state. Refresh and try again." };
  return { ok: true, resource: (await prisma.resource.findUnique({ where: { id } }))! };
}

export async function deprovisionResource(id: string): Promise<void> {
  const r = await claim(id, ["DELETING"], "DELETING");
  if (!r) return;

  try {
    await teardownUpstream(r);
    await prisma.resource.update({
      where: { id },
      data: { status: "DELETED", deletedAt: new Date(), lockedUntil: null, errorMessage: null, ...CLEARED_SECRET },
    });
    await writeAuditLog(prisma, {
      actorId: null,
      action: "resource.deleted",
      targetType: "Resource",
      targetId: id,
      metadata: { type: r.type, externalId: r.externalId },
      context: SYSTEM,
    });
  } catch (err) {
    // Deletion keeps retrying with backoff. A resource stuck in DELETING is safer than a silent upstream leak.
    const delay = RETRY_DELAYS_MS[Math.min(r.attempts, RETRY_DELAYS_MS.length) - 1] ?? RETRY_DELAYS_MS[0];
    console.error("[provisioner] deprovision failed", { resourceId: id, error: err instanceof Error ? err.message : String(err) });
    await prisma.resource.update({
      where: { id },
      data: { lockedUntil: new Date(Date.now() + delay), errorMessage: "Deletion is taking longer than usual. Retrying." },
    });
  }
}

function stripUndefined(o: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
