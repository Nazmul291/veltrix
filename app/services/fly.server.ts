/**
 * Fly.io Machines API: app hosting (APP) and background workers (WORKER).
 *
 * Tenant isolation: every tenant gets its own Fly private network
 * (`network` on app create). Apps in the same Fly org otherwise share one
 * 6PN network and could reach each other over .internal DNS.
 *
 * Idempotency: the Fly app name comes from the resource ID, so a retry after a
 * partial failure finds the existing app and machine and reuses them.
 */
import { getProviderCredentials } from "./credentials.server";
import { ProviderApiError, providerRequest, type ProviderRequest } from "./http.server";

const BASE = "https://api.machines.dev/v1";

export const DEFAULT_IMAGE = "flyio/hellofly:latest";
export const DEFAULT_PORT = 8080;

interface FlyGuest {
  cpu_kind: "shared" | "performance";
  cpus: number;
  memory_mb: number;
}

/** Catalog size key (app/lib/plans.ts) → Fly guest spec. */
const GUESTS: Record<string, FlyGuest> = {
  "shared-1x-256": { cpu_kind: "shared", cpus: 1, memory_mb: 256 },
  "shared-1x-1024": { cpu_kind: "shared", cpus: 1, memory_mb: 1024 },
  "shared-2x-512": { cpu_kind: "shared", cpus: 2, memory_mb: 512 },
  "performance-1x": { cpu_kind: "performance", cpus: 1, memory_mb: 2048 },
};

async function fly<T>(path: string, init: Omit<ProviderRequest, "provider" | "url" | "headers"> = {}) {
  const { apiToken } = await getProviderCredentials("FLY");
  return providerRequest<T>({
    provider: "FLY",
    url: `${BASE}${path}`,
    headers: { Authorization: `Bearer ${apiToken}` },
    ...init,
  });
}

export const flyAppName = (resourceId: string) => `vx-${resourceId}`.toLowerCase();
export const tenantNetwork = (ownerId: string) => `vx-net-${ownerId}`.toLowerCase();

/** Creates the app, or confirms that an app with this name already exists in our org (a retry). */
export async function ensureApp(appName: string, network: string): Promise<void> {
  const { orgSlug } = await getProviderCredentials("FLY");
  const created = await fly("/apps", {
    method: "POST",
    body: { app_name: appName, org_slug: orgSlug, network },
    allowStatus: [409, 422],
  });
  if (created.status < 300) return;

  const existing = await fly<{ organization?: { slug?: string } }>(`/apps/${appName}`, { allowStatus: [404] });
  if (existing.status === 404 || existing.data?.organization?.slug !== orgSlug) {
    throw new ProviderApiError("FLY", created.status, `Fly app name ${appName} is not available`, false);
  }
}

/**
 * Public IPv6 plus a shared IPv4, so <app>.fly.dev resolves.
 * The request body ({ type }) couldn't be checked against Fly's docs (their URLs
 * now 404). Confirm it against the Machines API OpenAPI spec before going live.
 */
export async function allocatePublicIps(appName: string): Promise<void> {
  for (const type of ["v6", "shared_v4"] as const) {
    await fly(`/apps/${appName}/ip_assignments`, { method: "POST", body: { type }, allowStatus: [409, 422] });
  }
}

export interface MachineSpec {
  kind: "APP" | "WORKER";
  region: string;
  size: string;
  image: string;
  port: number;
  metadata: Record<string, string>;
}

/** Returns the ID of the app's machine, creating it only if the app has none yet. */
export async function ensureMachine(appName: string, spec: MachineSpec): Promise<string> {
  const { data: machines } = await fly<{ id: string }[]>(`/apps/${appName}/machines`);
  if (Array.isArray(machines) && machines.length > 0) return machines[0].id;

  const guest = GUESTS[spec.size];
  if (!guest) throw new ProviderApiError("FLY", 0, `No Fly guest mapping for size "${spec.size}"`, false);

  const { data } = await fly<{ id: string }>(`/apps/${appName}/machines`, {
    method: "POST",
    body: {
      name: `${spec.kind.toLowerCase()}-main`,
      region: spec.region,
      config: {
        image: spec.image,
        guest,
        metadata: spec.metadata,
        restart: { policy: "on-failure", max_retries: 5 },
        // Workers expose no public services. Apps get HTTP/HTTPS with scale-to-zero.
        services:
          spec.kind === "APP"
            ? [
                {
                  protocol: "tcp",
                  internal_port: spec.port,
                  autostop: "stop",
                  autostart: true,
                  min_machines_running: 0,
                  ports: [
                    { port: 80, handlers: ["http"], force_https: true },
                    { port: 443, handlers: ["tls", "http"] },
                  ],
                },
              ]
            : [],
      },
    },
    timeoutMs: 60_000,
  });
  return data.id;
}

export async function waitForMachineStarted(appName: string, machineId: string): Promise<void> {
  const res = await fly(`/apps/${appName}/machines/${machineId}/wait?state=started&timeout=60`, {
    timeoutMs: 75_000,
    allowStatus: [408],
  });
  if (res.status === 408) throw new ProviderApiError("FLY", 408, "Fly machine did not start within 60s", true);
}

/** Deletes the app and all its machines and IPs. A 404 counts as already deleted. */
export async function destroyApp(appName: string): Promise<void> {
  await fly(`/apps/${appName}?force=true`, { method: "DELETE", allowStatus: [404] });
}

// ─── High-level entry points used by the provisioner ────────────────────────

export interface FlyProvisionInput {
  resourceId: string;
  ownerId: string;
  kind: "APP" | "WORKER";
  region: string;
  size: string;
  image?: string;
  port?: number;
}

export async function provisionFlyResource(input: FlyProvisionInput, onExternalId: (id: string) => Promise<void>) {
  const appName = flyAppName(input.resourceId);
  const network = tenantNetwork(input.ownerId);
  const image = input.image ?? DEFAULT_IMAGE;
  const port = input.port ?? DEFAULT_PORT;

  // Fail fast if credentials are missing, before there's anything to clean up.
  await getProviderCredentials("FLY");
  // Record the name before anything exists upstream, so a failure at any later step can be cleaned up.
  await onExternalId(appName);
  await ensureApp(appName, network);
  if (input.kind === "APP") await allocatePublicIps(appName);

  const machineId = await ensureMachine(appName, {
    kind: input.kind,
    region: input.region,
    size: input.size,
    image,
    port,
    metadata: { veltrix_resource: input.resourceId, veltrix_owner: input.ownerId },
  });
  await waitForMachineStarted(appName, machineId);

  return {
    externalId: appName,
    secret: null,
    config: {
      image,
      port,
      network,
      machineId,
      hostname: input.kind === "APP" ? `${appName}.fly.dev` : undefined,
    },
  };
}
