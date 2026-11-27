import { redirect, type LoaderFunctionArgs } from "@remix-run/node";
import { PATHS } from "~/lib/paths";
import { requireAdmin } from "~/services/session.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireAdmin(request, "SUPPORT");
  return redirect(PATHS.adminProviders);
}
