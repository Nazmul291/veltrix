import { z } from "zod";

export const billingMutationSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("checkout"), plan: z.enum(["PRO", "TEAM"]) }),
  z.object({ intent: z.literal("change_plan"), plan: z.enum(["FREE", "PRO", "TEAM"]) }),
  z.object({ intent: z.literal("resume") }),
  z.object({ intent: z.literal("portal") }),
]);
export type BillingMutation = z.infer<typeof billingMutationSchema>;

export type BillingActionData =
  | { ok: true; intent: "checkout"; transactionId: string }
  | { ok: true; intent: "portal"; url: string }
  | { ok: true; intent: "change_plan" | "resume" }
  | { ok: false; error: string };

export interface PaddleClientConfig {
  clientToken: string;
  environment: "sandbox" | "production";
}
