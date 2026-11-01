# Deploying the Zerify dashboard to Cloudflare Workers

This configuration uses the OpenNext Cloudflare adapter to run the existing Next.js App Router application on Workers. The dashboard routes and browser-first Aadhaar/biometric processing remain unchanged.

## Cloudflare Workers Builds settings

Keep the repository root directory as `/` for this first deployment. The commands explicitly enter `frontend/`.

- Worker name: `zerify-dashboard`
- Production branch: `cloudflare/next-dashboard-deploy` for the first test
- Build command: `cd frontend && npm run build:cloudflare`
- Deploy command: `cd frontend && npm run deploy:cloudflare`
- Preview command: `cd frontend && npm run preview:cloudflare`

The initial hostname will be `zerify-dashboard.<your-account-subdomain>.workers.dev`.

## Runtime and build dependencies

- Next.js: `15.5.28` (patched 15.5 maintenance release)
- React / React DOM: `18.2.0`
- OpenNext Cloudflare adapter: `1.20.15`
- Wrangler: `^4.45.0`

The `build:cloudflare` script runs `npm install --package-lock=false` inside `frontend/` before building. This is deliberate for the initial Workers build because Cloudflare's current project is installing from the repository root; it makes the frontend dependency manifest authoritative without attempting to use the older frontend lockfile. The frontend lockfile still needs to be regenerated and committed before relying on `npm ci` for local reproducible installs.

## Local commands

From `frontend/`:

```bash
npm install
npm run build:cloudflare
npm run preview:cloudflare
```

The adapter creates `.open-next/worker.js` and `.open-next/assets`; Wrangler deploys those outputs using `wrangler.jsonc`.

## Important notes

- This is a compatibility/deployment test. Review the build output and then test the deployed dashboard routes before treating it as production-ready.
- Twilio credentials and all other private values must be configured as Worker secrets/environment variables in Cloudflare. Never put them in `NEXT_PUBLIC_*` variables.
- Configure public Firebase client settings as build-time variables only if the app requires them. Review Firebase Realtime Database security rules separately before handling real identity data.
- The API/backend is not deployed by this dashboard Worker. Do not set a fake API URL or treat a successful dashboard deployment as a successful end-to-end KYC deployment.
- Test login, OTP, request creation, prover navigation, and all server routes before using real identity documents.
- Keep Aadhaar and biometric processing in the browser. Do not upload identity documents or biometric data to the dashboard Worker as part of this deployment.
