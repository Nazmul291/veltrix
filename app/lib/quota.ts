/**
 * Pure quota and cost maths, shared by the client (useQuotaCalculator, for
 * instant feedback) and the server (api.resources action, which has the final say).
 */
import { PLAN_LIMITS, RESOURCE_TYPES, getSizeDef, type PlanId, type ResourceType } from "./plans";

export interface QuotaResource {
  type: ResourceType;
  monthlyCostCents: number;
  status: string;
}

export interface QuotaCandidate {
  type: ResourceType;
  size: string;
}

export interface TypeUsage {
  used: number;
  limit: number;
  remaining: number;
}

export interface QuotaReport {
  plan: PlanId;
  byType: Record<ResourceType, TypeUsage>;
  currentCostCents: number;
  budgetCents: number;
  budgetRemainingCents: number;
  candidateCostCents: number;
  projectedCostCents: number;
  canProvision: boolean;
  reason: string | null;
}

/** These statuses count against neither the quota nor the bill. */
const NON_BILLABLE = new Set(["FAILED", "DELETED"]);

export function computeQuota(input: {
  plan: PlanId;
  resources: readonly QuotaResource[];
  candidate?: QuotaCandidate | null;
}): QuotaReport {
  const limits = PLAN_LIMITS[input.plan];
  const live = input.resources.filter((r) => !NON_BILLABLE.has(r.status));

  const byType = Object.fromEntries(
    RESOURCE_TYPES.map((t) => {
      const used = live.filter((r) => r.type === t).length;
      const limit = limits.maxResources[t];
      return [t, { used, limit, remaining: Math.max(0, limit - used) }];
    }),
  ) as Record<ResourceType, TypeUsage>;

  const currentCostCents = live.reduce((sum, r) => sum + r.monthlyCostCents, 0);
  const budgetCents = limits.monthlyBudgetCents;

  let candidateCostCents = 0;
  let reason: string | null = null;

  if (input.candidate) {
    const { type, size } = input.candidate;
    const sizeDef = getSizeDef(type, size);
    if (!sizeDef) {
      reason = `Unknown size "${size}" for ${type}.`;
    } else {
      candidateCostCents = sizeDef.monthlyCostCents;
      if (byType[type].remaining <= 0) {
        reason =
          byType[type].limit === 0
            ? `${type} resources are not included in the ${input.plan} plan.`
            : `${input.plan} plan limit reached: ${byType[type].limit} ${type} resource(s).`;
      } else if (currentCostCents + candidateCostCents > budgetCents) {
        reason = `This would exceed your ${formatCents(budgetCents)}/mo plan budget.`;
      }
    }
  }

  return {
    plan: input.plan,
    byType,
    currentCostCents,
    budgetCents,
    budgetRemainingCents: Math.max(0, budgetCents - currentCostCents),
    candidateCostCents,
    projectedCostCents: currentCostCents + candidateCostCents,
    canProvision: input.candidate ? reason === null : true,
    reason,
  };
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
