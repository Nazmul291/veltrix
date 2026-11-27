/**
 * Billing mutations (useFetcher → /billing action) plus Paddle.js checkout.
 *
 * Checkout flow:
 * 1. checkout(plan) → the server creates a Paddle transaction and records it.
 * 2. The returned transactionId opens the Paddle.js overlay.
 * 3. On "checkout.completed", the hook polls the loader until the webhook has
 *    moved the plan off the old one, or gives up after 60s.
 */
import { useFetcher, useRevalidator } from "@remix-run/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PlanId } from "~/lib/plans";
import { billingMutationSchema, type BillingActionData, type BillingMutation, type PaddleClientConfig } from "~/lib/schemas/billing";

// ─── Paddle.js loader (no npm dependency; one script tag per page) ──────────

interface PaddleEvent {
  name?: string;
}
interface PaddleJs {
  Environment: { set(env: "sandbox"): void };
  Initialize(opts: { token: string; eventCallback?: (e: PaddleEvent) => void }): void;
  Checkout: { open(opts: { transactionId: string; settings?: Record<string, unknown> }): void };
}
declare global {
  interface Window {
    Paddle?: PaddleJs;
  }
}

const SCRIPT_SRC = "https://cdn.paddle.com/paddle/v2/paddle.js";
let scriptPromise: Promise<PaddleJs> | null = null;
let initializedToken: string | null = null;
const listeners = new Set<(e: PaddleEvent) => void>();

function loadPaddle(config: PaddleClientConfig): Promise<PaddleJs> {
  scriptPromise ??= new Promise<PaddleJs>((resolve, reject) => {
    if (window.Paddle) return resolve(window.Paddle);
    const s = document.createElement("script");
    s.src = SCRIPT_SRC;
    s.async = true;
    s.onload = () => (window.Paddle ? resolve(window.Paddle) : reject(new Error("Paddle.js failed to load")));
    s.onerror = () => {
      scriptPromise = null;
      reject(new Error("Paddle.js failed to load"));
    };
    document.head.appendChild(s);
  });

  return scriptPromise.then((P) => {
    // Paddle allows Initialize() only once per page.
    if (initializedToken !== config.clientToken) {
      if (config.environment === "sandbox") P.Environment.set("sandbox");
      P.Initialize({ token: config.clientToken, eventCallback: (e) => listeners.forEach((l) => l(e)) });
      initializedToken = config.clientToken;
    }
    return P;
  });
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useBilling(paddle: PaddleClientConfig | null, currentPlan: PlanId) {
  const fetcher = useFetcher<BillingActionData>();
  const submitFetcher = fetcher.submit;
  const { revalidate } = useRevalidator();
  const [error, setError] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);
  const planAtCheckout = useRef<PlanId | null>(null);

  const submit = useCallback(
    (m: BillingMutation) => {
      const parsed = billingMutationSchema.safeParse(m);
      if (!parsed.success) return setError("Invalid request");
      setError(null);
      submitFetcher(parsed.data, { method: "post", action: "/billing" });
    },
    [submitFetcher],
  );

  // React to action results.
  useEffect(() => {
    const d = fetcher.data;
    if (fetcher.state !== "idle" || !d) return;
    if (!d.ok) return setError(d.error);
    if (d.intent === "portal") window.location.assign(d.url);
    if (d.intent === "checkout") {
      if (!paddle) return setError("Billing is not configured.");
      loadPaddle(paddle)
        .then((P) =>
          P.Checkout.open({
            transactionId: d.transactionId,
            settings: { displayMode: "overlay", theme: "dark" },
          }),
        )
        .catch((e: Error) => setError(e.message));
    }
  }, [fetcher.state, fetcher.data, paddle]);

  // checkout.completed → wait for the webhook to change the plan.
  useEffect(() => {
    const onEvent = (e: PaddleEvent) => {
      if (e.name === "checkout.completed") {
        planAtCheckout.current = currentPlan;
        setActivating(true);
      }
    };
    listeners.add(onEvent);
    return () => {
      listeners.delete(onEvent);
    };
  }, [currentPlan]);

  useEffect(() => {
    if (!activating) return;
    if (planAtCheckout.current && currentPlan !== planAtCheckout.current) {
      setActivating(false);
      return;
    }
    const started = Date.now();
    const t = setInterval(() => {
      if (Date.now() - started > 60_000) {
        setActivating(false);
        setError("Payment received. Your plan will update shortly. Refresh in a minute.");
        clearInterval(t);
        return;
      }
      revalidate();
    }, 2_000);
    return () => clearInterval(t);
  }, [activating, currentPlan, revalidate]);

  const pendingIntent = fetcher.state !== "idle" ? String(fetcher.formData?.get("intent") ?? "") : null;
  const pendingPlan = fetcher.state !== "idle" ? String(fetcher.formData?.get("plan") ?? "") : null;

  return {
    checkout: (plan: "PRO" | "TEAM") => submit({ intent: "checkout", plan }),
    changePlan: (plan: PlanId) => submit({ intent: "change_plan", plan }),
    resume: () => submit({ intent: "resume" }),
    openPortal: () => submit({ intent: "portal" }),
    pendingIntent,
    pendingPlan,
    activating,
    error,
  };
}
