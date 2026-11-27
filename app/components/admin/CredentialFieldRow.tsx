import { useEffect, useRef, useState } from "react";
import { useProviderCredentialMutation } from "~/hooks/useProviderCredentialMutation";
import { formatFingerprint, type ProviderFieldDef, type ProviderId } from "~/lib/providers";
import type { CredentialFieldStatus } from "~/lib/schemas/provider-credential";

const formatUtc = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

interface Props {
  provider: ProviderId;
  def: ProviderFieldDef;
  status: CredentialFieldStatus;
  canEdit: boolean;
}

export function CredentialFieldRow({ provider, def, status, canEdit }: Props) {
  const { save, revoke, isSaving, isRevoking, error, result } = useProviderCredentialMutation(provider, def.key);
  const formRef = useRef<HTMLFormElement>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  // Clear the secret from the DOM once the server accepts it.
  useEffect(() => {
    if (result) {
      formRef.current?.reset();
      setConfirmRevoke(false);
    }
  }, [result]);

  const inputId = `${provider}-${def.key}`;
  const busy = isSaving || isRevoking;

  return (
    <div className="grid gap-3 py-4 md:grid-cols-[220px_1fr] md:gap-6">
      <div>
        <label htmlFor={inputId} className="flex items-center gap-2 text-sm font-medium text-zinc-200">
          {def.label}
          {!def.required && <span className="text-[10px] uppercase tracking-wider text-zinc-500">optional</span>}
        </label>
        <p className="mt-0.5 text-xs text-zinc-500">{def.hint}</p>
      </div>

      <div className="space-y-2">
        <StatusLine status={status} />

        {canEdit && (
          <form
            ref={formRef}
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              save(new FormData(e.currentTarget).get("value"));
            }}
          >
            {def.options ? (
              <select
                id={inputId}
                name="value"
                defaultValue=""
                className="h-9 flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-3 font-mono text-sm text-zinc-100 focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
              >
                <option value="" disabled>
                  Select…
                </option>
                {def.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={inputId}
                name="value"
                type="password"
                autoComplete="off"
                spellCheck={false}
                data-1p-ignore
                data-lpignore="true"
                placeholder={status.configured ? "Paste a new value to rotate" : "Paste value"}
                className="h-9 flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-3 font-mono text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
              />
            )}

            <button
              type="submit"
              disabled={busy}
              className="h-9 rounded-md bg-zinc-100 px-4 text-sm font-medium text-zinc-950 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSaving ? "Encrypting…" : status.configured ? "Rotate" : "Save"}
            </button>

            {status.configured &&
              (confirmRevoke ? (
                <span className="flex gap-2">
                  <button
                    type="button"
                    onClick={revoke}
                    disabled={busy}
                    className="h-9 rounded-md bg-red-500/90 px-3 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
                  >
                    {isRevoking ? "Revoking…" : "Confirm revoke"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmRevoke(false)}
                    className="h-9 rounded-md px-3 text-sm text-zinc-400 hover:text-zinc-200"
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmRevoke(true)}
                  disabled={busy}
                  className="h-9 rounded-md border border-zinc-800 px-3 text-sm text-zinc-400 hover:border-red-500/50 hover:text-red-400 disabled:opacity-50"
                >
                  Revoke
                </button>
              ))}
          </form>
        )}

        {error && <p className="text-xs text-red-400">{error}</p>}
        {result?.intent === "save" && (
          <p className="text-xs text-emerald-400">
            {result.unchanged
              ? "This value is already active. Nothing changed."
              : `Encrypted and stored as v${result.version}.`}
          </p>
        )}
      </div>
    </div>
  );
}

function StatusLine({ status }: { status: CredentialFieldStatus }) {
  if (!status.configured && status.fromEnvironment) {
    return (
      <div className="flex items-center gap-2 text-xs text-sky-300/90">
        <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
        From environment variable. Saving a value here overrides it.
      </div>
    );
  }
  if (!status.configured) {
    return (
      <div className="flex items-center gap-2 text-xs text-zinc-500">
        <span className="h-1.5 w-1.5 rounded-full bg-zinc-600" />
        Not set
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
      <span className="flex items-center gap-2">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
        <span className="text-zinc-300">v{status.version}</span>
      </span>
      <span className="font-mono text-zinc-500" title="HMAC fingerprint: identifies the key without revealing it">
        {formatFingerprint(status.fingerprint ?? "")}
      </span>
      {status.updatedAt && (
        <span>
          set {formatUtc(status.updatedAt)}
          {status.updatedBy && <> by {status.updatedBy}</>}
        </span>
      )}
      <span>{status.lastUsedAt ? `last used ${formatUtc(status.lastUsedAt)}` : "never used"}</span>
    </div>
  );
}
