# Deploying the Zerify dashboard to Cloudflare Workers

This configuration uses the OpenNext Cloudflare adapter to run the existing Next.js App Router application on Workers. The dashboard routes and browser-first Aadhaar/biometric processing remain unchanged.

## Cloudflare Workers Builds settings

Keep the repository root directory as `/` for this first deployment. The commands explicitly enter `frontend/`.

- Worker name: `zerify-dashboard`
- Production branch: `cloudflare/next-dashboard-v2` for the first test; use `main` after merging this change
- Build command: `cd frontend && npm run build:cloudflare`
- Deploy command: `cd frontend && npm run deploy:cloudflare`
- Preview command: `cd frontend && npm run preview:cloudflare`

The initial hostname will be `zerify-dashboard.<your-account-subdomain>.workers.dev`.

## Runtime and build dependencies

- Next.js: `15.5.28` (patched Next.js 15.5 maintenance release)
- React / React DOM: `18.2.0`
- OpenNext Cloudflare adapter: `1.20.15`
- Wrangler: `^4.45.0`

The `build:cloudflare` script runs `npm install --package-lock=false` inside `frontend/` before building. This is deliberate for the initial Workers build because Cloudflare's current project installs dependencies from the repository root; it installs the frontend dependency manifest without relying on the older frontend lockfile. The frontend lockfile still needs to be regenerated and committed before using `npm ci` inside `frontend/` for reproducible local installs.

## Local commands

From `frontend/`:

```bash
npm install
npm run build:cloudflare
npm run preview:cloudflare
```

The adapter creates `.open-next/worker.js` and `.open-next/assets`; Wrangler deploys those outputs using `wrangler.jsonc`.

## Important notes

- Treat the first Workers build as a compatibility test. Review the build output and smoke-test the deployed routes before production use.
- Twilio credentials and all other private values must be configured as Worker secrets/environment variables in Cloudflare. Never put them in `NEXT_PUBLIC_*` variables.
- Configure public Firebase client settings as build-time variables only if the app requires them. Review Firebase Realtime Database security rules separately before handling real identity data.
- The API/backend is not deployed by this dashboard Worker. Do not set a fake API URL or treat a successful dashboard deployment as a successful end-to-end KYC deployment.
- Test login, OTP, request creation, prover navigation, and all server routes before using real identity documents.
- Keep Aadhaar and biometric processing in the browser. Do not upload identity documents or biometric data to the dashboard Worker as part of this deployment.
