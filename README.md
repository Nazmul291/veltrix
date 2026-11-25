# Veltrix

Multi-tenant developer cloud: one-click app hosting and background workers (Fly.io Machines), managed Postgres (Neon), managed Redis (Upstash), and billing through Paddle.

Built with Remix (Vite + TypeScript), Prisma, Zustand, zod and Tailwind.

## Security model

- `.env` holds only `DATABASE_URL` and `MASTER_ENCRYPTION_KEY`. Every provider key is stored in Postgres, encrypted with AES-256-GCM (`app/services/crypto.server.ts`), and decrypted only inside server-side API calls (`app/services/credentials.server.ts`).
- Admins manage provider keys at `/admin/providers`. The browser only ever sees a version number and an HMAC fingerprint.
- Tenant connection strings are encrypted with a separate derived key and are revealed only through an audited POST.
- Each tenant's Fly apps run on their own private network.

## Getting started

Requires Node 20+ and PostgreSQL.

```bash
npm install
cp .env.example .env
```

Set `DATABASE_URL` in `.env`, and set `MASTER_ENCRYPTION_KEY` to the output of `openssl rand -hex 32`. Keep that key safe: losing it makes all stored credentials unreadable.

```bash
npx prisma migrate deploy
npm run admin:bootstrap -- --email you@company.com
npm run dev
```

Sign in at `/login`, then add the provider keys at `/admin/providers`.

For Paddle, create a notification destination pointing to `https://<your-domain>/webhooks/paddle` for `subscription.*` events.

## Tests

```bash
npm test
```

The integration suites (provisioning and billing) run only when `TEST_DATABASE_URL` is set. They **TRUNCATE every table**, so point them at a disposable database:

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
| `scripts/bootstrap-admin.ts` | Creates the first super admin (CLI only) |
