/**
 * Per-resource mutations for the owning tenant:
 * - intent=delete: start teardown (ACTIVE/FAILED → DELETING → DELETED)
 * - intent=reveal: decrypt and return the connection string (POST and audited, never GET)
 */
import { json, type ActionFunctionArgs } from "@remix-run/node";
import { z } from "zod";
import type { ResourceMutationData } from "~/lib/schemas/resource";
import { getRequestContext, writeAuditLog } from "~/services/audit.server";
import { prisma } from "~/services/db.server";
import { enqueueDeprovision } from "~/services/jobs.server";
import { requestDeletion } from "~/services/provisioner.server";
import { decryptResourceSecret, toResourceDTO } from "~/services/resources.server";
import { assertSameOrigin, requireUser } from "~/services/session.server";

const bodySchema = z.object({ intent: z.enum(["delete", "reveal"]) });
const noStore = { "Cache-Control": "no-store, private" };

export async function action({ request, params }: ActionFunctionArgs) {
  const reply = (data: ResourceMutationData, status = 200) => json(data, { status, headers: noStore });

  assertSameOrigin(request);
  const user = await requireUser(request, { fresh: true });
  const id = params.id ?? "";

  const parsed = bodySchema.safeParse(Object.fromEntries(await request.formData()));
  if (!parsed.success) return reply({ ok: false, formError: "Unknown action" }, 422);

  if (parsed.data.intent === "delete") {
    const result = await requestDeletion(id, user.id);
    if (!result.ok) return reply({ ok: false, formError: result.reason }, result.reason === "Resource not found." ? 404 : 409);

    await writeAuditLog(prisma, {
      actorId: user.id,
      action: "resource.delete_requested",
      targetType: "Resource",
      targetId: id,
      context: getRequestContext(request),
    });
    if (result.resource.status === "DELETING") enqueueDeprovision(id);
    return reply({ ok: true, intent: "delete", resource: toResourceDTO(result.resource) });
  }

  // reveal: the ownerId filter is the tenant boundary. Another tenant's ID returns 404, not 403.
  const r = await prisma.resource.findFirst({
    where: { id, ownerId: user.id, status: "ACTIVE" },
    select: { id: true, secretCiphertext: true, secretIv: true, secretAuthTag: true },
  });
  if (!r) return reply({ ok: false, formError: "Resource not found." }, 404);

  const secret = decryptResourceSecret(r);
  await writeAuditLog(prisma, {
    actorId: user.id,
    action: "resource.secret_revealed",
    targetType: "Resource",
    targetId: id,
    context: getRequestContext(request),
  });
  return reply({ ok: true, intent: "reveal", secret });
}
