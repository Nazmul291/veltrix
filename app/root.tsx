import type { LinksFunction } from "@remix-run/node";
import { Links, Meta, Outlet, Scripts, ScrollRestoration, isRouteErrorResponse, useRouteError } from "@remix-run/react";
import styles from "./tailwind.css?url";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: styles }];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body className="min-h-screen bg-zinc-950 font-sans text-zinc-100 antialiased">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

/** Friendly fallback for anything a route didn't handle. Raw errors never reach the page. */
export function ErrorBoundary() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const message =
    status === 404
      ? "This page doesn't exist."
      : status === 503
        ? "Sign-in service is temporarily unavailable. Please try again in a moment."
        : "Something went wrong on our side. Please try again.";
  if (status >= 500) console.error("[root] unhandled error", isRouteErrorResponse(error) ? error.status : error);

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="max-w-sm text-center">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-zinc-500">Veltrix · {status}</p>
        <p className="mt-3 text-sm text-zinc-300">{message}</p>
        <a href="/" className="mt-6 inline-block text-sm text-zinc-400 underline-offset-4 hover:text-zinc-100 hover:underline">
          Back to Veltrix
        </a>
      </div>
    </main>
  );
}
