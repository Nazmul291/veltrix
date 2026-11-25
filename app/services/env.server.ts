import { z } from "zod";

/**
 * The only two environment variables Veltrix reads.
 * Every provider key lives encrypted in the database.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  MASTER_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "must be 32 bytes as 64 hex chars — generate with `openssl rand -hex 32`"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type Env = z.infer<typeof envSchema>;

/** Provider variables that must not be in the environment. */
const FORBIDDEN_PROVIDER_VARS = [
  "FLY_API_TOKEN",
  "NEON_API_KEY",
  "UPSTASH_EMAIL",
  "UPSTASH_API_KEY",
  "PADDLE_API_KEY",
  "PADDLE_WEBHOOK_SECRET",
];

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }

  const leaked = FORBIDDEN_PROVIDER_VARS.filter((k) => process.env[k]);
  if (leaked.length > 0) {
    console.warn(
      `[env] Provider secrets found in the environment (${leaked.join(", ")}). ` +
        "Veltrix ignores them. Store them through /admin/providers and remove them from the environment.",
    );
  }

  cached = parsed.data;
  return cached;
}
