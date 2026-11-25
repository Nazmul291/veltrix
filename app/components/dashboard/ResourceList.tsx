import { useEffect, useState } from "react";
import { useDeleteResource, useRevealSecret } from "~/hooks/useResourceActions";
import { getSizeDef } from "~/lib/plans";
import { formatCents } from "~/lib/quota";
import type { ResourceDTO } from "~/lib/schemas/resource";
import { useOptimisticResources, useResourceList, useResourceStore, type OptimisticResource } from "~/store/useResourceStore";
import { Panel, StatusBadge, TypePill } from "./ui";

export function ResourceList() {
  const resources = useResourceList();
  const optimistic = useOptimisticResources();
  const count = resources.length + optimistic.length;

  return (
    <Panel title="Resources" action={<span className="font-mono text-xs text-zinc-500">{count}</span>}>
      {count === 0 ? (
        <div className="px-5 py-14 text-center">
          <p className="text-sm text-zinc-300">Nothing deployed yet</p>
          <p className="mt-1 text-xs text-zinc-500">Create an app, worker, Postgres or Redis from the panel on the right.</p>
        </div>
      ) : (
        <ul className="divide-y divide-zinc-800/60">
          {optimistic.map((o) => (
            <OptimisticRow key={o.clientId} item={o} />
          ))}
          {resources.map((r) => (
            <ResourceRow key={r.id} resource={r} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function RowShell({ children }: { children: React.ReactNode }) {
  return <li className="px-5 py-4">{children}</li>;
}

function Summary({ name, type, region, size, cost }: { name: string; type: ResourceDTO["type"]; region: string; size: string; cost: number }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <TypePill type={type} />
        <span className="truncate font-mono text-sm text-zinc-100">{name}</span>
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        {region} · {getSizeDef(type, size)?.label ?? size} · <span className="font-mono">{formatCents(cost)}/mo</span>
      </p>
    </div>
  );
}

function OptimisticRow({ item }: { item: OptimisticResource }) {
  const dismiss = useResourceStore((s) => s.dismissOptimistic);
  return (
    <RowShell>
      <div className="flex items-start justify-between gap-4">
        <Summary name={item.name} type={item.type} region={item.region} size={item.size} cost={item.monthlyCostCents} />
        <div className="flex shrink-0 items-center gap-3">
          <StatusBadge status={item.status === "FAILED" ? "FAILED" : "SUBMITTING"} />
          {item.status === "FAILED" && (
            <button onClick={() => dismiss(item.clientId)} className="text-xs text-zinc-500 hover:text-zinc-300">
              Dismiss
            </button>
          )}
        </div>
      </div>
      {item.error && <p className="mt-2 text-xs text-red-300/90">{item.error}</p>}
    </RowShell>
  );
}

const HAS_SECRET = new Set(["POSTGRES", "REDIS"]);

function ResourceRow({ resource: r }: { resource: ResourceDTO }) {
  const del = useDeleteResource(r.id);
  const secret = useRevealSecret(r.id);
  const [confirming, setConfirming] = useState(false);
  const canDelete = r.status === "ACTIVE" || r.status === "FAILED";

  return (
    <RowShell>
      <div className="flex items-start justify-between gap-4">
        <Summary name={r.name} type={r.type} region={r.region} size={r.size} cost={r.monthlyCostCents} />
        <StatusBadge status={r.status} />
      </div>

      {r.hostname && r.status === "ACTIVE" && (
        <p className="mt-2 font-mono text-xs text-zinc-400">
          {r.type === "APP" ? (
            <a href={`https://${r.hostname}`} target="_blank" rel="noreferrer" className="hover:text-zinc-200 hover:underline">
              https://{r.hostname} ↗
            </a>
          ) : (
            r.hostname
          )}
        </p>
      )}

      {r.errorMessage && r.status !== "ACTIVE" && <p className="mt-2 text-xs text-red-300/90">{r.errorMessage}</p>}

      {secret.secret && <SecretBox value={secret.secret} onHide={secret.hide} />}

      {(canDelete || (HAS_SECRET.has(r.type) && r.status === "ACTIVE")) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {HAS_SECRET.has(r.type) && r.status === "ACTIVE" && !secret.secret && (
            <button
              onClick={secret.reveal}
              disabled={secret.isRevealing}
              className="h-7 rounded-md border border-zinc-800 px-2.5 text-xs text-zinc-300 hover:border-zinc-700 hover:text-zinc-100 disabled:opacity-50"
            >
              {secret.isRevealing ? "Decrypting…" : "Show connection string"}
            </button>
          )}
          {canDelete &&
            (confirming ? (
              <>
                <button
                  onClick={del.remove}
                  disabled={del.isDeleting}
                  className="h-7 rounded-md bg-red-500/90 px-2.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
                >
                  {del.isDeleting ? "Deleting…" : `Delete ${r.name}`}
                </button>
                <button onClick={() => setConfirming(false)} className="h-7 px-2 text-xs text-zinc-500 hover:text-zinc-300">
                  Cancel
                </button>
              </>
            ) : (
              <button
                onClick={() => setConfirming(true)}
                className="h-7 rounded-md px-2.5 text-xs text-zinc-500 hover:text-red-400"
              >
                Delete
              </button>
            ))}
          {(del.error || secret.error) && <span className="text-xs text-red-300">{del.error ?? secret.error}</span>}
        </div>
      )}
    </RowShell>
  );
}

function SecretBox({ value, onHide }: { value: string; onHide: () => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <div className="mt-3 flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950 p-2">
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-200" title="Connection string">
        {value}
      </code>
      <button
        onClick={() => navigator.clipboard.writeText(value).then(() => setCopied(true))}
        className="h-6 shrink-0 rounded px-2 text-xs text-zinc-300 hover:bg-zinc-800"
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <button onClick={onHide} className="h-6 shrink-0 rounded px-2 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300">
        Hide
      </button>
    </div>
  );
}
