/**
 * Global resource state (Zustand).
 *
 * Why a context-scoped store instead of a module-level `create()`:
 * Remix renders on the server, and on the server a module-level store is a
 * singleton shared by every request in the process. Hydrating it with tenant
 * A's resources would leak them into tenant B's SSR HTML. So we build one store
 * per request, or per browser tab, inside <ResourceStoreProvider>, seeded from
 * loader data. It still behaves as a global store for every component under it.
 */
import { createContext, createElement, useContext, useEffect, useRef, type ReactNode } from "react";
import { createStore, useStore, type StoreApi } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { PlanId, ResourceType } from "~/lib/plans";
import type { ProviderId } from "~/lib/providers";
import type { ResourceDTO } from "~/lib/schemas/resource";

/** A resource the user asked for that the server hasn't confirmed yet. */
export interface OptimisticResource {
  clientId: string;
  type: ResourceType;
  provider: ProviderId;
  name: string;
  region: string;
  size: string;
  monthlyCostCents: number;
  status: "PENDING" | "FAILED";
  error: string | null;
  createdAt: string;
}

export interface ResourceStoreInit {
  plan: PlanId;
  resources: ResourceDTO[];
}

export interface ResourceState {
  plan: PlanId;
  resources: Record<string, ResourceDTO>;
  optimistic: Record<string, OptimisticResource>;
  selectedId: string | null;

  hydrate: (init: ResourceStoreInit) => void;
  select: (id: string | null) => void;
  addOptimistic: (r: OptimisticResource) => void;
  confirmOptimistic: (clientId: string, resource: ResourceDTO) => void;
  failOptimistic: (clientId: string, error: string) => void;
  dismissOptimistic: (clientId: string) => void;
  upsertResource: (r: ResourceDTO) => void;
  removeResource: (id: string) => void;
}

const toRecord = (list: ResourceDTO[]) => Object.fromEntries(list.map((r) => [r.id, r]));
const omit = <T>(rec: Record<string, T>, key: string) => {
  const { [key]: _removed, ...rest } = rec;
  return rest;
};

export function createResourceStore(init: ResourceStoreInit): StoreApi<ResourceState> {
  return createStore<ResourceState>()((set) => ({
    plan: init.plan,
    resources: toRecord(init.resources),
    optimistic: {},
    selectedId: null,

    // Called whenever the loader revalidates. Server data wins. Optimistic
    // entries the server now knows about are dropped, which covers revalidation
    // landing before the fetcher's own effect runs.
    hydrate: ({ plan, resources }) =>
      set((s) => {
        const known = new Set(resources.map((r) => `${r.type}:${r.name}`));
        const optimistic = Object.fromEntries(
          Object.entries(s.optimistic).filter(([, o]) => !known.has(`${o.type}:${o.name}`)),
        );
        return { plan, resources: toRecord(resources), optimistic };
      }),

    select: (id) => set({ selectedId: id }),

    addOptimistic: (r) => set((s) => ({ optimistic: { ...s.optimistic, [r.clientId]: r } })),

    confirmOptimistic: (clientId, resource) =>
      set((s) => ({
        optimistic: omit(s.optimistic, clientId),
        resources: { ...s.resources, [resource.id]: resource },
      })),

    failOptimistic: (clientId, error) =>
      set((s) => {
        const o = s.optimistic[clientId];
        if (!o) return s;
        return { optimistic: { ...s.optimistic, [clientId]: { ...o, status: "FAILED", error } } };
      }),

    dismissOptimistic: (clientId) => set((s) => ({ optimistic: omit(s.optimistic, clientId) })),

    upsertResource: (r) => set((s) => ({ resources: { ...s.resources, [r.id]: r } })),

    removeResource: (id) =>
      set((s) => ({ resources: omit(s.resources, id), selectedId: s.selectedId === id ? null : s.selectedId })),
  }));
}

// ─── Provider & hooks ───────────────────────────────────────────────────────

const ResourceStoreContext = createContext<StoreApi<ResourceState> | null>(null);

export function ResourceStoreProvider({ initial, children }: { initial: ResourceStoreInit; children: ReactNode }) {
  const storeRef = useRef<StoreApi<ResourceState> | null>(null);
  if (!storeRef.current) storeRef.current = createResourceStore(initial);

  // Re-sync with the server after every loader revalidation (after actions, on focus, …).
  const isFirst = useRef(true);
  useEffect(() => {
    if (isFirst.current) {
      isFirst.current = false;
      return;
    }
    storeRef.current?.getState().hydrate(initial);
  }, [initial]);

  return createElement(ResourceStoreContext.Provider, { value: storeRef.current }, children);
}

export function useResourceStoreApi(): StoreApi<ResourceState> {
  const store = useContext(ResourceStoreContext);
  if (!store) throw new Error("useResourceStore must be used inside <ResourceStoreProvider>");
  return store;
}

/** Subscribe with a selector. Use `useShallow` (or the hooks below) for derived arrays and objects. */
export function useResourceStore<T>(selector: (s: ResourceState) => T): T {
  return useStore(useResourceStoreApi(), selector);
}

// ─── Selectors ──────────────────────────────────────────────────────────────

export const selectResourceList = (s: ResourceState) =>
  Object.values(s.resources)
    .filter((r) => r.status !== "DELETED")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

export const selectOptimisticList = (s: ResourceState) =>
  Object.values(s.optimistic).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

export const useResourceList = () => useResourceStore(useShallow(selectResourceList));
export const useOptimisticResources = () => useResourceStore(useShallow(selectOptimisticList));
