/**
 * Paddle notification destination: POST https://<host>/webhooks/paddle
 * No session and no Origin check, because the HMAC signature is the authentication.
 * Status codes drive Paddle's retries: 2xx means done, 5xx means redeliver later.
 */
import { json, type ActionFunctionArgs } from "@remix-run/node";
import { handlePaddleEvent } from "~/services/billing.server";
import { getProviderCredentials } from "~/services/credentials.server";
import { verifyPaddleSignature, type PaddleWebhookEvent } from "~/services/paddle.server";

const MAX_BODY_BYTES = 1_000_000;

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return json({ error: "too_large" }, 413);
  // Verify against the exact raw bytes. Re-serialised JSON would not match the signature.
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "too_large" }, 413);

  let secret: string;
  try {
    secret = (await getProviderCredentials("PADDLE")).webhookSecret;
  } catch {
    // Not configured yet: 503, so Paddle keeps retrying until an admin adds the keys.
    return json({ error: "billing_not_configured" }, 503);
  }

  if (!verifyPaddleSignature(raw, request.headers.get("paddle-signature"), secret)) {
    return json({ error: "invalid_signature" }, 401);
  }

  let event: PaddleWebhookEvent;
  try {
    event = JSON.parse(raw);
    if (typeof event.event_id !== "string" || typeof event.event_type !== "string" || !event.data) throw new Error();
  } catch {
    return json({ error: "malformed" }, 400);
  }

  try {
    const result = await handlePaddleEvent(event);
    return json({ ok: true, result });
  } catch (err) {
    console.error("[webhooks.paddle] handling failed", {
      eventId: event.event_id,
      type: event.event_type,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
    return json({ error: "processing_failed" }, 500);
  }
}

export const loader = () => json({ error: "method_not_allowed" }, 405);
