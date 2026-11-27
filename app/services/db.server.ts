import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };

/**
 * Runtime connection URL.
 * - On Vercel, functions use the pooled Prisma Postgres URL (DATABASE_URL_POOLED),
 *   so many short-lived function instances don't exhaust database connections.
 *   pgbouncer=true turns off prepared statements, which transaction poolers don't support.
 * - Migrations always use the direct DATABASE_URL (see schema.prisma and `npm run db:migrate:prod`).
 */
export function runtimeDatabaseUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  const pooled = env.DATABASE_URL_POOLED?.trim();
  if (!pooled) return env.DATABASE_URL;
  const url = new URL(pooled);
  if (!url.searchParams.has("pgbouncer")) url.searchParams.set("pgbouncer", "true");
  return url.toString();
}

// Reuse one client across Vite HMR reloads in development, and across invocations of a warm function.
export const prisma =
  globalForPrisma.__prisma ?? new PrismaClient({ log: ["warn", "error"], datasourceUrl: runtimeDatabaseUrl() });

if (process.env.NODE_ENV !== "production") globalForPrisma.__prisma = prisma;
