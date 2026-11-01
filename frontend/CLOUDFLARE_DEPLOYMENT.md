# Deploying the Zerify dashboard to Cloudflare Workers

This configuration uses the OpenNext Cloudflare adapter to run the existing Next.js App Router application on Workers. It does not change the application routes or move Aadhaar/biometric processing to the server.

## Cloudflare Workers Builds settings

Set the Worker project root directory to `frontend`.

- Build command: `npm run build:cloudflare`
- Deploy command: `npm run deploy:cloudflare`
- Production branch: `cloudflare/next-dashboard-deploy` for the first test, then switch to `main` after merging this change.

The Worker name is `zerify-dashboard`, so the initial hostname will be `zerify-dashboard.<your-account-subdomain>.workers.dev`.

## Local commands

From this directory:

```bash
npm run build:cloudflare
npm run preview:cloudflare
```

The adapter creates `.open-next/worker.js` and `.open-next/assets`; Wrangler deploys those outputs using `wrangler.jsonc`.

## Important notes

- Next.js is currently pinned to 14.2.30. Cloudflare's current guidance prioritizes newer Next.js versions, and Next.js 14 is outside upstream support. Treat this first deployment as a compatibility test, not a production guarantee.
- Twilio credentials and all other private values must be configured as Worker secrets/environment variables in Cloudflare. Never put them in `NEXT_PUBLIC_*` variables.
- Configure the required public Firebase client settings as build-time variables only if the app requires them. Review Firebase Realtime Database security rules separately before handling real identity data.
- The API/backend is not deployed by this dashboard Worker. Do not set a fake API URL or treat a successful dashboard deployment as a successful end-to-end KYC deployment.
- Test login, OTP, request creation, prover navigation, and all server routes before using real identity documents.
