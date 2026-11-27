/**
 * Sign-in is a full-page redirect to NazmulCodes Auth (see /login and
 * /auth/login), so the only auth mutation left in the client is logout. It goes
 * through useFetcher like every other mutation. The action's redirect to /login
 * becomes a navigation.
 */
import { useFetcher } from "@remix-run/react";
import { useCallback } from "react";

export function useLogout() {
  const fetcher = useFetcher();
  const submitFetcher = fetcher.submit;
  const logout = useCallback(() => submitFetcher(null, { method: "post", action: "/logout" }), [submitFetcher]);
  return { logout, isLoggingOut: fetcher.state !== "idle" };
}
