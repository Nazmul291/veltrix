/**
 * Shared HTTP transport for the provider services: timeouts, retries and error
 * normalisation. It holds no credentials or provider logic. Each provider
 * service builds its own auth header from credentials.server.ts and passes it in.
 *
 * Retry policy:
 * - GET/PUT/DELETE: retried on network errors, 429 and 5xx (safe to repeat).
 * - POST: retried only on 429. A 5xx or network error on a create may already
 *   have been applied upstream, so retrying it here could create a duplicate.
 *   Those errors go up to the provisioner, which retries at a level that knows
 *   about external IDs.
 */
import type { ProviderId } from "~/lib/providers";

export class ProviderApiError extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly status: number,
    message: string,
    /** True if repeating the whole operation later might succeed. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProviderApiError";
  }
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ProviderRequest {
  provider: ProviderId;
  url: string;
  method?: Method;
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  maxRetries?: number;
  /** Non-2xx statuses the caller handles itself (e.g. 404 on delete = already gone). */
  allowStatus?: number[];
}

export interface ProviderResponse<T> {
  status: number;
  data: T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt: number) => Math.min(8_000, 500 * 2 ** attempt) + Math.random() * 250;

function retryAfterMs(res: Response): number | null {
  const v = res.headers.get("retry-after");
  const secs = v ? Number(v) : NaN;
  return Number.isFinite(secs) ? Math.min(secs, 10) * 1000 : null;
}

async function errorDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const msg = j.error ?? j.message ?? j.detail ?? text;
    return String(typeof msg === "object" ? JSON.stringify(msg) : msg).slice(0, 300);
  } catch {
    return text.slice(0, 300) || res.statusText;
  }
}

export async function providerRequest<T>(req: ProviderRequest): Promise<ProviderResponse<T>> {
  const method = req.method ?? "GET";
  const idempotent = method !== "POST" && method !== "PATCH";
  const maxRetries = req.maxRetries ?? 3;
  const path = new URL(req.url).pathname;

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(req.url, {
        method,
        headers: {
          Accept: "application/json",
          ...(req.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...req.headers,
        },
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        signal: AbortSignal.timeout(req.timeoutMs ?? 30_000),
      });
    } catch (err) {
      if (idempotent && attempt < maxRetries) {
        await sleep(backoff(attempt));
        continue;
      }
      const kind = err instanceof Error ? err.name : "Error";
      throw new ProviderApiError(req.provider, 0, `${req.provider} ${method} ${path}: ${kind}`, true);
    }

    if (res.ok || req.allowStatus?.includes(res.status)) {
      const text = await res.text();
      let data: unknown = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      return { status: res.status, data: data as T };
    }

    const transient = res.status === 429 || res.status >= 500;
    const mayRetryHere = res.status === 429 || (idempotent && res.status >= 500);
    if (mayRetryHere && attempt < maxRetries) {
      await sleep(retryAfterMs(res) ?? backoff(attempt));
      continue;
    }
    throw new ProviderApiError(
      req.provider,
      res.status,
      `${req.provider} ${method} ${path} → ${res.status}: ${await errorDetail(res)}`,
      transient,
    );
  }
}
