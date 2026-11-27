/**
 * GET /auth/callback?code=…&state=…
 * Must exactly match the callback URL registered for Veltrix in the auth admin.
 *
 * 1. state must equal the one in the session. It's cleared either way (single use).
 * 2. The code is exchanged at once (single-use, valid for 60s).
 * 3. The local user is upserted by centralUserId, and a fresh session starts.
 * A reused callback URL (reload or back button) or invalid_grant restarts login
 * once, then shows an error.
 */
import { redirect, type LoaderFunctionArgs } from "@remix-run/node";
import { safeRedirect } from "~/lib/safe-redirect";
import { getRequestContext } from "~/services/audit.server";
import { upsertCentralUser } from "~/services/auth.server";
import { CentralAuthError, exchangeCode } from "~/services/central-auth.server";
import { safeEqual } from "~/services/crypto.server";
import { commitSession, createUserSession, getSession, getUserId } from "~/services/session.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const session = await getSession(request);
  const expected = session.get("oauthState");
  const returnTo = safeRedirect(session.get("returnTo"));
  session.unset("oauthState");
  session.unset("returnTo");

  const toLogin = async (error: "state" | "expired" | "denied" | "unavailable") =>
    redirect(`/login?error=${error}`, { headers: { "Set-Cookie": await commitSession(session), "Cache-Control": "no-store" } });

  /** Starts a fresh login once. A second failure in a row shows an error, so it can never loop. */
  const restartOnce = async () => {
    if (session.get("oauthRetried")) {
      session.unset("oauthRetried");
      return toLogin("expired");
    }
    session.set("oauthRetried", true);
    return redirect(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`, {
      headers: { "Set-Cookie": await commitSession(session), "Cache-Control": "no-store" },
    });
  };

  if (!state) return toLogin("state");

  if (typeof expected !== "string") {
    // No login is pending: the exact callback URL was reused (back button or reload).
    if (await getUserId(request)) return redirect("/"); // already signed in: no second exchange
    // No cookie at all means cookies are blocked. Restarting would loop forever.
    if (!request.headers.get("Cookie")?.includes("__vx_session=")) return toLogin("state");
    return restartOnce();
  }
  // A pending login with a different state: tampered or crossed with another tab. Rejected.
  if (!safeEqual(state, expected)) return toLogin("state");
  if (!code) return toLogin("expired");

  try {
    const central = await exchangeCode(code);
    const user = await upsertCentralUser(central, getRequestContext(request));
    return createUserSession({ userId: user.id, centralUserId: central.id, redirectTo: returnTo });
  } catch (err) {
    if (!(err instanceof CentralAuthError)) throw err;
    if (err.reason === "invalid_grant") return restartOnce();
    if (err.reason === "access_denied") return toLogin("denied");
    return toLogin("unavailable");
  }
}
