/**
 * Client-safe provider registry: names and field definitions only, no secrets.
 * The admin UI, the zod schemas and credentials.server.ts all share it.
 */

export const PROVIDERS = ["FLY", "NEON", "UPSTASH", "PADDLE", "NAZMULCODES"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export interface ProviderFieldDef {
  readonly key: string;
  readonly label: string;
  readonly hint: string;
  readonly required: boolean;
  /** If set, the value must be one of these, and the UI shows a <select>. */
  readonly options?: readonly string[];
  /** Public by design (e.g. Paddle client token, price IDs): may be sent to the browser. */
  readonly public?: boolean;
  /**
   * Environment variable read when the field isn't set in the database.
   * Only for bootstrap config that must exist before an admin can sign in.
   */
  readonly envFallback?: string;
  /** Used when neither the database nor the environment has a value. */
  readonly defaultValue?: string;
}

export interface ProviderDef {
  readonly name: string;
  readonly description: string;
  readonly fields: readonly ProviderFieldDef[];
}

export const PROVIDER_REGISTRY = {
  FLY: {
    name: "Fly.io",
    description: "Machines API · app hosting & background workers",
    fields: [
      { key: "apiToken", label: "API token", hint: "fly tokens create org <org>", required: true },
      { key: "orgSlug", label: "Organization slug", hint: "Org that tenant apps are created in", required: true },
    ],
  },
  NEON: {
    name: "Neon",
    description: "Serverless Postgres",
    fields: [
      { key: "apiKey", label: "API key", hint: "Organization API key from the Neon console", required: true },
      { key: "orgId", label: "Organization ID", hint: "org-… (only for org-scoped keys)", required: false },
    ],
  },
  UPSTASH: {
    name: "Upstash",
    description: "Serverless Redis",
    fields: [
      { key: "email", label: "Account email", hint: "Developer API authenticates with email + key", required: true },
      { key: "apiKey", label: "Developer API key", hint: "Console → Account → Management API", required: true },
    ],
  },
  PADDLE: {
    name: "Paddle",
    description: "Billing & subscriptions",
    fields: [
      { key: "apiKey", label: "API key", hint: "Developer tools → Authentication", required: true },
      { key: "webhookSecret", label: "Webhook secret", hint: "Notification destination secret key", required: true },
      {
        key: "environment",
        label: "Environment",
        hint: "Which Paddle API base URL to use",
        required: true,
        options: ["sandbox", "production"],
      },
      {
        key: "clientToken",
        label: "Client-side token",
        hint: "test_… or live_… — public by design, used by Paddle.js in the browser",
        required: true,
        public: true,
      },
      { key: "priceIdPro", label: "Pro price ID", hint: "pri_… monthly price for the Pro plan", required: true, public: true },
      { key: "priceIdTeam", label: "Team price ID", hint: "pri_… monthly price for the Team plan", required: true, public: true },
    ],
  },
  NAZMULCODES: {
    name: "NazmulCodes Auth",
    description: "Central sign-in (SSO) for Veltrix users",
    fields: [
      {
        key: "apiKey",
        label: "API key",
        hint: "nc_live_… from the auth admin. Falls back to NAZMULCODES_AUTH_API_KEY.",
        required: true,
        envFallback: "NAZMULCODES_AUTH_API_KEY",
      },
      {
        key: "redirectUri",
        label: "Callback URL",
        hint: "Must exactly match a registered callback, e.g. https://<domain>/auth/callback",
        required: true,
        public: true,
        envFallback: "NAZMULCODES_AUTH_REDIRECT_URI",
      },
      {
        key: "authUrl",
        label: "Auth service URL",
        hint: "Defaults to https://auth.nazmulcodes.org",
        required: false,
        public: true,
        envFallback: "NAZMULCODES_AUTH_URL",
        defaultValue: "https://auth.nazmulcodes.org",
      },
      {
        key: "clientId",
        label: "Client ID",
        hint: "e.g. veltrix. If empty, it's looked up with the API key.",
        required: false,
        public: true,
        envFallback: "NAZMULCODES_AUTH_CLIENT_ID",
      },
    ],
  },
} as const satisfies Record<ProviderId, ProviderDef>;

type FieldsOf<P extends ProviderId> = (typeof PROVIDER_REGISTRY)[P]["fields"][number];

/** Decrypted credential bag for one provider, typed per field. */
export type ProviderSecrets<P extends ProviderId> = {
  [K in Extract<FieldsOf<P>, { required: true }>["key"]]: string;
} & {
  [K in Extract<FieldsOf<P>, { required: false }>["key"]]?: string;
};

export function getProviderFields(provider: ProviderId): readonly ProviderFieldDef[] {
  return PROVIDER_REGISTRY[provider].fields;
}

export function getFieldDef(provider: ProviderId, field: string): ProviderFieldDef | undefined {
  return getProviderFields(provider).find((f) => f.key === field);
}

/** "a1b2c3d4e5f60718" → "a1b2·c3d4·e5f6·0718" */
export function formatFingerprint(fp: string): string {
  return fp.match(/.{1,4}/g)?.join("·") ?? fp;
}
