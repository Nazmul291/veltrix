import { z } from "zod";
import { REGIONS, RESOURCE_TYPES, getSizeDef, type ResourceType } from "../plans";
import type { ProviderId } from "../providers";

const baseShape = {
  type: z.enum(RESOURCE_TYPES),
  name: z
    .string()
    .trim()
    .toLowerCase()
    .min(3, "At least 3 characters")
    .max(30, "At most 30 characters")
    .regex(/^[a-z][a-z0-9-]*[a-z0-9]$/, "Lowercase letters, digits and hyphens; start with a letter"),
  region: z.string().min(1, "Pick a region"),
  size: z.string().min(1, "Pick a size"),
  /** APP and WORKER only. Defaults to a hello-world image until the tenant deploys their own. */
  image: z
    .string()
    .trim()
    .max(255)
    .regex(/^[a-z0-9]+(?:[._\-/:@][a-z0-9]+)*$/i, "Not a valid image reference")
    .optional(),
  /** APP only: the port the container listens on. */
  port: z.coerce.number().int().min(1).max(65535).optional(),
};

function refineCatalog(
  v: { type: ResourceType; region: string; size: string; image?: string; port?: number },
  ctx: z.RefinementCtx,
) {
  if (v.image !== undefined && v.type !== "APP" && v.type !== "WORKER") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["image"], message: "Only apps and workers take an image" });
  }
  if (v.port !== undefined && v.type !== "APP") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["port"], message: "Only apps expose a port" });
  }
  if (!REGIONS[v.type].includes(v.region)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["region"], message: `Region not available for ${v.type}` });
  }
  if (!getSizeDef(v.type, v.size)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["size"], message: `Size not available for ${v.type}` });
  }
}

/** What the UI collects. */
export const provisionResourceSchema = z.object(baseShape).superRefine(refineCatalog);
export type ProvisionInput = z.input<typeof provisionResourceSchema>;

/** What travels over the wire: the same fields plus a client correlation ID. */
export const provisionRequestSchema = z
  .object({ ...baseShape, clientId: z.string().uuid() })
  .superRefine(refineCatalog);
export type ProvisionRequest = z.infer<typeof provisionRequestSchema>;

export type ProvisionField = keyof ProvisionInput;
export type ProvisionFieldErrors = Partial<Record<ProvisionField, string[]>>;

export type ResourceStatus = "PENDING" | "PROVISIONING" | "ACTIVE" | "FAILED" | "DELETING" | "DELETED";

/** Serialisable resource shape sent to the client. It never includes secrets. */
export interface ResourceDTO {
  id: string;
  type: ResourceType;
  provider: ProviderId;
  name: string;
  region: string;
  size: string;
  status: ResourceStatus;
  monthlyCostCents: number;
  errorMessage: string | null;
  /** Public hostname (APP), or the database host (POSTGRES/REDIS). Not a secret. */
  hostname: string | null;
  createdAt: string;
}

export type ResourceMutationData =
  | { ok: true; intent: "delete"; resource: ResourceDTO }
  | { ok: true; intent: "reveal"; secret: string | null }
  | { ok: false; formError: string };

export type ProvisionActionData =
  | { ok: true; clientId: string; resource: ResourceDTO }
  | { ok: false; clientId?: string; formError?: string; fieldErrors?: ProvisionFieldErrors };
