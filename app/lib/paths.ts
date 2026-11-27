/**
 * URL layout.
 *
 *   Public:     /  (marketing), /login, /auth/*, /webhooks/*, /api/cron/* (its own secret)
 *   Customer:   /dashboard, /dashboard/billing, … (sign-in required)
 *   Admin:      /admin/* (an admin role required)
 *
 * Every protected route checks access in its own loader/action. A parent
 * layout's check isn't enough in Remix, because a child route's data can be
 * requested directly. tests/routes.guard.test.ts enforces this.
 */
export const PATHS = {
  home: "/",
  login: "/login",
  dashboard: "/dashboard",
  billing: "/dashboard/billing",
  adminProviders: "/admin/providers",
} as const;

/** Where a sign-in lands when nothing else was asked for. */
export const AFTER_SIGN_IN = PATHS.dashboard;

/** A sign-in link that comes back to `returnTo` afterwards. */
export function signInHref(returnTo: string = AFTER_SIGN_IN) {
  return `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}
