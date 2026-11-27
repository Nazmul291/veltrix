/**
 * Runs `prisma migrate deploy` as the last step of a Vercel build (see the
 * "vercel-build" script in package.json), but only for production builds.
 *
 * - Preview builds skip it: they share the production database, and running
 *   migrations from unmerged branches would change production.
 * - It runs after `remix vite:build` succeeds, so a broken build never migrates.
 *   If the migration fails, this exits non-zero, which fails the build: the
 *   previous deployment stays live and the database isn't half-changed
 *   (Prisma applies each migration in a transaction and takes an advisory lock,
 *   so concurrent builds are safe).
 * - It uses the direct DATABASE_URL (db.prisma.io), not the pooler. Sensitive
 *   variables are available to builds even though they can't be downloaded.
 *
 * Destructive migrations (dropping a column the live code still reads) should be
 * split across two deploys, because the old deployment keeps serving until the new one is live.
 */
import { spawnSync } from "node:child_process";

const env = process.env.VERCEL_ENV;

if (env !== "production") {
  console.log(`[migrate] VERCEL_ENV=${env ?? "(unset)"}: skipping database migrations (production builds only).`);
  process.exit(0);
}

const url = process.env.DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\//.test(url)) {
  // Never print the value. Name the problem only.
  console.error(
    "[migrate] DATABASE_URL is missing or isn't a postgres:// URL in the Production environment. " +
      "Set it to the direct Prisma Postgres connection string (host db.prisma.io).",
  );
  process.exit(1);
}
if (new URL(url).hostname.startsWith("pooled.")) {
  console.error("[migrate] DATABASE_URL points at the connection pooler. Migrations need the direct URL (db.prisma.io).");
  process.exit(1);
}

console.log("[migrate] Applying pending migrations to the production database…");
const result = spawnSync("npx", ["prisma", "migrate", "deploy"], { stdio: "inherit", env: process.env });
if (result.status !== 0) {
  console.error("[migrate] Migration failed. The build stops here and the current deployment stays live.");
  process.exit(result.status ?? 1);
}
console.log("[migrate] Database is up to date.");
