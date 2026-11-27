/**
 * NazmulCodes Auth — zero-dependency TypeScript SDK for client apps
 * (Veltrix, Stockly, Badgify, Kilo, …). Server-side only: the API key must
 * never reach a browser bundle.
 *
 * Usage (Remix):
 *
 *   const auth = new NazmulCodesAuthClient({
 *     authBaseUrl: "https://auth.nazmulcodes.org",
 *     apiKey: settings.NAZMULCODES_AUTH_API_KEY,      // from your Super Admin DB settings
 *     redirectUri: "https://veltrix.app/auth/callback",
 *   });
 *
 *   // routes/auth.login.tsx — loader
 *   const state = NazmulCodesAuthClient.generateState();
 *   // store `state` in your own HttpOnly session cookie, then:
 *   return redirect(auth.getAuthorizationUrl(state));
 *
 *   // routes/auth.callback.tsx — loader
 *   // 1. compare ?state with the one in your session (reject on mismatch)
 *   // 2. const user = await auth.exchangeCodeForUser(url.searchParams.get("code")!);
 *   // 3. upsert your local user by `user.id` (the stable centralUserId) & create your session
 */

export interface VerifiedCentralUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  twoFactorEnabled: boolean;
}

export interface NazmulCodesAuthConfig {
  /** e.g. "https://auth.nazmulcodes.org" */
  authBaseUrl: string;
  /** `nc_live_…` key issued in /admin/apps. */
  apiKey: string;
  /** Must exactly match a callback URL registered for this app. */
  redirectUri: string;
  /**
   * client_id (your app slug). Optional: if omitted, call `resolveClientId()`
   * once (it asks POST /api/v1/client-info using the API key), so you only need
   * to configure the API key. Passing it explicitly avoids that lookup.
   */
  clientId?: string;
  /** Request timeout in ms (default 10s). */
  timeoutMs?: number;
}

export class NazmulCodesAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "NazmulCodesAuthError";
  }
}

const API_KEY_RE = /^nc_live_[0-9a-f]{64}$/;

export class NazmulCodesAuthClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly redirectUri: string;
  private readonly timeoutMs: number;
  private clientId: string | undefined;

  constructor(config: NazmulCodesAuthConfig) {
    if (!API_KEY_RE.test(config.apiKey)) {
      throw new Error("NazmulCodesAuthClient: apiKey must look like nc_live_<64 hex chars>.");
    }
    if (typeof window !== "undefined") {
      throw new Error("NazmulCodesAuthClient must only be used on the server (it holds your API key).");
    }
    const base = new URL(config.authBaseUrl);
    this.baseUrl = base.origin;
    this.apiKey = config.apiKey;
    this.redirectUri = new URL(config.redirectUri).toString();
    this.clientId = config.clientId;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  /** Cryptographically random, URL-safe CSRF `state` value. */
  static generateState(bytes = 32): string {
    const buf = new Uint8Array(bytes);
    globalThis.crypto.getRandomValues(buf);
    let bin = "";
    for (const b of buf) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  /**
   * Builds the /authorize URL to redirect the browser to.
   * Requires `clientId` (pass it in the config, or call `resolveClientId()` once at boot).
   */
  getAuthorizationUrl(state: string): string {
    if (!this.clientId) {
      throw new Error(
        "NazmulCodesAuthClient: clientId unknown. Pass `clientId` in the config or `await client.resolveClientId()` first.",
      );
    }
    if (!state || state.length < 16) throw new Error("NazmulCodesAuthClient: state must be a random value of 16+ chars.");
    const url = new URL("/authorize", this.baseUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("state", state);
    return url.toString();
  }

  /** Looks up this app's client_id from the API key (POST /api/v1/client-info). Cached. */
  async resolveClientId(): Promise<string> {
    if (this.clientId) return this.clientId;
    const res = await this.post<{ clientId: string }>("/api/v1/client-info", {});
    this.clientId = res.clientId;
    return res.clientId;
  }

  /** Exchanges the single-use `code` (valid 60s) for the verified central user. */
  async exchangeCodeForUser(code: string): Promise<VerifiedCentralUser> {
    if (!code) throw new NazmulCodesAuthError("Missing authorization code.", 400, "invalid_request");
    const res = await this.post<{ user: VerifiedCentralUser }>("/api/v1/token", {
      code,
      redirect_uri: this.redirectUri,
    });
    return res.user;
  }

  /**
   * Checks that a central user is still ACTIVE and still connected to your app.
   * Call this on session refresh / sensitive actions.
   */
  async verifyUserStatus(userId: string): Promise<{ valid: boolean; user?: VerifiedCentralUser }> {
    return this.post<{ valid: boolean; user?: VerifiedCentralUser }>("/api/v1/verify-user", { userId });
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(new URL(path, this.baseUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: "error",
        cache: "no-store",
      });
    } catch (err) {
      throw new NazmulCodesAuthError(
        `NazmulCodes Auth unreachable: ${err instanceof Error ? err.message : String(err)}`,
        0,
        "network_error",
      );
    } finally {
      clearTimeout(timer);
    }

    const data = (await res.json().catch(() => null)) as (T & { error?: string; message?: string }) | null;
    if (!res.ok || data === null) {
      throw new NazmulCodesAuthError(
        data?.message ?? `NazmulCodes Auth request failed (${res.status}).`,
        res.status,
        data?.error ?? "unknown_error",
      );
    }
    return data;
  }
}
