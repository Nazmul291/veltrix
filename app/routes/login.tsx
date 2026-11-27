import { json, redirect, type LoaderFunctionArgs, type MetaFunction } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { AuthCard, FormError } from "~/components/auth/AuthCard";
import { safeRedirect } from "~/lib/safe-redirect";
import { getUserId } from "~/services/session.server";

export const meta: MetaFunction = () => [{ title: "Sign in · Veltrix" }];

/** Friendly copy only. Details stay in the server log. */
const ERRORS: Record<string, string> = {
  unavailable: "Sign-in is temporarily unavailable. Please try again in a few minutes.",
  state: "That sign-in link expired or was opened in another tab. Please try again.",
  expired: "That sign-in attempt expired. Please try again.",
  denied: "Your NazmulCodes account can't access Veltrix right now. Contact support if this seems wrong.",
  signed_out: "You've been signed out because your account access changed. Sign in again to continue.",
};

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const returnTo = safeRedirect(url.searchParams.get("returnTo"));
  if (await getUserId(request)) throw redirect(returnTo);
  const error = url.searchParams.get("error");
  return json({ returnTo, error: error && ERRORS[error] ? ERRORS[error] : null }, { headers: { "Cache-Control": "no-store" } });
}

export default function LoginRoute() {
  const { returnTo, error } = useLoaderData<typeof loader>();
  const href = `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;

  return (
    <AuthCard
      title="Sign in"
      subtitle="Deploy apps, databases and workers."
      footer="Veltrix uses your NazmulCodes account. New here? You can create one on the next screen."
    >
      <div className="space-y-4">
        <FormError message={error} />
        {/* A plain link: /auth/login answers with a redirect to another site, so it needs a full page navigation. */}
        <a
          href={href}
          className="flex h-11 w-full items-center justify-center gap-2.5 rounded-md bg-zinc-100 text-sm font-medium text-zinc-950 transition hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
        >
          <span aria-hidden className="grid h-5 w-5 place-items-center rounded bg-zinc-950 font-mono text-[11px] font-bold text-zinc-100">
            N
          </span>
          Sign in with NazmulCodes
        </a>
        <p className="text-center text-xs text-zinc-500">
          Your password and two-factor codes stay with NazmulCodes. Veltrix never sees them.
        </p>
      </div>
    </AuthCard>
  );
}
