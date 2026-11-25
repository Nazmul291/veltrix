import { z } from "zod";

export const emailSchema = z.string().trim().toLowerCase().email("Enter a valid email").max(254);

/** Length beats composition rules (NIST 800-63B). The 128 cap bounds scrypt input. */
export const newPasswordSchema = z
  .string()
  .min(12, "Use at least 12 characters")
  .max(128, "Use at most 128 characters");

/** Only same-site relative paths, so a crafted link can't redirect off-site. */
export function safeRedirect(to: unknown, fallback = "/"): string {
  if (typeof to !== "string" || !to.startsWith("/") || to.startsWith("//") || to.startsWith("/\\")) return fallback;
  return to;
}

export const loginSchema = z.object({
  email: emailSchema,
  // Login doesn't apply the new-password rules: an old account shouldn't be locked out by them.
  password: z.string().min(1, "Enter your password").max(128),
  redirectTo: z.string().optional(),
});
export type LoginInput = z.input<typeof loginSchema>;

export const signupSchema = z.object({
  email: emailSchema,
  name: z.string().trim().max(80).optional(),
  password: newPasswordSchema,
});
export type SignupInput = z.input<typeof signupSchema>;

export type AuthFieldErrors = Partial<Record<"email" | "password" | "name", string[]>>;
export type AuthActionData = { ok: false; formError?: string; fieldErrors?: AuthFieldErrors };
