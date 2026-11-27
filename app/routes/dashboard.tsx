/**
 * Layout for the customer area (/dashboard/*): the app header plus the page.
 * Each child route still calls requireUser itself (see app/lib/paths.ts).
 */
import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { Outlet, useLoaderData } from "@remix-run/react";
import { AppHeader } from "~/components/AppHeader";
import { requireUser } from "~/services/session.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireUser(request);
  const role = user.adminRole?.role;
  return json(
    { email: user.email, isAdmin: role === "ADMIN" || role === "SUPER_ADMIN" },
    { headers: { "Cache-Control": "no-store, private" } },
  );
}

export default function DashboardLayout() {
  const { email, isAdmin } = useLoaderData<typeof loader>();
  return (
    <div className="min-h-screen">
      <AppHeader email={email} isAdmin={isAdmin} />
      <Outlet />
    </div>
  );
}
