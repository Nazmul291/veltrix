/**
 * Resource route: GET lists the tenant's resources, POST provisions one.
 * Called through useProvisionResource (useFetcher). There's no UI here.
 */
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { RESOURCE_PROVIDER, getSizeDef } from "~/lib/plans";
import { computeQuota } from "~/lib/quota";
import { provisionRequestSchema, type ProvisionActionData } from "~/lib/schemas/resource";
import { getRequestContext, writeAuditLog } from "~/services/audit.server";
import { isUniqueViolation } from "~/services/credentials.server";
import { prisma } from "~/services/db.server";
import { enqueueProvision } from "~/services/jobs.server";
import { listTenantResources, toResourceDTO } from "~/services/resources.server";
import { assertSameOrigin, requireUser } from "~/services/session.server";

const noStore = { "Cache-Control": "no-store" };

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireUser(request);
  return json({ plan: user.plan, resources: await listTenantResources(user.id) }, { headers: noStore });
}

export async function action({ request }: ActionFunctionArgs) {
  const reply = (data: ProvisionActionData, status = 200) => json(data, { status, headers: noStore });

  if (request.method !== "POST") return reply({ ok: false, formError: "Method not allowed" }, 405);
  assertSameOrigin(request);
  const user = await requireUser(request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return reply({ ok: false, formError: "Expected a JSON body" }, 400);
  }

  const parsed = provisionRequestSchema.safeParse(body);
  if (!parsed.success) {
    const { fieldErrors } = parsed.error.flatten();
    const { clientId: _c, ...rest } = fieldErrors;
    return reply({ ok: false, formError: "Invalid request", fieldErrors: rest }, 422);
  }

  const { clientId, image, port, ...input } = parsed.data;
  const provider = RESOURCE_PROVIDER[input.type];
  const monthlyCostCents = getSizeDef(input.type, input.size)!.monthlyCostCents; // the schema guarantees the size exists

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      // Serialise provisioning per tenant, so parallel requests can't both pass the quota check.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`;

      const live = await tx.resource.findMany({
        where: { ownerId: user.id, status: { notIn: ["DELETED", "FAILED"] } },
        select: { type: true, monthlyCostCents: true, status: true },
      });
      const quota = computeQuota({ plan: user.plan, resources: live, candidate: input });
      if (!quota.canProvision) return { ok: false as const, reason: quota.reason ?? "Quota exceeded" };

      const resource = await tx.resource.create({
        data: {
          ownerId: user.id,
          provider,
          monthlyCostCents,
          status: "PENDING",
          config: { ...(image ? { image } : {}), ...(port ? { port } : {}) },
          ...input,
        },
      });

      await writeAuditLog(tx, {
        actorId: user.id,
        action: "resource.provision_requested",
        targetType: "Resource",
        targetId: resource.id,
        metadata: { type: input.type, provider, size: input.size, region: input.region },
        context: getRequestContext(request),
      });

      return { ok: true as const, resource };
    });

    if (!outcome.ok) return reply({ ok: false, clientId, formError: outcome.reason }, 403);

    // Start now. If this process dies first, the sweeper picks the row up within 30s.
    enqueueProvision(outcome.resource.id);
    return reply({ ok: true, clientId, resource: toResourceDTO(outcome.resource) }, 201);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return reply({ ok: false, clientId, fieldErrors: { name: [`You already have a ${input.type} named "${input.name}"`] } }, 409);
    }
    console.error("[api.resources] provision failed", { userId: user.id, error: (err as Error).name });
    return reply({ ok: false, clientId, formError: "Something went wrong. Please try again." }, 500);
  }
}
