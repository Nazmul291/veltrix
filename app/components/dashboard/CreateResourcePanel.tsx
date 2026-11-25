import { useEffect, useRef, useState } from "react";
import { useProvisionResource } from "~/hooks/useProvisionResource";
import { useQuotaCalculator } from "~/hooks/useQuotaCalculator";
import { REGIONS, RESOURCE_SIZES, RESOURCE_TYPES, type ResourceType } from "~/lib/plans";
import { formatCents } from "~/lib/quota";
import { Panel, TYPE_META } from "./ui";

const firstSize = (t: ResourceType) => Object.keys(RESOURCE_SIZES[t])[0];

const inputCls =
  "h-9 w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/40";

export function CreateResourcePanel() {
  const [type, setType] = useState<ResourceType>("APP");
  const [region, setRegion] = useState<string>(REGIONS.APP[0]);
  const [size, setSize] = useState(firstSize("APP"));

  const quota = useQuotaCalculator({ type, size });
  const { provision, isSubmitting, fieldErrors, formError, lastResource } = useProvisionResource();
  const formRef = useRef<HTMLFormElement>(null);

  // Clear the free-text fields once the server accepts the resource.
  useEffect(() => {
    if (lastResource) formRef.current?.reset();
  }, [lastResource]);

  const pickType = (t: ResourceType) => {
    setType(t);
    setRegion(REGIONS[t][0]);
    setSize(firstSize(t));
  };

  const isCompute = type === "APP" || type === "WORKER";
  const blocked = !quota.canProvision;

  return (
    <Panel title="New resource">
      <form
        ref={formRef}
        noValidate
        className="space-y-5 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          const image = String(fd.get("image") ?? "").trim();
          const port = String(fd.get("port") ?? "").trim();
          provision({
            type,
            region,
            size,
            name: String(fd.get("name") ?? ""),
            image: isCompute && image ? image : undefined,
            port: type === "APP" && port ? Number(port) : undefined,
          });
        }}
      >
        <fieldset>
          <legend className="mb-2 text-xs font-medium text-zinc-400">Type</legend>
          <div className="grid grid-cols-2 gap-2">
            {RESOURCE_TYPES.map((t) => {
              const unavailable = quota.byType[t].limit === 0;
              const selected = t === type;
              return (
                <button
                  key={t}
                  type="button"
                  aria-pressed={selected}
                  disabled={unavailable}
                  onClick={() => pickType(t)}
                  className={`rounded-lg border px-3 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${
                    selected ? "border-emerald-500/50 bg-emerald-500/5" : "border-zinc-800 hover:border-zinc-700"
                  }`}
                >
                  <span className="block text-sm font-medium text-zinc-100">{TYPE_META[t].label}</span>
                  <span className="block text-[11px] text-zinc-500">{unavailable ? "Not in your plan" : TYPE_META[t].provider}</span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <Field label="Name" error={fieldErrors?.name?.[0]}>
          <input name="name" autoComplete="off" spellCheck={false} placeholder="my-service" className={`${inputCls} font-mono`} />
        </Field>

        <Field label="Region" error={fieldErrors?.region?.[0]}>
          <select value={region} onChange={(e) => setRegion(e.target.value)} className={`${inputCls} font-mono`}>
            {REGIONS[type].map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </Field>

        <fieldset>
          <legend className="mb-2 text-xs font-medium text-zinc-400">Size</legend>
          <div className="space-y-1.5">
            {Object.entries(RESOURCE_SIZES[type]).map(([key, def]) => (
              <label
                key={key}
                className={`flex cursor-pointer items-center justify-between rounded-md border px-3 py-2 text-sm transition ${
                  key === size ? "border-emerald-500/50 bg-emerald-500/5" : "border-zinc-800 hover:border-zinc-700"
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <input
                    type="radio"
                    name="size"
                    value={key}
                    checked={key === size}
                    onChange={() => setSize(key)}
                    className="accent-emerald-500"
                  />
                  <span className="text-zinc-200">{def.label}</span>
                </span>
                <span className="font-mono text-xs text-zinc-400">
                  {def.monthlyCostCents === 0 ? "free" : `${formatCents(def.monthlyCostCents)}/mo`}
                </span>
              </label>
            ))}
          </div>
          {fieldErrors?.size?.[0] && <p className="mt-1 text-xs text-red-400">{fieldErrors.size[0]}</p>}
        </fieldset>

        {isCompute && (
          <details className="group rounded-md border border-zinc-800/80 px-3 py-2">
            <summary className="cursor-pointer select-none text-xs text-zinc-400 group-open:mb-3">Image settings (optional)</summary>
            <div className="space-y-3">
              <Field label="Image" error={fieldErrors?.image?.[0]}>
                <input name="image" spellCheck={false} placeholder="flyio/hellofly:latest" className={`${inputCls} font-mono`} />
              </Field>
              {type === "APP" && (
                <Field label="Internal port" error={fieldErrors?.port?.[0]}>
                  <input name="port" inputMode="numeric" placeholder="8080" className={`${inputCls} font-mono`} />
                </Field>
              )}
            </div>
          </details>
        )}

        <div className="space-y-3 border-t border-zinc-800/80 pt-4">
          <dl className="space-y-1 text-xs">
            <Row label="This resource" value={`+${formatCents(quota.candidateCostCents)}/mo`} />
            <Row
              label="New monthly total"
              value={`${formatCents(quota.projectedCostCents)} / ${formatCents(quota.budgetCents)}`}
              strong
            />
          </dl>

          {(blocked || formError) && (
            <p role="alert" className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">
              {blocked ? quota.reason : formError}
            </p>
          )}

          <button
            type="submit"
            disabled={blocked || isSubmitting}
            className="h-9 w-full rounded-md bg-zinc-100 text-sm font-medium text-zinc-950 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isSubmitting ? "Creating…" : `Create ${TYPE_META[type].label.toLowerCase()}`}
          </button>
        </div>
      </form>
    </Panel>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-zinc-400">{label}</span>
      {children}
      {error && <span className="block text-xs text-red-400">{error}</span>}
    </label>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between">
      <dt className="text-zinc-500">{label}</dt>
      <dd className={`font-mono ${strong ? "text-zinc-100" : "text-zinc-400"}`}>{value}</dd>
    </div>
  );
}
