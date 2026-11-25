import type { ReactNode } from "react";

export function AuthCard({ title, subtitle, children, footer }: { title: string; subtitle: string; children: ReactNode; footer: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-zinc-500">Veltrix</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-50">{title}</h1>
        <p className="mt-1 text-sm text-zinc-400">{subtitle}</p>
        <div className="mt-8 rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-6">{children}</div>
        <p className="mt-6 text-center text-sm text-zinc-500">{footer}</p>
      </div>
    </main>
  );
}

interface FieldProps {
  label: string;
  name: string;
  type?: string;
  autoComplete?: string;
  errors?: string[] | null;
  hint?: string;
}

export function AuthField({ label, name, type = "text", autoComplete, errors, hint }: FieldProps) {
  const id = `auth-${name}`;
  const errId = `${id}-error`;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-zinc-300">
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        autoComplete={autoComplete}
        aria-invalid={errors?.length ? true : undefined}
        aria-describedby={errors?.length ? errId : undefined}
        className="h-10 w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 aria-invalid:border-red-500/60"
      />
      {errors?.length ? (
        <p id={errId} className="text-xs text-red-400">
          {errors[0]}
        </p>
      ) : hint ? (
        <p className="text-xs text-zinc-500">{hint}</p>
      ) : null}
    </div>
  );
}

export function AuthSubmit({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="h-10 w-full rounded-md bg-zinc-100 text-sm font-medium text-zinc-950 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-300">
      {message}
    </p>
  );
}
