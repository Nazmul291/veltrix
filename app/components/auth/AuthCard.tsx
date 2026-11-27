import type { ReactNode } from "react";

export function AuthCard({ title, subtitle, children, footer }: { title: string; subtitle: string; children: ReactNode; footer: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-5 py-10 sm:px-6">
      <div className="w-full max-w-sm">
        <a href="/" className="font-mono text-xs uppercase tracking-[0.2em] text-zinc-500 hover:text-zinc-300">
          ← Veltrix
        </a>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-50">{title}</h1>
        <p className="mt-1 text-sm text-zinc-400">{subtitle}</p>
        <div className="mt-8 rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-5 sm:p-6">{children}</div>
        <p className="mt-6 text-center text-sm text-zinc-500">{footer}</p>
      </div>
    </main>
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
