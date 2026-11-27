/** The billing page moved to /dashboard/billing. This permanent redirect keeps old links and bookmarks working. */
import { redirect, type LoaderFunctionArgs } from "@remix-run/node";
import { PATHS } from "~/lib/paths";

export function loader({ request }: LoaderFunctionArgs) {
  return redirect(PATHS.billing + new URL(request.url).search, 301);
}
