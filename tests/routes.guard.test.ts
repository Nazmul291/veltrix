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
