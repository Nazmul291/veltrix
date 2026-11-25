import { useMemo } from "react";
import { computeQuota, type QuotaCandidate, type QuotaReport } from "~/lib/quota";
import { useResourceStore, type ResourceState } from "~/store/useResourceStore";

/** Quota for a store snapshot. Optimistic (in-flight) resources count too, so double-submits are caught. */
export function quotaFromState(state: ResourceState, candidate?: QuotaCandidate | null): QuotaReport {
  return computeQuota({
    plan: state.plan,
    resources: [...Object.values(state.resources), ...Object.values(state.optimistic)],
    candidate,
  });
}

/**
 * Live quota and cost report for the current tenant. Pass a candidate (what the
 * user is filling in on a form) to get projected cost and a canProvision verdict.
 * This is advisory UX. The api.resources action runs the same computeQuota
 * under a lock and has the final say.
 */
export function useQuotaCalculator(candidate?: QuotaCandidate | null): QuotaReport {
  const plan = useResourceStore((s) => s.plan);
  const resources = useResourceStore((s) => s.resources);
  const optimistic = useResourceStore((s) => s.optimistic);
  const type = candidate?.type;
  const size = candidate?.size;

  return useMemo(
    () =>
      computeQuota({
        plan,
        resources: [...Object.values(resources), ...Object.values(optimistic)],
        candidate: type && size ? { type, size } : null,
      }),
    [plan, resources, optimistic, type, size],
  );
}
