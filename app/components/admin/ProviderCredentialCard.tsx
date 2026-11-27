import { PROVIDER_REGISTRY, type ProviderId } from "~/lib/providers";
import type { CredentialFieldStatus } from "~/lib/schemas/provider-credential";
import { CredentialFieldRow } from "./CredentialFieldRow";

interface Props {
  provider: ProviderId;
  fields: CredentialFieldStatus[];
  canEdit: boolean;
}

export function ProviderCredentialCard({ provider, fields, canEdit }: Props) {
  const def = PROVIDER_REGISTRY[provider];
  const byKey = new Map(fields.map((f) => [f.field, f]));
  const required = def.fields.filter((f) => f.required);
  const isSet = (k: string) => Boolean(byKey.get(k)?.configured || byKey.get(k)?.fromEnvironment);
  const ready = required.every((f) => isSet(f.key));
  const partial = !ready && def.fields.some((f) => isSet(f.key));

  const badge = ready
    ? { text: "Ready", cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" }
    : partial
      ? { text: "Incomplete", cls: "border-amber-500/30 bg-amber-500/10 text-amber-400" }
      : { text: "Not configured", cls: "border-zinc-700 bg-zinc-800/50 text-zinc-400" };

  return (
    <section className="rounded-xl border border-zinc-800/80 bg-zinc-900/40">
      <header className="flex items-start justify-between gap-4 border-b border-zinc-800/80 px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">{def.name}</h2>
          <p className="mt-0.5 text-xs text-zinc-500">{def.description}</p>
        </div>
        <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${badge.cls}`}>{badge.text}</span>
      </header>

      <div className="divide-y divide-zinc-800/60 px-5">
        {def.fields.map((f) => (
          <CredentialFieldRow
            key={f.key}
            provider={provider}
            def={f}
            canEdit={canEdit}
            status={
              byKey.get(f.key) ?? {
                field: f.key,
                configured: false,
                version: null,
                fingerprint: null,
                updatedAt: null,
                updatedBy: null,
                lastUsedAt: null,
                fromEnvironment: false,
              }
            }
          />
        ))}
      </div>
    </section>
  );
}
