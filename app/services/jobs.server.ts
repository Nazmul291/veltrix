/**
 * Job runner for provisioning and deletion.
 *
 * Every step is claimed through a database lease (see provisioner.server.ts),
 * so any number of instances or functions can run it safely. Three things drive it:
 *
 * 1. Right away: the action that created the work calls enqueue*. On Vercel the
 *    promise is registered with waitUntil, so the function stays alive until
 *    it settles (within the route's maxDuration). Elsewhere it simply runs in the background.
 * 2. While a tenant watches: the dashboard polls every 3s while anything is in
 *    progress, and each poll calls kickTenantJobs. That runs the tenant's due
 *    retries without waiting for a cron. On Vercel Hobby, crons run only daily.
 * 3. Backstop: GET /api/cron/sweep (Vercel Cron) and, on long-running Node
 *    servers, a 30s in-process interval. Together they catch anything left behind.
 */
import { waitUntil } from "@vercel/functions";
import { prisma } from "./db.server";
import { deprovisionResource, provisionResource } from "./provisioner.server";

const SWEEP_INTERVAL_MS = 30_000;
const SWEEP_BATCH = 10;

/** Keeps a background promise alive on Vercel. Elsewhere it just runs. Errors are logged, never thrown. */
function background(label: string, work: Promise<unknown>) {
  const guarded = work.catch((err) => console.error(`[jobs] ${label} failed`, err instanceof Error ? err.message : err));
  waitUntil(guarded);
  return guarded;
}

export function enqueueProvision(resourceId: string) {
  return background(`provision ${resourceId}`, provisionResource(resourceId));
}

export function enqueueDeprovision(resourceId: string) {
  return background(`deprovision ${resourceId}`, deprovisionResource(resourceId));
}

function dueWhere(ownerId?: string) {
  return {
    ...(ownerId ? { ownerId } : {}),
    status: { in: ["PENDING", "PROVISIONING", "DELETING"] as ("PENDING" | "PROVISIONING" | "DELETING")[] },
    OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }],
  };
}

export interface SweepOptions {
  /** Only this tenant's resources. */
  ownerId?: string;
  /** Stop starting new items after this many ms, so a sweep fits inside a function's max duration. */
  budgetMs?: number;
  batch?: number;
}

export async function sweepOnce(opts: SweepOptions = {}): Promise<number> {
  const started = Date.now();
  const due = await prisma.resource.findMany({
    where: dueWhere(opts.ownerId),
    select: { id: true, status: true },
    orderBy: { updatedAt: "asc" },
    take: opts.batch ?? SWEEP_BATCH,
  });

  let processed = 0;
  for (const r of due) {
    if (opts.budgetMs !== undefined && Date.now() - started > opts.budgetMs) break;
    await (r.status === "DELETING" ? deprovisionResource(r.id) : provisionResource(r.id));
    processed++;
  }
  return processed;
}

/**
 * Called from loaders the dashboard polls. It's cheap when nothing is due
 * (one indexed count), and it never delays the response.
 */
export async function kickTenantJobs(ownerId: string) {
  const due = await prisma.resource.count({ where: dueWhere(ownerId) });
  if (due > 0) void background(`tenant sweep ${ownerId}`, sweepOnce({ ownerId, budgetMs: 200_000, batch: 3 }));
}

const g = globalThis as unknown as { __vxSweeper?: NodeJS.Timeout };

/**
 * In-process interval for long-running servers (remix-serve, Fly, Docker).
 * Skipped on Vercel, where functions freeze between requests: Vercel Cron and
 * kickTenantJobs do this job there. Idempotent, so it survives Vite HMR.
 */
export function startSweeper() {
  if (g.__vxSweeper || process.env.NODE_ENV === "test" || process.env.VERCEL) return;
  let running = false;
  g.__vxSweeper = setInterval(() => {
    if (running) return;
    running = true;
    sweepOnce()
      .catch((err) => console.error("[jobs] sweep failed", err instanceof Error ? err.message : err))
      .finally(() => {
        running = false;
      });
  }, SWEEP_INTERVAL_MS);
  g.__vxSweeper.unref();
}
