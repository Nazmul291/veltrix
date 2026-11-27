# Veltrix

Multi-tenant developer cloud: one-click app hosting and background workers (Fly.io Machines), managed Postgres (Neon), managed Redis (Upstash), and billing through Paddle.

Built with Remix (Vite + TypeScript), Prisma, Zustand, zod and Tailwind.

## Security model

- `.env` holds `DATABASE_URL` and `MASTER_ENCRYPTION_KEY`, plus optional NazmulCodes sign-in fallbacks. Every provider key is stored in Postgres, encrypted with AES-256-GCM (`app/services/crypto.server.ts`), and decrypted only inside server-side API calls (`app/services/credentials.server.ts`).
- Sign-in is NazmulCodes Auth (central SSO). Veltrix stores no passwords.
- Admins manage provider keys at `/admin/providers`. The browser only ever sees a version number and an HMAC fingerprint.
- Tenant connection strings are encrypted with a separate derived key and are revealed only through an audited POST.
- Each tenant's Fly apps run on their own private network.

## Getting started

Requires Node 20+ (verified on Node 24) and PostgreSQL.

```bash
npm install
cp .env.example .env
```

In `.env`, set `DATABASE_URL`, and set `MASTER_ENCRYPTION_KEY` to the output of `openssl rand -hex 32`. Keep that key safe: losing it makes all stored credentials unreadable. Then fill in the NazmulCodes values (see [Sign-in](#sign-in-nazmulcodes-auth) below).

```bash
npx prisma migrate deploy
npm run dev
```

Then make yourself the first admin:

1. Open the app and sign in with NazmulCodes. This creates your Veltrix user.
2. Run `npm run admin:bootstrap -- --list` to find your central user ID.
3. Run `npm run admin:bootstrap -- --central-id <id>`, check the details it prints, and confirm.

Add the remaining provider keys at `/admin/providers`. For Paddle, create a notification destination pointing to `https://<your-domain>/webhooks/paddle` for `subscription.*` events.

## Sign-in (NazmulCodes Auth)

Veltrix has no password login of its own. Users sign in through NazmulCodes Auth, the central SSO, so Veltrix never sees passwords or 2FA codes. Users are identified by their stable central user ID (`User.centralUserId`), never by email.

### Required settings

Set these in **Admin → Providers → NazmulCodes Auth** (stored encrypted), or as environment variables. A value saved in the admin panel takes priority. The environment variables exist for a fresh install, where nobody can sign in to the admin panel yet.

| Variable | Required | Example |
| --- | --- | --- |
| `NAZMULCODES_AUTH_API_KEY` | yes | `nc_live_…` from the auth admin. Server-side only: never put it in client code, URLs, logs or Git. |
| `NAZMULCODES_AUTH_REDIRECT_URI` | yes | `https://<veltrix-domain>/auth/callback`. Must match a registered callback URL exactly. |
| `NAZMULCODES_AUTH_URL` | no | `https://auth.nazmulcodes.org` (the default) |
| `NAZMULCODES_AUTH_CLIENT_ID` | no | `veltrix`. If unset, it's looked up once with the API key. |

### Registering Veltrix in the auth admin

1. In the NazmulCodes auth admin, open **Apps** and create or open the Veltrix app (client ID `veltrix`).
2. Add each callback URL Veltrix will use, exactly: `https://<veltrix-domain>/auth/callback` for production, and `http://localhost:5173/auth/callback` for local development.
3. Copy the `nc_live_…` API key into Admin → Providers (or the environment variable). Rotating the key in the auth admin means updating it here too.

### Local setup

Use `NAZMULCODES_AUTH_REDIRECT_URI="http://localhost:5173/auth/callback"`, which is Vite's default dev port. If you run on another port, register that callback URL as well.

### How it works

- `/auth/login` stores a random `state` and a same-site `returnTo` in the signed session cookie (`httpOnly`, `sameSite: "lax"`, `secure` in production), then redirects to `/authorize`.
- `/auth/callback` checks the state, exchanges the single-use code on the server, upserts the user by central ID, and starts a fresh session.
- `requireUser` re-checks the user with `verify-user` every 15 minutes. Sensitive actions (billing, provider keys, creating, deleting or revealing resources) always re-check first. `valid: false` signs the user out of every Veltrix session.
- If the auth service is unreachable, the periodic check lets the session continue, so an outage doesn't sign everyone out. Sensitive actions are refused until it's back.
- Logout ends only the Veltrix session. The user stays signed in at auth.nazmulcodes.org.
- The SDK in `app/lib/nazmulcodes-auth.server.ts` is the official file from `/admin/docs/sdk`. Don't edit it; replace it with a newer download instead.

## Deploying to Vercel

Veltrix runs on Vercel through the `@vercel/remix` Vite preset (`vite.config.ts`), on Node 24 (`engines` in `package.json`).

### Environment variables (Vercel → Settings → Environment Variables)

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | Direct Prisma Postgres URL (`db.prisma.io`). Used for migrations, and as the fallback at runtime. Added by the Prisma Postgres integration. |
| `DATABASE_URL_POOLED` | Pooled URL (`pooled.db.prisma.io`). Used by functions at runtime, so serverless instances don't exhaust connections. Added by the integration. |
| `MASTER_ENCRYPTION_KEY` | `openssl rand -hex 32`. Never change it once data is encrypted, and keep a backup. |
| `CRON_SECRET` | Any long random string (`openssl rand -hex 32`). Vercel sends it to `/api/cron/sweep`. Without it the cron endpoint refuses to run. |
| `NAZMULCODES_AUTH_API_KEY` | Needed for the very first sign-in. Can move to Admin → Providers afterwards. |
| `NAZMULCODES_AUTH_REDIRECT_URI` | `https://<production-domain>/auth/callback`, registered in the auth admin exactly. |

The integration also adds `DATABASE_POSTGRES_URL` and `DATABASE_PRISMA_DATABASE_URL`. Veltrix doesn't use them.

### Database migrations

Migrations run automatically at the end of every **production** build (`vercel-build` in `package.json` → `scripts/vercel-migrate.mjs`):

- The app is built first. Migrations run only if the build succeeded, and a failed migration fails the deployment, so the previous version stays live.
- Preview builds skip migrations, because they share the production database.
- They use the direct `DATABASE_URL` (`db.prisma.io`). The script refuses the pooled URL.
- Vercel runs the `vercel-build` script only while the project's **Build Command** setting is left at its default (not overridden).

A migration that drops something the live code still uses should be split across two deploys: first stop using it, then drop it. The old deployment keeps serving for a few seconds after the migration runs.

To migrate by hand instead (for example, to check a migration before deploying), pull the env and replace the `"[SENSITIVE]"` placeholder with the direct URL. Vercel never lets anyone download sensitive variables.

```bash
npx vercel env pull .env.production.local --environment=production
npm run db:migrate:prod
```

### First admin

After the first production deploy and your first sign-in, run the bootstrap against production. In the pulled `.env.production.local`, set `DATABASE_URL` to the direct URL and remove the `DATABASE_URL_POOLED` placeholder, then:

```bash
npm run admin:bootstrap:prod -- --list
npm run admin:bootstrap:prod -- --central-id <id>
rm .env.production.local
```

### Background jobs on serverless

Vercel functions stop when they finish responding, so there is no always-running sweeper there. Provisioning is driven three ways:

- **Right away:** creating or deleting a resource starts the work with `waitUntil`. It shares the function's time limit, which is the project's default function duration (300 seconds, the Hobby maximum). Don't add a per-route `export const config` for this. It splits the app into separate functions and breaks Remix's route discovery, which made Sign out, Billing and Admin show 404. A test guards against it.
- **While the dashboard is open:** it polls every 3 seconds while anything is in progress, and each poll moves that tenant's due retries along.
- **Backstop:** Vercel Cron calls `/api/cron/sweep` (see `vercel.json`). The schedule is daily (`0 4 * * *`) because Hobby allows only daily crons; a more frequent schedule makes the deploy fail. On Pro, change it to `*/5 * * * *`.

Crons run only on production deployments.

### Preview deployments

The Prisma Postgres variables are currently shared by Production **and** Preview, so preview deployments read and write the production database. They also use the production provider keys, so a preview can create real infrastructure. Give Preview its own database (and test keys), or remove the Preview scope from these variables.

Sign-in on previews fails unless each preview URL's `/auth/callback` is registered in the auth admin.

## Tests

```bash
npm test
```

The integration suites (SSO sign-in, credentials, provisioning and billing) run only when `TEST_DATABASE_URL` is set. They **TRUNCATE every table**, so point them at a disposable database:

```bash
TEST_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/veltrix_test" npm test
```

## Layout

| Path | What's there |
| --- | --- |
| `app/services/*.server.ts` | Server-only: crypto, credentials, provider clients (`fly`, `neon`, `upstash`, `paddle`), provisioner, billing, auth |
| `app/routes/` | Remix routes: dashboard (`_index`), `billing`, `admin.providers`, `api.resources*`, `webhooks.paddle`, auth |
| `app/hooks/` | All client mutations (each wraps `useFetcher`) |
| `app/store/` | Zustand resource store (one per request, so tenants never share SSR state) |
| `app/lib/` | Client-safe shared code: plans, quota maths, zod schemas, provider registry |
| `scripts/bootstrap-admin.ts` | Promotes the first super admin by central user ID (CLI only) |
