/**
 * Auth mutations go through useFetcher, like every other mutation. When an
 * action returns a redirect (a successful login, signup or logout), Remix
 * follows it as a navigation, and the browser stores the Set-Cookie header.
 */
import { useFetcher } from "@remix-run/react";
import { useCallback, useState } from "react";
import type { ZodSchema } from "zod";
import {
  loginSchema,
  signupSchema,
  type AuthActionData,
  type AuthFieldErrors,
  type LoginInput,
  type SignupInput,
} from "~/lib/schemas/auth";

function useAuthMutation<T extends Record<string, unknown>>(action: string, schema: ZodSchema) {
  const fetcher = useFetcher<AuthActionData>();
  const [clientErrors, setClientErrors] = useState<AuthFieldErrors | null>(null);

  const submit = useCallback(
    (input: T) => {
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        setClientErrors(parsed.error.flatten().fieldErrors as AuthFieldErrors);
        return;
      }
      setClientErrors(null);
      // Submit the raw input. The server normalises it again, and the client must not be trusted to have done so.
      const body = Object.fromEntries(Object.entries(input).filter(([, v]) => typeof v === "string")) as Record<string, string>;
      fetcher.submit(body, { method: "post", action });
    },
    [fetcher.submit, schema, action],
  );

  const server = fetcher.data && !fetcher.data.ok ? fetcher.data : null;
  return {
    submit,
    isSubmitting: fetcher.state !== "idle",
    fieldErrors: clientErrors ?? server?.fieldErrors ?? null,
    formError: clientErrors ? null : (server?.formError ?? null),
  };
}

export function useLogin() {
  const { submit, ...rest } = useAuthMutation<LoginInput>("/login", loginSchema);
  return { login: submit, ...rest };
}

export function useSignup() {
  const { submit, ...rest } = useAuthMutation<SignupInput>("/signup", signupSchema);
  return { signup: submit, ...rest };
}

export function useLogout() {
  const fetcher = useFetcher();
  const logout = useCallback(() => fetcher.submit(null, { method: "post", action: "/logout" }), [fetcher.submit]);
  return { logout, isLoggingOut: fetcher.state !== "idle" };
}
