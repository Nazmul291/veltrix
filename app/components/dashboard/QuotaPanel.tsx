import { useQuotaCalculator } from "~/hooks/useQuotaCalculator";
import { RESOURCE_TYPES } from "~/lib/plans";
import { formatCents } from "~/lib/quota";
import { Meter, Panel, TYPE_META } from "./ui";

export function QuotaPanel() {
  const q = useQuotaCalculator();

  return (
    <Panel
      title="Usage"
      action={
        <span className="rounded-full border border-zinc-700 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-zinc-400">
          {q.plan} plan
        </span>
      }
    >
      <div className="grid gap-6 p-5 sm:grid-cols-[1.2fr_2fr]">
        <div>
          <p className="text-xs text-zinc-500">Monthly cost</p>
          <p className="mt-1 font-mono text-2xl font-semibold tracking-tight text-zinc-50">
            {formatCents(q.currentCostCents)}
            <span className="text-sm font-normal text-zinc-500"> / {formatCents(q.budgetCents)}</span>
          </p>
          <div className="mt-3">
            <Meter value={q.currentCostCents} max={q.budgetCents} label="Monthly cost against plan budget" />
          </div>
          <p className="mt-2 text-xs text-zinc-500">{formatCents(q.budgetRemainingCents)} left in your plan budget</p>
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
          {RESOURCE_TYPES.map((t) => {
            const u = q.byType[t];
            return (
              <div key={t}>
                <div className="flex items-baseline justify-between">
                  <dt className="text-xs text-zinc-400">{TYPE_META[t].plural}</dt>
                  <dd className="font-mono text-xs text-zinc-300">
                    {u.limit === 0 ? <span className="text-zinc-600">not in plan</span> : `${u.used} / ${u.limit}`}
                  </dd>
                </div>
                <div className="mt-1.5">
                  <Meter value={u.used} max={u.limit} label={`${TYPE_META[t].label} quota`} />
                </div>
              </div>
            );
          })}
        </dl>
      </div>
    </Panel>
  );
}
