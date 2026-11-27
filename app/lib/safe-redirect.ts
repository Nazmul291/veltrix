import { AFTER_SIGN_IN } from "./paths";

/**
 * Allows only same-site relative paths, so a crafted returnTo can't send users
 * off-site (open redirect). Rejects "//host", "/\host", absolute URLs, control
 * characters, and anything that resolves to another origin.
 */
export function safeRedirect(to: unknown, fallback: string = AFTER_SIGN_IN): string {
  if (typeof to !== "string" || to.length > 2048) return fallback;
  if (!to.startsWith("/") || to.startsWith("//") || to.startsWith("/\\")) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(to)) return fallback;
  try {
    const base = "http://veltrix.invalid";
    const url = new URL(to, base);
    if (url.origin !== base) return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}
