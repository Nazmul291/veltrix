/**
 * The pattern: component → hook → useFetcher → Remix action → Zustand.
 *
 *   const { provision, isSubmitting, fieldErrors, formError } = useProvisionResource();
 *   <form onSubmit={(e) => { e.preventDefault(); provision(values); }}>
 *
 * 1. Validate on the client with the same zod schema the action uses.
 * 2. Check quota against the store (including in-flight resources).
 * 3. Add an optimistic entry so the UI updates at once.
 * 4. Submit with useFetcher to /api/resources (no raw fetch).
 * 5. On response: confirm or fail the optimistic entry. Remix then revalidates
 *    loaders, and ResourceStoreProvider re-hydrates with the server's data.
 */
import { useFetcher } from "@remix-run/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { RESOURCE_PROVIDER, getSizeDef } from "~/lib/plans";
import {
  provisionResourceSchema,
  type ProvisionActionData,
  type ProvisionFieldErrors,
  type ProvisionInput,
} from "~/lib/schemas/resource";
import { useResourceStore, useResourceStoreApi } from "~/store/useResourceStore";
import { quotaFromState } from "./useQuotaCalculator";

export const PROVISION_ACTION = "/api/resources";

export type ProvisionAttempt = { ok: true; clientId: string } | { ok: false; reason: string };

export function useProvisionResource() {
  const fetcher = useFetcher<ProvisionActionData>();
  const submitFetcher = fetcher.submit;
  const store = useResourceStoreApi();
  const addOptimistic = useResourceStore((s) => s.addOptimistic);
  const confirmOptimistic = useResourceStore((s) => s.confirmOptimistic);
  const failOptimistic = useResourceStore((s) => s.failOptimistic);

  const [clientFieldErrors, setClientFieldErrors] = useState<ProvisionFieldErrors | null>(null);
  const [clientFormError, setClientFormError] = useState<string | null>(null);
  const inflight = useRef<string | null>(null);

  const provision = useCallback(
    (input: ProvisionInput): ProvisionAttempt => {
      if (inflight.current) return { ok: false, reason: "A provisioning request is already in flight." };

      const parsed = provisionResourceSchema.safeParse(input);
      if (!parsed.success) {
        setClientFieldErrors(parsed.error.flatten().fieldErrors);
        setClientFormError(null);
        return { ok: false, reason: "Validation failed" };
      }

      const quota = quotaFromState(store.getState(), parsed.data);
      if (!quota.canProvision) {
        setClientFieldErrors(null);
        setClientFormError(quota.reason);
        return { ok: false, reason: quota.reason ?? "Quota exceeded" };
      }

      setClientFieldErrors(null);
      setClientFormError(null);

      const clientId = crypto.randomUUID();
      inflight.current = clientId;

      addOptimistic({
        clientId,
        ...parsed.data,
        provider: RESOURCE_PROVIDER[parsed.data.type],
        monthlyCostCents: getSizeDef(parsed.data.type, parsed.data.size)?.monthlyCostCents ?? 0,
        status: "PENDING",
        error: null,
        createdAt: new Date().toISOString(),
      });

      submitFetcher(
        { ...parsed.data, clientId },
        { method: "post", action: PROVISION_ACTION, encType: "application/json" },
      );
      return { ok: true, clientId };
    },
    [store, addOptimistic, submitFetcher],
  );

  // Settle the optimistic entry once the action responds.
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || !inflight.current) return;
    const clientId = inflight.current;
    inflight.current = null;

    const data = fetcher.data;
    if (data.ok) confirmOptimistic(clientId, data.resource);
    else failOptimistic(clientId, data.formError ?? "The server rejected this request.");
  }, [fetcher.state, fetcher.data, confirmOptimistic, failOptimistic]);

  const serverError = fetcher.data && !fetcher.data.ok ? fetcher.data : null;

  return {
    provision,
    isSubmitting: fetcher.state !== "idle",
    fieldErrors: clientFieldErrors ?? serverError?.fieldErrors ?? null,
    formError: clientFormError ?? serverError?.formError ?? null,
    lastResource: fetcher.data?.ok ? fetcher.data.resource : null,
  };
}
