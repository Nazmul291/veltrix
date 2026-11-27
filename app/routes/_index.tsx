/**
 * Public marketing homepage. No sign-in required, no redirect into SSO.
 * The loader only reads the session cookie (no DB) to pick the right call to action.
 */
import { json, type LoaderFunctionArgs, type MetaFunction } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import { TYPE_META } from "~/components/dashboard/ui";
import { PATHS, signInHref } from "~/lib/paths";
import { PLAN_LIMITS, PLAN_PRICE_CENTS, PLANS, RESOURCE_TYPES, type PlanId } from "~/lib/plans";
import { formatCents } from "~/lib/quota";
import { getUserId } from "~/services/session.server";

export const meta: MetaFunction = () => [
  { title: "Veltrix · Deploy apps, Postgres, Redis and workers" },
  {
    name: "description",
    content:
      "Veltrix runs your apps and background workers on Fly.io, Postgres on Neon and Redis on Upstash, from one dashboard with clear limits and one monthly bill.",
  },
];

export async function loader({ request }: LoaderFunctionArgs) {
  return json({ signedIn: Boolean(await getUserId(request)) }, { headers: { "Cache-Control": "private, no-cache" } });
}

const FEATURES = [
  { type: "APP", title: "Apps", body: "Containers on Fly.io Machines, with HTTPS and scale-to-zero. Bring an image or start from hello-world." },
  { type: "WORKER", title: "Workers", body: "Background processes on Fly.io with no public port, for queues, schedulers and jobs." },
  { type: "POSTGRES", title: "Postgres", body: "Serverless Postgres on Neon with autoscaling compute. One project per database, nothing shared." },
  { type: "REDIS", title: "Redis", body: "Global Redis on Upstash with TLS always on. Copy the connection string and go." },
] as const;

const TRUST = [
  { title: "Keys stay encrypted", body: "Provider credentials and connection strings are encrypted with AES-256-GCM and only decrypted on the server." },
  { title: "Isolated by default", body: "Every account's apps run on their own private network, so other tenants can't reach them." },
  { title: "One sign-in", body: "Sign in with your NazmulCodes account. Passwords and 2FA codes never touch Veltrix." },
  { title: "Know the cost first", body: "See the monthly price and your plan's limits before you create anything." },
];

const STEPS = [
  { n: "01", title: "Sign in", body: "Use your NazmulCodes account. New? Create one on the next screen." },
  { n: "02", title: "Pick a resource", body: "App, worker, Postgres or Redis. Choose a region and size with the price shown." },
  { n: "03", title: "Ship", body: "Veltrix provisions it and hands you the URL or connection string." },
];

export default function Home() {
  const { signedIn } = useLoaderData<typeof loader>();
  const primary = signedIn
    ? { href: PATHS.dashboard, label: "Open dashboard" }
    : { href: signInHref(), label: "Start free" };

  return (
    <div className="min-h-screen">
      <SiteHeader signedIn={signedIn} />

      <main>
        {/* Hero */}
        <section className="mx-auto grid max-w-6xl items-center gap-12 px-5 pb-16 pt-14 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:pb-24 lg:pt-20">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-emerald-400/90">Developer cloud</p>
            <h1 className="mt-4 text-4xl font-semibold leading-[1.1] tracking-tight text-zinc-50 sm:text-5xl">
              Apps, Postgres, Redis and workers. One dashboard.
            </h1>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-zinc-400 sm:text-lg">
              Veltrix provisions on Fly.io, Neon and Upstash for you, with clear limits and one monthly bill. No provider accounts to juggle.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <CtaLink href={primary.href} primary>
                {primary.label}
              </CtaLink>
              <CtaLink href="#pricing">See pricing</CtaLink>
            </div>
            <p className="mt-5 font-mono text-xs text-zinc-500">
              Free plan: {PLAN_LIMITS.FREE.maxResources.APP} app · {PLAN_LIMITS.FREE.maxResources.POSTGRES} Postgres ·{" "}
              {PLAN_LIMITS.FREE.maxResources.REDIS} Redis
            </p>
          </div>
          <ProductPreview />
        </section>

        {/* Features */}
        <section id="features" className="border-t border-zinc-800/80">
          <div className="mx-auto max-w-6xl px-5 py-16 sm:px-6 lg:py-20">
            <SectionTitle eyebrow="What you get" title="Four building blocks, one place to manage them" />
            <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {FEATURES.map((f) => (
                <article key={f.type} className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-5">
                  <span className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-zinc-400">
                    {TYPE_META[f.type].provider}
                  </span>
                  <h3 className="mt-4 text-base font-semibold text-zinc-100">{f.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-zinc-400">{f.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* How it works */}
        <section className="border-t border-zinc-800/80">
          <div className="mx-auto max-w-6xl px-5 py-16 sm:px-6 lg:py-20">
            <SectionTitle eyebrow="How it works" title="From sign-in to running in three steps" />
            <ol className="mt-10 grid gap-6 md:grid-cols-3">
              {STEPS.map((s) => (
                <li key={s.n} className="border-l border-zinc-800 pl-5">
                  <span className="font-mono text-xs text-emerald-400/90">{s.n}</span>
                  <h3 className="mt-2 text-base font-semibold text-zinc-100">{s.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">{s.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Trust */}
        <section className="border-t border-zinc-800/80 bg-zinc-900/20">
          <div className="mx-auto grid max-w-6xl gap-8 px-5 py-14 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
            {TRUST.map((t) => (
              <div key={t.title}>
                <h3 className="text-sm font-semibold text-zinc-100">{t.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">{t.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Pricing */}
        <section id="pricing" className="border-t border-zinc-800/80">
          <div className="mx-auto max-w-6xl px-5 py-16 sm:px-6 lg:py-20">
            <SectionTitle eyebrow="Pricing" title="Pick a plan. Change it any time." />
            <div className="mt-10 grid gap-4 md:grid-cols-3">
              {PLANS.map((p) => (
                <PlanCard key={p} plan={p} signedIn={signedIn} />
              ))}
            </div>
            <p className="mt-6 text-xs text-zinc-500">
              Resource prices are added to your plan and capped by its monthly usage budget. Payments are handled by Paddle.
            </p>
          </div>
        </section>

        {/* Final CTA */}
        <section className="border-t border-zinc-800/80">
          <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 px-5 py-14 sm:px-6 md:flex-row md:items-center">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight text-zinc-50">Ready to ship?</h2>
              <p className="mt-1 text-sm text-zinc-400">Start on the free plan. No card needed.</p>
            </div>
            <CtaLink href={primary.href} primary>
              {primary.label}
            </CtaLink>
          </div>
        </section>
      </main>

      <footer className="border-t border-zinc-800/80">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-5 py-8 text-xs text-zinc-500 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <span className="font-mono tracking-[0.18em]">VELTRIX</span>
          <nav className="flex gap-5">
            <a href="#features" className="hover:text-zinc-300">Features</a>
            <a href="#pricing" className="hover:text-zinc-300">Pricing</a>
            <a href={signedIn ? PATHS.dashboard : signInHref()} className="hover:text-zinc-300">
              {signedIn ? "Dashboard" : "Sign in"}
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}

function SiteHeader({ signedIn }: { signedIn: boolean }) {
  return (
    <header className="sticky top-0 z-10 border-b border-zinc-800/80 bg-zinc-950/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-5 sm:px-6">
        <div className="flex items-center gap-6">
          <Link to="/" className="font-mono text-sm font-semibold tracking-[0.18em] text-zinc-100">
            VELTRIX
          </Link>
          <nav className="hidden gap-5 text-sm text-zinc-500 sm:flex">
            <a href="#features" className="hover:text-zinc-200">Features</a>
            <a href="#pricing" className="hover:text-zinc-200">Pricing</a>
          </nav>
        </div>
        {signedIn ? (
          <CtaLink href={PATHS.dashboard} small primary>
            Open dashboard
          </CtaLink>
        ) : (
          <div className="flex items-center gap-4">
            <a href={signInHref()} className="text-sm text-zinc-400 hover:text-zinc-100">
              Sign in
            </a>
            <CtaLink href={signInHref()} small primary>
              Get started
            </CtaLink>
          </div>
        )}
      </div>
    </header>
  );
}

/** Plain <a>: sign-in links answer with a redirect to another site, so they need a full page load. */
function CtaLink({ href, children, primary, small }: { href: string; children: React.ReactNode; primary?: boolean; small?: boolean }) {
  const size = small ? "h-8 px-3 text-sm" : "h-11 px-5 text-sm";
  const look = primary
    ? "bg-zinc-100 text-zinc-950 hover:bg-white"
    : "border border-zinc-800 text-zinc-300 hover:border-zinc-700 hover:text-zinc-100";
  return (
    <a href={href} className={`inline-flex items-center justify-center rounded-md font-medium transition ${size} ${look}`}>
      {children}
    </a>
  );
}

function SectionTitle({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div>
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-zinc-500">{eyebrow}</p>
      <h2 className="mt-3 max-w-2xl text-2xl font-semibold tracking-tight text-zinc-50 sm:text-3xl">{title}</h2>
    </div>
  );
}

function PlanCard({ plan, signedIn }: { plan: PlanId; signedIn: boolean }) {
  const limits = PLAN_LIMITS[plan];
  const featured = plan === "PRO";
  const href = signedIn ? (plan === "FREE" ? PATHS.dashboard : PATHS.billing) : signInHref(plan === "FREE" ? PATHS.dashboard : PATHS.billing);
  return (
    <article className={`flex flex-col rounded-xl border p-6 ${featured ? "border-emerald-500/40 bg-emerald-500/[0.03]" : "border-zinc-800/80 bg-zinc-900/40"}`}>
      <div className="flex items-center justify-between">
        <h3 className="font-mono text-sm font-semibold tracking-wider text-zinc-300">{plan}</h3>
        {featured && <span className="rounded-full border border-emerald-500/30 px-2 py-0.5 text-[10px] font-medium text-emerald-300">Popular</span>}
      </div>
      <p className="mt-4 font-mono text-3xl font-semibold tracking-tight text-zinc-50">
        {formatCents(PLAN_PRICE_CENTS[plan]).replace(".00", "")}
        <span className="text-sm font-normal text-zinc-500">/mo</span>
      </p>
      <ul className="mt-6 flex-1 space-y-2 text-sm">
        {RESOURCE_TYPES.map((t) => (
          <li key={t} className="flex justify-between">
            <span className="text-zinc-400">{TYPE_META[t].plural}</span>
            <span className={`font-mono ${limits.maxResources[t] ? "text-zinc-200" : "text-zinc-600"}`}>{limits.maxResources[t] || "—"}</span>
          </li>
        ))}
        <li className="flex justify-between border-t border-zinc-800/80 pt-2">
          <span className="text-zinc-400">Usage budget</span>
          <span className="font-mono text-zinc-200">{formatCents(limits.monthlyBudgetCents)}/mo</span>
        </li>
      </ul>
      <div className="mt-6">
        <CtaLink href={href} primary={featured}>
          {plan === "FREE" ? "Start free" : `Choose ${plan}`}
        </CtaLink>
      </div>
    </article>
  );
}

/** Decorative preview of the dashboard. Hidden from screen readers. */
function ProductPreview() {
  const rows = [
    { type: "APP", name: "api-gateway", meta: "iad · shared-cpu-1x", status: "Running", dot: "bg-emerald-400", text: "text-emerald-300" },
    { type: "POSTGRES", name: "main-db", meta: "aws-us-east-1 · 1 CU", status: "Running", dot: "bg-emerald-400", text: "text-emerald-300" },
    { type: "REDIS", name: "session-cache", meta: "us-east-1 · pay-as-you-go", status: "Running", dot: "bg-emerald-400", text: "text-emerald-300" },
    { type: "WORKER", name: "email-jobs", meta: "fra · shared-cpu-2x", status: "Provisioning", dot: "bg-sky-400", text: "text-sky-300" },
  ] as const;
  return (
    <div aria-hidden className="rounded-xl border border-zinc-800/80 bg-zinc-900/50 shadow-2xl shadow-black/40">
      <div className="flex items-center gap-1.5 border-b border-zinc-800/80 px-4 py-3">
        <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
        <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
        <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
        <span className="ml-3 font-mono text-[11px] text-zinc-500">veltrix / resources</span>
      </div>
      <ul className="divide-y divide-zinc-800/60">
        {rows.map((r) => (
          <li key={r.name} className="flex items-center justify-between gap-3 px-4 py-3.5">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-zinc-400">
                  {TYPE_META[r.type].label}
                </span>
                <span className="truncate font-mono text-sm text-zinc-100">{r.name}</span>
              </div>
              <p className="mt-1 truncate text-xs text-zinc-500">{r.meta}</p>
            </div>
            <span className={`inline-flex shrink-0 items-center gap-1.5 text-xs font-medium ${r.text}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${r.dot}`} />
              {r.status}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
