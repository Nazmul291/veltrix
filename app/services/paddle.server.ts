/**
 * Paddle Billing API (v1) and webhook signature verification.
 * Isolated like the other providers: it reads only PADDLE credentials.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { getProviderCredentials } from "./credentials.server";
import { providerRequest, type ProviderRequest } from "./http.server";

const BASE_URLS = {
  sandbox: "https://sandbox-api.paddle.com",
  production: "https://api.paddle.com",
} as const;

async function paddle<T>(path: string, init: Omit<ProviderRequest, "provider" | "url" | "headers"> = {}) {
  const { apiKey, environment } = await getProviderCredentials("PADDLE");
  const base = environment === "production" ? BASE_URLS.production : BASE_URLS.sandbox;
  return providerRequest<{ data: T }>({
    provider: "PADDLE",
    url: `${base}${path}`,
    headers: { Authorization: `Bearer ${apiKey}`, "Paddle-Version": "1" },
    ...init,
  });
}

// ─── Types (the fields Veltrix uses) ────────────────────────────────────────

export type PaddleSubscriptionStatus = "active" | "canceled" | "past_due" | "paused" | "trialing";

export interface PaddleSubscription {
  id: string;
  status: PaddleSubscriptionStatus;
  customer_id: string;
  items: { price: { id: string }; quantity: number }[];
  current_billing_period: { starts_at: string; ends_at: string } | null;
  scheduled_change: { action: "cancel" | "pause" | "resume"; effective_at: string } | null;
}

export interface PaddleWebhookEvent {
  event_id: string;
  event_type: string;
  occurred_at: string;
  notification_id: string;
  data: Record<string, unknown> & { id?: string; transaction_id?: string; customer_id?: string };
}

// ─── API calls ──────────────────────────────────────────────────────────────

/** Draft checkout transaction. Paddle.js opens it with Checkout.open({ transactionId }). */
export async function createCheckoutTransaction(input: { priceId: string; customerId: string | null; userId: string }) {
  const { data } = await paddle<{ id: string }>("/transactions", {
    method: "POST",
    body: {
      items: [{ price_id: input.priceId, quantity: 1 }],
      ...(input.customerId ? { customer_id: input.customerId } : {}),
      // For support and debugging only. Webhooks never trust it (see billing.server.ts).
      custom_data: { veltrix_user_id: input.userId },
    },
  });
  return data.data.id;
}

export async function getSubscription(subscriptionId: string) {
  const { data } = await paddle<PaddleSubscription>(`/subscriptions/${subscriptionId}`);
  return data.data;
}

export async function changeSubscriptionPrice(subscriptionId: string, priceId: string) {
  await paddle(`/subscriptions/${subscriptionId}`, {
    method: "PATCH",
    body: { items: [{ price_id: priceId, quantity: 1 }], proration_billing_mode: "prorated_immediately" },
  });
}

export async function cancelAtPeriodEnd(subscriptionId: string) {
  await paddle(`/subscriptions/${subscriptionId}/cancel`, { method: "POST", body: { effective_from: "next_billing_period" } });
}

/** Removes a scheduled cancellation. */
export async function removeScheduledChange(subscriptionId: string) {
  await paddle(`/subscriptions/${subscriptionId}`, { method: "PATCH", body: { scheduled_change: null } });
}

/** Short-lived customer portal URL (payment methods, invoices). Don't cache it. */
export async function createPortalUrl(customerId: string, subscriptionIds: string[]) {
  const { data } = await paddle<{ urls: { general: { overview: string } } }>(`/customers/${customerId}/portal-sessions`, {
    method: "POST",
    body: subscriptionIds.length ? { subscription_ids: subscriptionIds } : {},
  });
  return data.data.urls.general.overview;
}

// ─── Webhook signature ──────────────────────────────────────────────────────

/**
 * Paddle-Signature: "ts=<unix>;h1=<hex>[;h1=<hex>…]" (several h1 values during secret rotation).
 * Signed payload: `${ts}:${rawBody}`, HMAC-SHA256 with the notification secret.
 *
 * Tolerance: Paddle's SDKs default to 5 seconds. This uses 5 minutes to absorb
 * clock skew and slow proxies. Replays inside the window do nothing, because
 * events are deduplicated by event_id and the handler applies Paddle's current
 * API state, not the payload.
 */
export function verifyPaddleSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
  toleranceSec = 300,
): boolean {
  if (!header) return false;
  let ts: string | null = null;
  const sigs: string[] = [];
  for (const part of header.split(";")) {
    const [k, v] = part.split("=", 2);
    if (k === "ts" && v) ts = v;
    if (k === "h1" && v) sigs.push(v);
  }
  if (!ts || !/^\d+$/.test(ts) || sigs.length === 0) return false;
  if (Math.abs(nowSec - Number(ts)) > toleranceSec) return false;

  const expected = createHmac("sha256", secret).update(`${ts}:${rawBody}`, "utf8").digest();
  return sigs.some((h) => {
    if (!/^[0-9a-f]{64}$/i.test(h)) return false;
    return timingSafeEqual(expected, Buffer.from(h, "hex"));
  });
}
