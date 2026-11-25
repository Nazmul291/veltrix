import { useFetcher } from "@remix-run/react";
import { useCallback, useState } from "react";
import type { ProviderId } from "~/lib/providers";
import {
  providerCredentialMutationSchema,
  type ProviderCredentialActionData,
} from "~/lib/schemas/provider-credential";

export const ADMIN_PROVIDERS_ACTION = "/admin/providers";

/**
 * Save, rotate or revoke one provider credential field. Each call to this hook
 * owns its own fetcher, so every field row submits, and shows pending state, on its own.
 */
export function useProviderCredentialMutation(provider: ProviderId, field: string) {
  const fetcher = useFetcher<ProviderCredentialActionData>();
  const [clientError, setClientError] = useState<string | null>(null);

  const submit = useCallback(
    (payload: unknown) => {
      const parsed = providerCredentialMutationSchema.safeParse(payload);
      if (!parsed.success) {
        setClientError(parsed.error.issues[0]?.message ?? "Invalid input");
        return false;
      }
      setClientError(null);
      fetcher.submit(parsed.data, { method: "post", action: ADMIN_PROVIDERS_ACTION });
      return true;
    },
    [fetcher.submit],
  );

  const save = useCallback(
    (value: FormDataEntryValue | null) => submit({ intent: "save", provider, field, value }),
    [submit, provider, field],
  );
  const revoke = useCallback(() => submit({ intent: "revoke", provider, field }), [submit, provider, field]);

  const pendingIntent = fetcher.state !== "idle" ? fetcher.formData?.get("intent") : null;
  const data = fetcher.data;

  return {
    save,
    revoke,
    isSaving: pendingIntent === "save",
    isRevoking: pendingIntent === "revoke",
    error: clientError ?? (data && !data.ok ? (data.fieldErrors?.value?.[0] ?? data.formError ?? "Request failed") : null),
    /** A new object after each successful response, so it works as an effect dependency. */
    result: data?.ok ? data : null,
  };
}
