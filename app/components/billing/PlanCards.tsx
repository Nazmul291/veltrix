import { useState } from "react";
import type { useBilling } from "~/hooks/useBilling";
import { PLAN_LIMITS, PLAN_PRICE_CENTS, PLAN_RANK, PLANS, RESOURCE_TYPES, type PlanId } from "~/lib/plans";
import { formatCents } from "~/lib/quota";
import { TYPE_META } from "../dashboard/ui";

type Billing = ReturnType<typeof useBilling>;
interface Sub {
  status: "ACTIVE" | "TRIALING" | "PAST_DUE" | "PAUSED" | "CANCELED";
  plan: PlanId;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

const fmtDate = (iso: string) => iso.slice(0, 10);

const btn = "h-9 rounded-md px-4 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40";
const primary = `${btn} bg-zinc-100 text-zinc-950 hover:bg-white`;
const secondary = `${btn} border border-zinc-800 text-zinc-300 hover:border-zinc-700 hover:text-zinc-100`;

export function CurrentPlanCard({ plan, subscription: sub, billing }: { plan: PlanId; subscription: Sub | null; billing: Billing }) {
  let status: { text: string; cls: string } = { text: "Free", cls: "border-zinc-700 text-zinc-400" };
  let detail = "No subscription. Upgrade to raise your limits.";
  if (sub) {
    if (sub.status === "PAST_DUE") {
      status = { text: "Payment failed", cls: "border-red-500/30 bg-red-500/10 text-red-300" };
      detail = "Paddle is retrying your card. Update your payment method to keep your plan.";
    } else if (sub.cancelAtPeriodEnd) {
      status = { text: "Cancels soon", cls: "border-amber-500/30 bg-amber-500/10 text-amber-300" };
      detail = sub.currentPeriodEnd ? `Moves to Free on ${fmtDate(sub.currentPeriodEnd)}.` : "Moves to Free at the end of this period.";
    } else {
      status = { text: sub.status === "TRIALING" ? "Trial" : "Active", cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" };
      detail = sub.currentPeriodEnd ? `Renews on ${fmtDate(sub.currentPeriodEnd)}.` : "Renews monthly.";
    }
  }

  return (
    <section className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-zinc-800/80 bg-zinc-900/40 px-5 py-4">
      <div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-lg font-semibold text-zinc-50">{plan}</span>
          <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${status.cls}`}>{status.text}</span>
        </div>
        <p className="mt-1 text-sm text-zinc-400">{detail}</p>
      </div>
      {sub && (
        <div className="flex gap-2">
          {sub.cancelAtPeriodEnd && (
            <button onClick={billing.resume} disabled={billing.pendingIntent !== null} className={primary}>
              {billing.pendingIntent === "resume" ? "Resuming…" : "Keep my plan"}
            </button>
          )}
          <button onClick={billing.openPortal} disabled={billing.pendingIntent !== null} className={secondary}>
            {billing.pendingIntent === "portal" ? "Opening…" : "Payment & invoices"}
          </button>
        </div>
      )}
    </section>
  );
}

export function PlanCards({
  plan: current,
  subscription: sub,
  enabled,
  billing,
}: {
  plan: PlanId;
  subscription: Sub | null;
  enabled: boolean;
  billing: Billing;
}) {
  const [confirming, setConfirming] = useState<PlanId | null>(null);
  const busy = billing.pendingIntent !== null || billing.activating;

  const act = (target: PlanId) => {
    if (sub?.cancelAtPeriodEnd && target === current) return billing.resume();
    if (!sub) {
      if (target !== "FREE") billing.checkout(target);
      return;
    }
    // Downgrades go through an inline confirmation. Upgrades charge a prorated amount right away.
    if (PLAN_RANK[target] < PLAN_RANK[current] && confirming !== target) return setConfirming(target);
    setConfirming(null);
    billing.changePlan(target);
  };

  return (
    <section className="grid gap-4 md:grid-cols-3">
      {PLANS.map((p) => {
        const limits = PLAN_LIMITS[p];
        // While a cancellation is scheduled, the current paid plan offers "Keep" (it undoes the cancellation).
        const keep = Boolean(sub?.cancelAtPeriodEnd) && p === current && p !== "FREE";
        const isCurrent = p === current && !keep;
        const pending = billing.pendingPlan === p || (keep && billing.pendingIntent === "resume");
        const label = keep
          ? `Keep ${p}`
          : isCurrent
          ? "Current plan"
          : p === "FREE"
            ? sub?.cancelAtPeriodEnd
              ? "Cancellation scheduled"
              : confirming === "FREE"
                ? "Confirm: cancel at period end"
                : "Downgrade to Free"
            : !sub
              ? `Upgrade to ${p}`
              : confirming === p
                ? `Confirm switch to ${p}`
                : PLAN_RANK[p] > PLAN_RANK[current]
                  ? `Upgrade to ${p}`
                  : `Switch to ${p}`;
        const disabled =
          isCurrent || busy || !enabled || (p === "FREE" && (!sub || sub.cancelAtPeriodEnd)) || sub?.status === "PAST_DUE";

        return (
          <article
            key={p}
            className={`flex flex-col rounded-xl border p-5 ${p === current ? "border-emerald-500/40 bg-emerald-500/[0.03]" : "border-zinc-800/80 bg-zinc-900/40"}`}
          >
            <h2 className="font-mono text-sm font-semibold tracking-wider text-zinc-300">{p}</h2>
            <p className="mt-3 font-mono text-3xl font-semibold tracking-tight text-zinc-50">
              {formatCents(PLAN_PRICE_CENTS[p]).replace(".00", "")}
              <span className="text-sm font-normal text-zinc-500">/mo</span>
            </p>
            <ul className="mt-5 flex-1 space-y-2 text-sm">
              {RESOURCE_TYPES.map((t) => (
                <li key={t} className="flex justify-between">
                  <span className="text-zinc-400">{TYPE_META[t].plural}</span>
                  <span className={`font-mono ${limits.maxResources[t] ? "text-zinc-200" : "text-zinc-600"}`}>
                    {limits.maxResources[t] || "—"}
                  </span>
                </li>
              ))}
              <li className="flex justify-between border-t border-zinc-800/80 pt-2">
                <span className="text-zinc-400">Usage budget</span>
                <span className="font-mono text-zinc-200">{formatCents(limits.monthlyBudgetCents)}/mo</span>
              </li>
            </ul>
            <button
              onClick={() => act(p)}
              disabled={disabled}
              className={`mt-6 w-full ${!keep && (isCurrent || PLAN_RANK[p] < PLAN_RANK[current]) ? secondary : primary}`}
            >
              {pending ? "Working…" : label}
            </button>
            {confirming === p && (
              <button onClick={() => setConfirming(null)} className="mt-2 text-xs text-zinc-500 hover:text-zinc-300">
                Never mind
              </button>
            )}
          </article>
        );
      })}
    </section>
  );
}
