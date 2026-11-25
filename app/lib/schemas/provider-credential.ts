import { z } from "zod";
import { PROVIDERS, getFieldDef, type ProviderId } from "../providers";

const target = {
  provider: z.enum(PROVIDERS),
  field: z.string().min(1).max(64),
};

export const providerCredentialMutationSchema = z
  .discriminatedUnion("intent", [
    z.object({
      intent: z.literal("save"),
      ...target,
      // Trim, because pasted tokens often carry a trailing newline.
      value: z.string().trim().min(1, "Value is required").max(8192, "Value is too long"),
    }),
    z.object({ intent: z.literal("revoke"), ...target }),
  ])
  .superRefine((v, ctx) => {
    const def = getFieldDef(v.provider, v.field);
    if (!def) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["field"], message: "Unknown field for this provider" });
      return;
    }
    if (v.intent === "save" && def.options && !def.options.includes(v.value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: `Must be one of: ${def.options.join(", ")}`,
      });
    }
  });

export type ProviderCredentialMutation = z.infer<typeof providerCredentialMutationSchema>;

/** Action response. It never contains the secret value. */
export type ProviderCredentialActionData =
  | {
      ok: true;
      intent: "save" | "revoke";
      provider: ProviderId;
      field: string;
      version?: number;
      fingerprint?: string;
      unchanged?: boolean;
    }
  | { ok: false; formError?: string; fieldErrors?: { field?: string[]; value?: string[] } };

/** Load-only view of one credential field: metadata, never ciphertext. */
export interface CredentialFieldStatus {
  field: string;
  configured: boolean;
  version: number | null;
  fingerprint: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  lastUsedAt: string | null;
}
