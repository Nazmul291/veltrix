/**
 * GET /auth/login?returnTo=/path
 * Starts SSO: a fresh random state and a cleaned returnTo go into the signed
 * session cookie, then the browser goes to NazmulCodes Auth's /authorize.
 */
import { redirect, type LoaderFunctionArgs } from "@remix-run/node";
import { safeRedirect } from "~/lib/safe-redirect";
import { CentralAuthError, buildAuthorizationUrl, newState } from "~/services/central-auth.server";
import { commitSession, getSession } from "~/services/session.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const returnTo = safeRedirect(new URL(request.url).searchParams.get("returnTo"));
  const session = await getSession(request);
  const state = newState();

  let authorizeUrl: string;
  try {
    authorizeUrl = await buildAuthorizationUrl(state);
  } catch (err) {
    if (err instanceof CentralAuthError) return redirect("/login?error=unavailable"); // details already logged
    throw err;
  }

  session.set("oauthState", state);
  session.set("returnTo", returnTo);
  return redirect(authorizeUrl, {
    headers: { "Set-Cookie": await commitSession(session), "Cache-Control": "no-store" },
  });
}
