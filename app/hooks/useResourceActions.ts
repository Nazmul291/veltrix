import { useFetcher, useRevalidator } from "@remix-run/react";
import { useCallback, useEffect, useState } from "react";
import type { ResourceMutationData } from "~/lib/schemas/resource";
import { useResourceStore } from "~/store/useResourceStore";

const actionFor = (id: string) => `/api/resources/${id}`;

/** Delete a resource. The store switches it to DELETING as soon as the server accepts. */
export function useDeleteResource(resourceId: string) {
  const fetcher = useFetcher<ResourceMutationData>();
  const submitFetcher = fetcher.submit;
  const upsertResource = useResourceStore((s) => s.upsertResource);
  const removeResource = useResourceStore((s) => s.removeResource);

  const remove = useCallback(
    () => submitFetcher({ intent: "delete" }, { method: "post", action: actionFor(resourceId) }),
    [submitFetcher, resourceId],
  );

  useEffect(() => {
    const d = fetcher.data;
    if (fetcher.state !== "idle" || !d?.ok || d.intent !== "delete") return;
    if (d.resource.status === "DELETED") removeResource(d.resource.id);
    else upsertResource(d.resource);
  }, [fetcher.state, fetcher.data, upsertResource, removeResource]);

  return {
    remove,
    isDeleting: fetcher.state !== "idle",
    error: fetcher.data && !fetcher.data.ok ? fetcher.data.formError : null,
  };
}

/**
 * Show a connection string on demand. The secret lives only in this hook's
 * local state. It never goes into the Zustand store, and hide() drops it.
 */
export function useRevealSecret(resourceId: string) {
  const fetcher = useFetcher<ResourceMutationData>();
  const submitFetcher = fetcher.submit;
  const [secret, setSecret] = useState<string | null>(null);

  const reveal = useCallback(
    () => submitFetcher({ intent: "reveal" }, { method: "post", action: actionFor(resourceId) }),
    [submitFetcher, resourceId],
  );

  useEffect(() => {
    const d = fetcher.data;
    if (fetcher.state === "idle" && d?.ok && d.intent === "reveal") setSecret(d.secret);
  }, [fetcher.state, fetcher.data]);

  return {
    reveal,
    hide: useCallback(() => setSecret(null), []),
    secret,
    isRevealing: fetcher.state !== "idle",
    error: fetcher.data && !fetcher.data.ok ? fetcher.data.formError : null,
  };
}

const TRANSITIONAL = new Set(["PENDING", "PROVISIONING", "DELETING"]);

/**
 * While any resource is in a transitional state, re-run the loaders every few
 * seconds. ResourceStoreProvider then re-hydrates the store from the new loader
 * data. Polling pauses while the tab is hidden.
 */
export function useResourceStatusPolling(intervalMs = 3_000) {
  const { revalidate, state } = useRevalidator();
  const busy = useResourceStore(
    (s) => Object.values(s.resources).some((r) => TRANSITIONAL.has(r.status)) || Object.keys(s.optimistic).length > 0,
  );

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible" && state === "idle") revalidate();
    }, intervalMs);
    return () => clearInterval(t);
  }, [busy, state, revalidate, intervalMs]);
}
