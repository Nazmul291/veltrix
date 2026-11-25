import { NavLink } from "@remix-run/react";
import { useLogout } from "~/hooks/useAuth";

const navCls = ({ isActive }: { isActive: boolean }) =>
  `text-sm transition ${isActive ? "text-zinc-100" : "text-zinc-500 hover:text-zinc-200"}`;

export function AppHeader({ email, isAdmin }: { email: string; isAdmin: boolean }) {
  const { logout, isLoggingOut } = useLogout();
  return (
    <header className="border-b border-zinc-800/80">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
        <nav className="flex items-center gap-6">
          <NavLink to="/" className="font-mono text-sm font-semibold tracking-[0.18em] text-zinc-100">
            VELTRIX
          </NavLink>
          <NavLink to="/" end className={navCls}>
            Resources
          </NavLink>
          <NavLink to="/billing" className={navCls}>
            Billing
          </NavLink>
          {isAdmin && (
            <NavLink to="/admin/providers" className={navCls}>
              Admin
            </NavLink>
          )}
        </nav>
        <div className="flex items-center gap-4">
          <span className="hidden text-sm text-zinc-500 sm:inline">{email}</span>
          <button onClick={logout} disabled={isLoggingOut} className="text-sm text-zinc-400 hover:text-zinc-100 disabled:opacity-50">
            {isLoggingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </div>
    </header>
  );
}
