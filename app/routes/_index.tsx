import { json, type LoaderFunctionArgs, type MetaFunction } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { useMemo } from "react";
import { AppHeader } from "~/components/AppHeader";
import { CreateResourcePanel } from "~/components/dashboard/CreateResourcePanel";
import { QuotaPanel } from "~/components/dashboard/QuotaPanel";
import { ResourceList } from "~/components/dashboard/ResourceList";
import { useResourceStatusPolling } from "~/hooks/useResourceActions";
import { listTenantResources } from "~/services/resources.server";
import { requireUser } from "~/services/session.server";
import { ResourceStoreProvider, type ResourceStoreInit } from "~/store/useResourceStore";

export const meta: MetaFunction = () => [{ title: "Dashboard · Veltrix" }];

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireUser(request);
  const store: ResourceStoreInit = { plan: user.plan, resources: await listTenantResources(user.id) };
  return json(
    { user: { email: user.email, adminRole: user.adminRole?.role ?? null }, store },
    { headers: { "Cache-Control": "no-store, private" } },
  );
}

export default function Dashboard() {
  const { user, store } = useLoaderData<typeof loader>();
  // Revalidation gives a new object, which makes the provider re-hydrate the store with fresh server data.
  const initial = useMemo(() => store as ResourceStoreInit, [store]);

  return (
    <ResourceStoreProvider initial={initial}>
      <DashboardView email={user.email} isAdmin={user.adminRole === "ADMIN" || user.adminRole === "SUPER_ADMIN"} />
    </ResourceStoreProvider>
  );
}

function DashboardView({ email, isAdmin }: { email: string; isAdmin: boolean }) {
  useResourceStatusPolling();

  return (
    <div className="min-h-screen">
      <AppHeader email={email} isAdmin={isAdmin} />
      <main className="mx-auto grid max-w-6xl gap-6 px-6 py-8 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-6">
          <QuotaPanel />
          <ResourceList />
        </div>
        <aside className="lg:sticky lg:top-8 lg:self-start">
          <CreateResourcePanel />
        </aside>
      </main>
    </div>
  );
}
