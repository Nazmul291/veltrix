/**
 * In-process job runner: provisioning and deletion start right away after an
 * action, and a sweeper catches anything missed (retries waiting on
 * lockedUntil, rows left behind by a crashed or redeployed process).
 *
 * Every step is claimed through a database lease, so it's safe with any number
 * of app instances. The work runs inside the web process. When provisioning
 * volume grows, move the sweeper into a dedicated Fly worker machine. The
 * provisioner code doesn't change.
 */
import { prisma } from "./db.server";
import { deprovisionResource, provisionResource } from "./provisioner.server";

const SWEEP_INTERVAL_MS = 30_000;
const SWEEP_BATCH = 10;

function run(label: string, fn: () => Promise<void>) {
  fn().catch((err) => console.error(`[jobs] ${label} crashed`, err instanceof Error ? err.message : err));
}

export function enqueueProvision(resourceId: string) {
  run(`provision ${resourceId}`, () => provisionResource(resourceId));
}

export function enqueueDeprovision(resourceId: string) {
  run(`deprovision ${resourceId}`, () => deprovisionResource(resourceId));
}

export async function sweepOnce(): Promise<number> {
  const now = new Date();
  const due = await prisma.resource.findMany({
    where: {
      status: { in: ["PENDING", "PROVISIONING", "DELETING"] },
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
    },
    select: { id: true, status: true },
    orderBy: { updatedAt: "asc" },
    take: SWEEP_BATCH,
  });
  for (const r of due) {
    await (r.status === "DELETING" ? deprovisionResource(r.id) : provisionResource(r.id));
  }
  return due.length;
}

const g = globalThis as unknown as { __vxSweeper?: NodeJS.Timeout };

/** Idempotent: survives Vite HMR and repeated calls. */
export function startSweeper() {
  if (g.__vxSweeper || process.env.NODE_ENV === "test") return;
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
