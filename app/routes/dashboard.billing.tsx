import { json, type ActionFunctionArgs, type LoaderFunctionArgs, type MetaFunction } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { CurrentPlanCard, PlanCards } from "~/components/billing/PlanCards";
import { useBilling } from "~/hooks/useBilling";
import { billingMutationSchema, type BillingActionData } from "~/lib/schemas/billing";
import { getRequestContext } from "~/services/audit.server";
import {
  BillingError,
  changePlan,
  getBillingState,
  getPaddleClientConfig,
  getPortalUrl,
  resumeSubscription,
  startCheckout,
} from "~/services/billing.server";
import { ProviderNotConfiguredError } from "~/services/credentials.server";
import { ProviderApiError } from "~/services/http.server";
import { assertSameOrigin, requireUser } from "~/services/session.server";

export const meta: MetaFunction = () => [{ title: "Billing · Veltrix" }];

const noStore = { "Cache-Control": "no-store, private" };

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireUser(request);
  const [{ subscription }, paddle] = await Promise.all([getBillingState(user.id), getPaddleClientConfig()]);
  return json(
    {
      user: { plan: user.plan },
      subscription,
      // Only the public client token and environment. The API key and webhook secret never leave the server.
      paddle,
    },
    { headers: noStore },
  );
}

export async function action({ request }: ActionFunctionArgs) {
  const reply = (data: BillingActionData, status = 200) => json(data, { status, headers: noStore });

  assertSameOrigin(request);
  const user = await requireUser(request, { fresh: true });
  const parsed = billingMutationSchema.safeParse(Object.fromEntries(await request.formData()));
  if (!parsed.success) return reply({ ok: false, error: "Invalid request" }, 422);

  const actor = { id: user.id, email: user.email, paddleCustomerId: user.paddleCustomerId, context: getRequestContext(request) };
  const m = parsed.data;

  try {
    switch (m.intent) {
      case "checkout":
        return reply({ ok: true, intent: "checkout", transactionId: await startCheckout(actor, m.plan) });
      case "change_plan":
        await changePlan(actor, m.plan);
        return reply({ ok: true, intent: "change_plan" });
      case "resume":
        await resumeSubscription(actor);
        return reply({ ok: true, intent: "resume" });
      case "portal":
        return reply({ ok: true, intent: "portal", url: await getPortalUrl(actor) });
    }
  } catch (err) {
    if (err instanceof BillingError) return reply({ ok: false, error: err.message }, 409);
    if (err instanceof ProviderNotConfiguredError) return reply({ ok: false, error: "Billing isn't available right now." }, 503);
    console.error("[billing] action failed", { userId: user.id, intent: m.intent, error: err instanceof Error ? `${err.name}: ${err.message}` : err });
    const upstream = err instanceof ProviderApiError;
    return reply({ ok: false, error: upstream ? "Our payment provider didn't respond. Please try again." : "Something went wrong." }, 502);
  }
}

export default function BillingRoute() {
  const { user, subscription, paddle } = useLoaderData<typeof loader>();
  const billing = useBilling(paddle, user.plan);

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">Billing</h1>
        <p className="mt-1 text-sm text-zinc-400">Plans set your resource limits and monthly budget. Payments are handled by Paddle.</p>
      </div>

      {!paddle && (
        <p className="rounded-md border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-300">
          Billing isn't configured yet. An admin needs to add the Paddle keys in Admin → Providers.
        </p>
      )}
      {billing.activating && (
        <p role="status" className="rounded-md border border-sky-500/20 bg-sky-500/5 px-4 py-3 text-sm text-sky-300">
          Payment received. Activating your plan…
        </p>
      )}
      {billing.error && (
        <p role="alert" className="rounded-md border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-300">
          {billing.error}
        </p>
      )}

      <CurrentPlanCard plan={user.plan} subscription={subscription} billing={billing} />
      <PlanCards plan={user.plan} subscription={subscription} enabled={Boolean(paddle)} billing={billing} />
    </main>
  );
}
