/**
 * Layout for the admin area (/admin/*): the app header plus the page.
 * Non-admins get a 404 (requireAdmin). Each child route still checks its own access.
 */
import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { Outlet, useLoaderData } from "@remix-run/react";
import { AppHeader } from "~/components/AppHeader";
import { requireAdmin } from "~/services/session.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const admin = await requireAdmin(request, "SUPPORT");
  return json({ email: admin.email }, { headers: { "Cache-Control": "no-store, private" } });
}

export default function AdminLayout() {
  const { email } = useLoaderData<typeof loader>();
  return (
    <div className="min-h-screen">
      <AppHeader email={email} isAdmin />
      <Outlet />
    </div>
  );
}
