/**
 * Guard: route modules must not export a Vercel function `config`.
 * (Lives outside app/routes: Remix treats every file there as a route.)
 *
 * With the @vercel/remix preset, any route-level `export const config` (for
 * example `{ maxDuration: 300 }`) splits the app into several server bundles,
 * which deploy as separate functions. Remix's lazy route discovery
 * (/__manifest) is then answered by one bundle that doesn't know the other
 * bundles' routes. The browser decides those routes don't exist and shows
 * a 404 without ever calling the server. That broke Sign out, Billing and
 * Admin from the dashboard in production.
 *
 * Set function limits project-wide in Vercel instead (Settings → Functions).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROUTES_DIR = join(process.cwd(), "app/routes");

describe("route modules", () => {
  it("don't export a Vercel `config` (it splits server bundles and breaks route discovery)", () => {
    const offenders = readdirSync(ROUTES_DIR)
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".test.ts"))
      .filter((f) => /export\s+(const|let|var|function)\s+config\b|export\s*\{[^}]*\bconfig\b/.test(readFileSync(join(ROUTES_DIR, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});

/**
 * Public vs protected routes (see app/lib/paths.ts).
 * Anything not listed here must check access in its own module, because in Remix
 * a child route's data can be fetched directly, without its parent layout's loader.
 */
const PUBLIC_ROUTES: Record<string, string> = {
  "_index.tsx": "marketing homepage",
  "login.tsx": "sign-in page",
  "auth.login.ts": "starts SSO",
  "auth.callback.ts": "SSO callback (state-checked)",
  "logout.ts": "ends the caller's own session",
  "billing.tsx": "redirect to /dashboard/billing, no data",
  "webhooks.paddle.ts": "authenticated by Paddle's HMAC signature",
  "api.cron.sweep.ts": "authenticated by CRON_SECRET",
};

describe("route protection", () => {
  const files = readdirSync(ROUTES_DIR).filter((f) => /\.(ts|tsx)$/.test(f));
  const source = (f: string) => readFileSync(join(ROUTES_DIR, f), "utf8");

  it("every non-public route checks access itself", () => {
    const unprotected = files.filter((f) => !(f in PUBLIC_ROUTES) && !/\brequire(User|Admin)\(/.test(source(f)));
    expect(unprotected).toEqual([]);
  });

  it("admin routes require an admin role, not just a signed-in user", () => {
    const weak = files.filter((f) => f.startsWith("admin") && !/\brequireAdmin\(/.test(source(f)));
    expect(weak).toEqual([]);
  });

  it("customer pages live under /dashboard", () => {
    // Pages that render UI for a signed-in user (not API routes, not admin, not public).
    const misplaced = files.filter(
      (f) => f.endsWith(".tsx") && !(f in PUBLIC_ROUTES) && !f.startsWith("dashboard") && !f.startsWith("admin"),
    );
    expect(misplaced).toEqual([]);
  });

  it("the public list has no stale entries", () => {
    expect(Object.keys(PUBLIC_ROUTES).filter((f) => !files.includes(f))).toEqual([]);
  });
});
