import type { ResourceType } from "~/lib/plans";
import type { ResourceStatus } from "~/lib/schemas/resource";

export const TYPE_META: Record<ResourceType, { label: string; plural: string; provider: string; blurb: string }> = {
  APP: { label: "App", plural: "Apps", provider: "Fly.io", blurb: "Container with HTTPS" },
  WORKER: { label: "Worker", plural: "Workers", provider: "Fly.io", blurb: "Background process" },
  POSTGRES: { label: "Postgres", plural: "Postgres", provider: "Neon", blurb: "Serverless Postgres" },
  REDIS: { label: "Redis", plural: "Redis", provider: "Upstash", blurb: "Serverless Redis" },
};

const STATUS: Record<ResourceStatus | "SUBMITTING", { label: string; dot: string; text: string; pulse?: boolean }> = {
  SUBMITTING: { label: "Submitting", dot: "bg-zinc-400", text: "text-zinc-400", pulse: true },
  PENDING: { label: "Queued", dot: "bg-zinc-400", text: "text-zinc-400", pulse: true },
  PROVISIONING: { label: "Provisioning", dot: "bg-sky-400", text: "text-sky-300", pulse: true },
  ACTIVE: { label: "Running", dot: "bg-emerald-400", text: "text-emerald-300" },
  FAILED: { label: "Failed", dot: "bg-red-400", text: "text-red-300" },
  DELETING: { label: "Deleting", dot: "bg-amber-400", text: "text-amber-300", pulse: true },
  DELETED: { label: "Deleted", dot: "bg-zinc-600", text: "text-zinc-500" },
};

export function StatusBadge({ status }: { status: keyof typeof STATUS }) {
  const s = STATUS[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${s.text}`}>
      <span className="relative flex h-1.5 w-1.5">
        {s.pulse && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${s.dot}`} />}
        <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${s.dot}`} />
      </span>
      {s.label}
    </span>
  );
}

export function TypePill({ type }: { type: ResourceType }) {
  return (
    <span className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-zinc-400">
      {TYPE_META[type].label}
    </span>
  );
}

/** Thin bar: emerald below 80%, amber up to 100%, red at or over the limit. */
export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const ratio = max > 0 ? Math.min(1, value / max) : value > 0 ? 1 : 0;
  const color = ratio >= 1 ? "bg-red-400" : ratio >= 0.8 ? "bg-amber-400" : "bg-emerald-400";
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className="h-1 w-full overflow-hidden rounded-full bg-zinc-800"
    >
      <div className={`h-full rounded-full transition-[width] duration-500 ${color}`} style={{ width: `${ratio * 100}%` }} />
    </div>
  );
}

export function Panel({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-zinc-800/80 bg-zinc-900/40">
      <header className="flex items-center justify-between gap-4 border-b border-zinc-800/80 px-5 py-3">
        <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}
