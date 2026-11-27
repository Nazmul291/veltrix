/**
 * GET /api/cron/sweep: the backstop sweep that Vercel Cron calls (see vercel.json).
 * Vercel sends `Authorization: Bearer <CRON_SECRET>` when the CRON_SECRET
 * environment variable is set. Without CRON_SECRET this endpoint refuses every
 * request, so it can never be triggered anonymously.
 */
import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { safeEqual } from "~/services/crypto.server";
import { sweepOnce } from "~/services/jobs.server";

// Leaves ~60s of headroom under the 300s Hobby maximum for the item already in progress.
export const config = { maxDuration: 300 };
const BUDGET_MS = 240_000;

export async function loader({ request }: LoaderFunctionArgs) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    console.error("[cron] CRON_SECRET is not set; refusing to run");
    return json({ error: "not_configured" }, { status: 503 });
  }
  if (!safeEqual(request.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return json({ error: "unauthorized" }, { status: 401 });
  }

  const started = Date.now();
  const processed = await sweepOnce({ budgetMs: BUDGET_MS });
  return json({ ok: true, processed, ms: Date.now() - started }, { headers: { "Cache-Control": "no-store" } });
}
