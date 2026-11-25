import { json, redirect, type ActionFunctionArgs, type LoaderFunctionArgs, type MetaFunction } from "@remix-run/node";
import { Link, useSearchParams } from "@remix-run/react";
import { AuthCard, AuthField, AuthSubmit, FormError } from "~/components/auth/AuthCard";
import { useLogin } from "~/hooks/useAuth";
import { loginSchema, safeRedirect, type AuthActionData } from "~/lib/schemas/auth";
import { getRequestContext } from "~/services/audit.server";
import { authenticate } from "~/services/auth.server";
import { clearRateLimit, rateLimit } from "~/services/rate-limit.server";
import { assertSameOrigin, createUserSession, getUserId } from "~/services/session.server";

export const meta: MetaFunction = () => [{ title: "Sign in · Veltrix" }];

export async function loader({ request }: LoaderFunctionArgs) {
  if (await getUserId(request)) throw redirect(safeRedirect(new URL(request.url).searchParams.get("redirectTo")));
  return null;
}

const GENERIC = "Incorrect email or password.";

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const reply = (data: AuthActionData, status: number) => json(data, { status });

  const parsed = loginSchema.safeParse(Object.fromEntries(await request.formData()));
  if (!parsed.success) return reply({ ok: false, fieldErrors: parsed.error.flatten().fieldErrors }, 422);

  const { email, password, redirectTo } = parsed.data;
  const ctx = getRequestContext(request);

  // Two limits: one per IP (spraying many accounts) and one per email (brute-forcing one account).
  const ipLimit = rateLimit(`login:ip:${ctx.ipAddress ?? "unknown"}`, 20, 15 * 60_000);
  const emailLimit = rateLimit(`login:email:${email}`, 8, 15 * 60_000);
  if (!ipLimit.allowed || !emailLimit.allowed) {
    const wait = Math.max(ipLimit.retryAfterSec, emailLimit.retryAfterSec);
    return json<AuthActionData>(
      { ok: false, formError: `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.` },
      { status: 429, headers: { "Retry-After": String(wait) } },
    );
  }

  const result = await authenticate(email, password, ctx);
  if (!result.ok) return reply({ ok: false, formError: GENERIC }, 401);

  clearRateLimit(`login:email:${email}`);
  return createUserSession(result.userId, safeRedirect(redirectTo));
}

export default function LoginRoute() {
  const [params] = useSearchParams();
  const { login, isSubmitting, fieldErrors, formError } = useLogin();

  return (
    <AuthCard
      title="Sign in"
      subtitle="Deploy apps, databases and workers."
      footer={
        <>
          No account?{" "}
          <Link to="/signup" className="text-zinc-300 underline-offset-4 hover:underline">
            Create one
          </Link>
        </>
      }
    >
      <form
        className="space-y-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          login({
            email: String(fd.get("email") ?? ""),
            password: String(fd.get("password") ?? ""),
            redirectTo: params.get("redirectTo") ?? undefined,
          });
        }}
      >
        <FormError message={formError} />
        <AuthField label="Email" name="email" type="email" autoComplete="email" errors={fieldErrors?.email} />
        <AuthField label="Password" name="password" type="password" autoComplete="current-password" errors={fieldErrors?.password} />
        <AuthSubmit busy={isSubmitting}>{isSubmitting ? "Signing in…" : "Sign in"}</AuthSubmit>
      </form>
    </AuthCard>
  );
}
