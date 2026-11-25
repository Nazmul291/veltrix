import { json, redirect, type ActionFunctionArgs, type LoaderFunctionArgs, type MetaFunction } from "@remix-run/node";
import { Link } from "@remix-run/react";
import { AuthCard, AuthField, AuthSubmit, FormError } from "~/components/auth/AuthCard";
import { useSignup } from "~/hooks/useAuth";
import { signupSchema, type AuthActionData } from "~/lib/schemas/auth";
import { getRequestContext } from "~/services/audit.server";
import { registerUser } from "~/services/auth.server";
import { rateLimit } from "~/services/rate-limit.server";
import { assertSameOrigin, createUserSession, getUserId } from "~/services/session.server";

export const meta: MetaFunction = () => [{ title: "Create account · Veltrix" }];

export async function loader({ request }: LoaderFunctionArgs) {
  if (await getUserId(request)) throw redirect("/");
  return null;
}

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const reply = (data: AuthActionData, status: number) => json(data, { status });

  const ctx = getRequestContext(request);
  const limit = rateLimit(`signup:ip:${ctx.ipAddress ?? "unknown"}`, 5, 60 * 60_000);
  if (!limit.allowed) return reply({ ok: false, formError: "Too many sign-ups from this network. Try again later." }, 429);

  const parsed = signupSchema.safeParse(Object.fromEntries(await request.formData()));
  if (!parsed.success) return reply({ ok: false, fieldErrors: parsed.error.flatten().fieldErrors }, 422);

  const result = await registerUser(parsed.data, ctx);
  if (!result.ok) {
    // Saying "already registered" reveals that the address has an account. That's
    // accepted here because most SaaS products do it and it keeps signup usable.
    // Switch to email verification if enumeration matters more.
    return reply({ ok: false, fieldErrors: { email: ["An account with this email already exists"] } }, 409);
  }
  return createUserSession(result.userId, "/");
}

export default function SignupRoute() {
  const { signup, isSubmitting, fieldErrors, formError } = useSignup();

  return (
    <AuthCard
      title="Create your account"
      subtitle="Free plan: 1 app, 1 Postgres, 1 Redis."
      footer={
        <>
          Already have an account?{" "}
          <Link to="/login" className="text-zinc-300 underline-offset-4 hover:underline">
            Sign in
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
          signup({
            name: String(fd.get("name") ?? ""),
            email: String(fd.get("email") ?? ""),
            password: String(fd.get("password") ?? ""),
          });
        }}
      >
        <FormError message={formError} />
        <AuthField label="Name" name="name" autoComplete="name" errors={fieldErrors?.name} />
        <AuthField label="Email" name="email" type="email" autoComplete="email" errors={fieldErrors?.email} />
        <AuthField
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          errors={fieldErrors?.password}
          hint="At least 12 characters."
        />
        <AuthSubmit busy={isSubmitting}>{isSubmitting ? "Creating account…" : "Create account"}</AuthSubmit>
      </form>
    </AuthCard>
  );
}
