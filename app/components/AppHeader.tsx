import { NavLink } from "@remix-run/react";
import { useLogout } from "~/hooks/useAuth";
import { PATHS } from "~/lib/paths";

const navCls = ({ isActive }: { isActive: boolean }) =>
  `text-sm transition ${isActive ? "text-zinc-100" : "text-zinc-500 hover:text-zinc-200"}`;

/** Header for the signed-in areas (/dashboard/*, /admin/*). */
export function AppHeader({ email, isAdmin }: { email: string; isAdmin: boolean }) {
  const { logout, isLoggingOut } = useLogout();
  return (
    <header className="border-b border-zinc-800/80">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-6">
        <nav className="flex min-w-0 items-center gap-5 sm:gap-6">
          <NavLink to={PATHS.dashboard} end className="font-mono text-sm font-semibold tracking-[0.18em] text-zinc-100">
            VELTRIX
          </NavLink>
          <NavLink to={PATHS.dashboard} end className={navCls}>
            Resources
          </NavLink>
          <NavLink to={PATHS.billing} className={navCls}>
            Billing
          </NavLink>
          {isAdmin && (
            <NavLink to={PATHS.adminProviders} className={navCls}>
              Admin
            </NavLink>
          )}
        </nav>
        <div className="flex shrink-0 items-center gap-4">
          <span className="hidden text-sm text-zinc-500 md:inline">{email}</span>
          <button onClick={logout} disabled={isLoggingOut} className="text-sm text-zinc-400 hover:text-zinc-100 disabled:opacity-50">
            {isLoggingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </div>
    </header>
  );
}
