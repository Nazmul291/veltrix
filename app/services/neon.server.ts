/**
 * Neon API v2: managed Postgres. One Neon project per POSTGRES resource, so
 * tenants share no compute, storage or roles.
 */
import { getProviderCredentials } from "./credentials.server";
import { ProviderApiError, providerRequest, type ProviderRequest } from "./http.server";

const BASE = "https://console.neon.tech/api/v2";

/** Catalog size key → autoscaling range in compute units. */
const COMPUTE: Record<string, { min: number; max: number }> = {
  "free-0.25cu": { min: 0.25, max: 0.25 },
  "launch-1cu": { min: 0.25, max: 1 },
  "scale-2cu": { min: 0.5, max: 2 },
};

interface NeonOperation {
  id: string;
  status: string;
}

interface CreateProjectResponse {
  project: { id: string };
  connection_uris?: { connection_uri: string; connection_parameters?: { host?: string } }[];
  operations?: NeonOperation[];
}

async function neon<T>(path: string, init: Omit<ProviderRequest, "provider" | "url" | "headers"> = {}) {
  const { apiKey } = await getProviderCredentials("NEON");
  return providerRequest<T>({
    provider: "NEON",
    url: `${BASE}${path}`,
    headers: { Authorization: `Bearer ${apiKey}` },
    ...init,
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The operations endpoint and its status values come from general Neon API
// knowledge. The create-project reference doesn't list them.
const OP_DONE = new Set(["finished", "skipped"]);
const OP_FAILED = new Set(["failed", "error", "cancelled"]);

export async function waitForOperations(projectId: string, operationIds: string[], timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let pending = [...operationIds];

  while (pending.length > 0) {
    const next: string[] = [];
    for (const id of pending) {
      const { data } = await neon<{ operation: NeonOperation }>(`/projects/${projectId}/operations/${id}`);
      const status = data.operation.status;
      if (OP_FAILED.has(status)) throw new ProviderApiError("NEON", 200, `Neon operation ${id} ended with status "${status}"`, true);
      if (!OP_DONE.has(status)) next.push(id);
    }
    pending = next;
    if (pending.length === 0) return;
    if (Date.now() > deadline) throw new ProviderApiError("NEON", 0, "Timed out waiting for Neon operations", true);
    await sleep(2_000);
  }
}

/** A 404 counts as already deleted. Neon keeps deleted projects recoverable for 7 days. */
export async function deleteProject(projectId: string): Promise<void> {
  await neon(`/projects/${projectId}`, { method: "DELETE", allowStatus: [404] });
}

export interface NeonProvisionInput {
  resourceId: string;
  region: string;
  size: string;
}

export async function provisionNeonDatabase(input: NeonProvisionInput, onExternalId: (id: string) => Promise<void>) {
  const compute = COMPUTE[input.size];
  if (!compute) throw new ProviderApiError("NEON", 0, `No Neon compute mapping for size "${input.size}"`, false);
  const { orgId } = await getProviderCredentials("NEON");

  const { data } = await neon<CreateProjectResponse>("/projects", {
    method: "POST",
    body: {
      project: {
        name: `vx-${input.resourceId}`,
        region_id: input.region,
        ...(orgId ? { org_id: orgId } : {}),
        default_endpoint_settings: {
          autoscaling_limit_min_cu: compute.min,
          autoscaling_limit_max_cu: compute.max,
        },
      },
    },
    timeoutMs: 60_000,
  });

  // Record the project ID first, so the provisioner can delete it if a later step fails.
  await onExternalId(data.project.id);

  const conn = data.connection_uris?.[0];
  if (!conn?.connection_uri) throw new ProviderApiError("NEON", 201, "Neon did not return a connection URI", false);

  await waitForOperations(data.project.id, (data.operations ?? []).map((o) => o.id));

  return {
    externalId: data.project.id,
    secret: conn.connection_uri,
    config: { hostname: conn.connection_parameters?.host ?? safeHost(conn.connection_uri) },
  };
}

function safeHost(uri: string): string | undefined {
  try {
    return new URL(uri).hostname;
  } catch {
    return undefined;
  }
}
