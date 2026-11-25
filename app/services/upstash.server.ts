/**
 * Upstash Developer API v2: managed Redis, one global database per REDIS resource.
 * Auth is HTTP Basic with email:apiKey. TLS is always on.
 */
import { getProviderCredentials } from "./credentials.server";
import { ProviderApiError, providerRequest, type ProviderRequest } from "./http.server";

const BASE = "https://api.upstash.com/v2";

/** Catalog size key → Upstash `plan` value. */
const PLANS: Record<string, string> = {
  payg: "payg",
  "fixed-1gb": "fixed_1gb",
};

interface UpstashDatabase {
  database_id: string;
  endpoint: string;
  port: number;
  /** Left out when credential protection is on for the Upstash account. */
  password?: string;
}

async function upstash<T>(path: string, init: Omit<ProviderRequest, "provider" | "url" | "headers"> = {}) {
  const { email, apiKey } = await getProviderCredentials("UPSTASH");
  return providerRequest<T>({
    provider: "UPSTASH",
    url: `${BASE}${path}`,
    headers: { Authorization: `Basic ${Buffer.from(`${email}:${apiKey}`).toString("base64")}` },
    ...init,
  });
}

/** A 404 counts as already deleted. */
export async function deleteDatabase(databaseId: string): Promise<void> {
  await upstash(`/redis/database/${databaseId}`, { method: "DELETE", allowStatus: [404] });
}

export interface UpstashProvisionInput {
  resourceId: string;
  region: string;
  size: string;
}

export async function provisionUpstashRedis(input: UpstashProvisionInput, onExternalId: (id: string) => Promise<void>) {
  const plan = PLANS[input.size];
  if (!plan) throw new ProviderApiError("UPSTASH", 0, `No Upstash plan mapping for size "${input.size}"`, false);

  const { data } = await upstash<UpstashDatabase>("/redis/database", {
    method: "POST",
    body: {
      database_name: `vx-${input.resourceId}`,
      platform: "aws",
      primary_region: input.region,
      tls: true,
      plan,
    },
  });

  await onExternalId(data.database_id);

  if (!data.password) {
    throw new ProviderApiError(
      "UPSTASH",
      200,
      "Upstash returned no password. Turn off credential protection on the Upstash account.",
      false,
    );
  }

  // The docs say `endpoint` may be a bare slug or a full hostname.
  const host = data.endpoint.includes(".") ? data.endpoint : `${data.endpoint}.upstash.io`;
  return {
    externalId: data.database_id,
    secret: `rediss://default:${encodeURIComponent(data.password)}@${host}:${data.port}`,
    config: { hostname: host },
  };
}
