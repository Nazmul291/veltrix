import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { attachDatabasePool } from "@vercel/functions";
import { Pool } from "pg";

const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };

/**
 * Runtime connection URL: the pooled Prisma Postgres URL (DATABASE_URL_POOLED)
 * when it's set, otherwise the direct DATABASE_URL. Migrations always use the
 * direct URL (see schema.prisma and scripts/vercel-migrate.mjs).
 */
export function runtimeDatabaseUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  const raw = env.DATABASE_URL_POOLED?.trim() || env.DATABASE_URL;
  return raw ? withStrictSsl(raw) : raw;
}

/**
 * pg currently treats sslmode=prefer|require|verify-ca as verify-full (the
 * certificate and hostname are checked) and warns that pg 9 will switch to the
 * weaker libpq meanings. Prisma Postgres URLs use sslmode=require, so asking
 * for verify-full keeps today's secure behaviour and stops the warning.
 */
function withStrictSsl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  const mode = url.searchParams.get("sslmode");
  if (mode && ["prefer", "require", "verify-ca"].includes(mode)) url.searchParams.set("sslmode", "verify-full");
  return url.toString();
}

/**
 * Prisma runs on the `pg` driver (driver adapter) instead of its built-in pool,
 * because of how Vercel Fluid compute treats idle instances.
 *
 * An idle instance is suspended. Its open database sockets are dropped on the
 * far side, but the built-in pool never finds out. The first request after a
 * few idle minutes then waited on dead connections and failed with "Timed out
 * fetching a new connection from the connection pool" (seen in production
 * after 2–5 minute idle gaps).
 *
 * attachDatabasePool keeps the instance alive just long enough to close idle
 * connections before it suspends, so a resumed instance always opens fresh
 * ones. Outside Vercel (local dev, tests) it does nothing.
 */
function createPrismaClient() {
  const connectionString = runtimeDatabaseUrl();
  if (!connectionString) throw new Error("DATABASE_URL is not set (and DATABASE_URL_POOLED is empty).");
  const pool = new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 5_000, // close idle sockets quickly, well before an instance suspends
    connectionTimeoutMillis: 10_000,
  });
  // A connection dropped while idle in the pool emits "error". With no listener,
  // Node treats that as an unhandled error and the function crashes. The pool
  // already discards the dead client, so logging it is enough.
  pool.on("error", (err) => console.warn("[db] idle connection dropped:", err.message));
  attachDatabasePool(pool);
  return new PrismaClient({ adapter: new PrismaPg(pool), log: ["warn", "error"] });
}

/**
 * One client per process, reused across Vite HMR reloads and across invocations
 * of a warm function. It's created on first use, not when this module loads,
 * so the connection URL is read once the environment is ready (just as
 * Prisma's own engine read it lazily).
 */
function getClient(): PrismaClient {
  globalForPrisma.__prisma ??= createPrismaClient();
  return globalForPrisma.__prisma;
}

export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getClient();
    const value = Reflect.get(client, prop, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
