import {
  json,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "@remix-run/node";
import { isRouteErrorResponse, useLoaderData, useRouteError } from "@remix-run/react";
import { ProviderCredentialCard } from "~/components/admin/ProviderCredentialCard";
import { PROVIDERS } from "~/lib/providers";
import {
  providerCredentialMutationSchema,
  type ProviderCredentialActionData,
} from "~/lib/schemas/provider-credential";
import { getRequestContext } from "~/services/audit.server";
import {
  isUniqueViolation,
  listProviderCredentialStatus,
  revokeProviderCredential,
  saveProviderCredential,
} from "~/services/credentials.server";
import { assertSameOrigin, requireAdmin } from "~/services/session.server";

const noStore = { "Cache-Control": "no-store" };

export const meta: MetaFunction = () => [
  { title: "Providers · Veltrix Admin" },
  { name: "robots", content: "noindex, nofollow" },
];

// ─── Loader: metadata only, never ciphertext or plaintext ───────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  const admin = await requireAdmin(request, "ADMIN");
  const status = await listProviderCredentialStatus();
  return json({ status, canEdit: admin.role === "SUPER_ADMIN", adminEmail: admin.email }, { headers: noStore });
}

// ─── Action: save / rotate / revoke (SUPER_ADMIN only) ──────────────────────

export async function action({ request }: ActionFunctionArgs) {
  const reply = (data: ProviderCredentialActionData, status = 200) => json(data, { status, headers: noStore });

  assertSameOrigin(request);
  const admin = await requireAdmin(request, "SUPER_ADMIN");

  const parsed = providerCredentialMutationSchema.safeParse(Object.fromEntries(await request.formData()));
  if (!parsed.success) {
    const fieldErrors: { field?: string[]; value?: string[] } = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (key === "field" || key === "value") (fieldErrors[key] ??= []).push(issue.message);
    }
    return reply({ ok: false, formError: "Invalid request", fieldErrors }, 422);
  }

  const m = parsed.data;
  const actor = { actorId: admin.id, ...getRequestContext(request) };

  try {
    if (m.intent === "save") {
      const r = await saveProviderCredential({ provider: m.provider, field: m.field, value: m.value, ...actor });
      return reply({ ok: true, intent: "save", provider: m.provider, field: m.field, ...r });
    }

    const revoked = await revokeProviderCredential({ provider: m.provider, field: m.field, ...actor });
    if (!revoked) return reply({ ok: false, formError: "Nothing to revoke: this field is not set." }, 404);
    return reply({ ok: true, intent: "revoke", provider: m.provider, field: m.field });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return reply({ ok: false, formError: "Another admin changed this key at the same moment. Reload and try again." }, 409);
    }
    // Log the error name only: Prisma validation errors can echo query arguments.
    console.error("[admin.providers] mutation failed", {
      provider: m.provider,
      field: m.field,
      error: err instanceof Error ? err.name : "unknown",
    });
    return reply({ ok: false, formError: "Failed to store credential." }, 500);
  }
}

// ─── UI ─────────────────────────────────────────────────────────────────────

export default function AdminProvidersRoute() {
  const { status, canEdit, adminEmail } = useLoaderData<typeof loader>();

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <header className="mb-8">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-zinc-500">Admin / Providers</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-50">Provider credentials</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400">
          Keys are encrypted with AES-256-GCM before they reach the database, and are decrypted only inside server-side
          API calls. Values are never sent back to the browser. You see a version and an HMAC fingerprint instead.
          Rotating destroys the previous ciphertext.
        </p>
        {!canEdit && (
          <p className="mt-4 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-300/90">
            Signed in as {adminEmail}: read-only. Only super admins can change credentials.
          </p>
        )}
      </header>

      <div className="space-y-6">
        {PROVIDERS.map((p) => (
          <ProviderCredentialCard key={p} provider={p} fields={status[p]} canEdit={canEdit} />
        ))}
      </div>
    </main>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : "Something went wrong.";
  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <p className="font-mono text-sm text-zinc-400">{message}</p>
    </main>
  );
}
