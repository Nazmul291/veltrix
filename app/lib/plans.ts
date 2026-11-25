/**
 * Client-safe catalog of plans, resource sizes and prices. The server uses it as
 * the source of truth for cost: the client never sends a price.
 * The figures are placeholders until real pricing is set.
 */
import type { ProviderId } from "./providers";

export const PLANS = ["FREE", "PRO", "TEAM"] as const;
export type PlanId = (typeof PLANS)[number];

export const RESOURCE_TYPES = ["APP", "WORKER", "POSTGRES", "REDIS"] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const RESOURCE_PROVIDER: Record<ResourceType, ProviderId> = {
  APP: "FLY",
  WORKER: "FLY",
  POSTGRES: "NEON",
  REDIS: "UPSTASH",
};

export interface SizeDef {
  label: string;
  monthlyCostCents: number;
}

export const RESOURCE_SIZES: Record<ResourceType, Record<string, SizeDef>> = {
  APP: {
    "shared-1x-256": { label: "shared-cpu-1x · 256 MB", monthlyCostCents: 200 },
    "shared-1x-1024": { label: "shared-cpu-1x · 1 GB", monthlyCostCents: 600 },
    "performance-1x": { label: "performance-1x · 2 GB", monthlyCostCents: 3200 },
  },
  WORKER: {
    "shared-1x-256": { label: "shared-cpu-1x · 256 MB", monthlyCostCents: 200 },
    "shared-2x-512": { label: "shared-cpu-2x · 512 MB", monthlyCostCents: 450 },
  },
  POSTGRES: {
    "free-0.25cu": { label: "0.25 CU · 0.5 GB storage", monthlyCostCents: 0 },
    "launch-1cu": { label: "1 CU · 10 GB storage", monthlyCostCents: 1900 },
    "scale-2cu": { label: "2 CU · 50 GB storage", monthlyCostCents: 6900 },
  },
  REDIS: {
    payg: { label: "Pay-as-you-go", monthlyCostCents: 0 },
    "fixed-1gb": { label: "Fixed · 1 GB", monthlyCostCents: 1000 },
  },
};

export const REGIONS: Record<ResourceType, readonly string[]> = {
  APP: ["iad", "ord", "lhr", "fra", "sin", "syd"],
  WORKER: ["iad", "ord", "lhr", "fra", "sin", "syd"],
  POSTGRES: ["aws-us-east-1", "aws-us-west-2", "aws-eu-central-1", "aws-ap-southeast-1"],
  REDIS: ["us-east-1", "eu-west-1", "ap-southeast-1"],
};

export interface PlanLimits {
  maxResources: Record<ResourceType, number>;
  monthlyBudgetCents: number;
}

export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  FREE: { maxResources: { APP: 1, WORKER: 0, POSTGRES: 1, REDIS: 1 }, monthlyBudgetCents: 500 },
  PRO: { maxResources: { APP: 5, WORKER: 5, POSTGRES: 3, REDIS: 3 }, monthlyBudgetCents: 10_000 },
  TEAM: { maxResources: { APP: 25, WORKER: 25, POSTGRES: 10, REDIS: 10 }, monthlyBudgetCents: 100_000 },
};

/**
 * Display prices, in cents per month. What's actually charged is the Paddle price
 * configured in /admin/providers. Keep the two in sync.
 */
export const PLAN_PRICE_CENTS: Record<PlanId, number> = { FREE: 0, PRO: 2000, TEAM: 9900 };

export const PLAN_RANK: Record<PlanId, number> = { FREE: 0, PRO: 1, TEAM: 2 };

export function getSizeDef(type: ResourceType, size: string): SizeDef | undefined {
  return Object.hasOwn(RESOURCE_SIZES[type], size) ? RESOURCE_SIZES[type][size] : undefined;
}
