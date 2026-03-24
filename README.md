# Privacy-Preserving KYC MVP (Zerify)

Zerify is a web-based KYC prototype where sensitive Aadhaar data stays in the browser and only proof artifacts are sent to the server.

## Core Privacy Rule

Sensitive Aadhaar-derived data must remain in the browser.

- QR decode and UIDAI signature verification happen locally.
- DOB, gender, and address are extracted locally.
- ZK proof generation happens locally.
- Backend receives only `proof`, `publicSignals`, and request-binding metadata.

The backend must not receive raw Aadhaar payload, DOB, full address, or other identity fields.

## Current Status

- Verifier login (Firebase email/password) works.
- Prover login/register (Twilio OTP) works.
- OTP flow now supports **Resend OTP** with:
  - client countdown (enabled after 60 seconds),
  - server-side cooldown enforcement (`429` before 60s).
- Verifier can create KYC requests and write to Firebase RTDB.
- Prover sees assigned requests, uploads Aadhaar QR, and gets local eligibility checks.
- Prover can generate and submit a **flexibleKyc** Groth16 proof.
- Verifier can trigger backend proof verification and persist verification status.

## Important Circuit Decision

The app uses **only one circuit** now:

- `Circuit/circom/flexible_kyc.circom`

Legacy `ageProof` paths are deprecated and not part of runtime verification flow.

## Repository Structure

```text
.
|-- frontend/   # Next.js + TypeScript + Tailwind app
|-- backend/    # FastAPI proof verification service
|-- Circuit/    # Flexible KYC circom source + docs
|-- circuits/   # Legacy/optional folder (not runtime path)
|-- scripts/    # Build/verify helper scripts
`-- README.md
```

## FlexibleKyc ZKP Flow

All runtime proof operations use `frontend/public/zkp/flexibleKyc/` artifacts:

- `flexible_kyc.wasm`
- `flexible_kyc_final.zkey`
- `flexible_kyc_verification_key.json`

### Witness / Public Inputs

- Private witness: `dob_year`, `gender`, `pincode`
- Public signals: request constraints + check flags + UTC anchor year derived from `kycRequests.createdAt`

### Submission

- Prover stores generated proof payload under:
  - `kycRequests/{requestId}/users/{phone}/proof`
- Verifier sends proof to backend:
  - `POST /verify-proof`
  - includes `requestContext` (`createdAt`, `checks`, `constraints`)

Backend recomputes expected public signals from `requestContext` and verifies Groth16 proof.

## API

### `POST /verify-proof`

Verifies flexibleKyc Groth16 proof only.

Example payload:

```json
{
  "proof": {},
  "publicSignals": ["2026", "18", "1", "754109", "0", "0", "0", "0", "1", "0", "0", "0", "0", "1", "1", "1"],
  "requestContext": {
    "createdAt": 1710000000000,
    "checks": ["age", "gender", "address"],
    "constraints": {
      "minAge": 18,
      "requiredGender": "Male",
      "pincodes": ["754109"]
    }
  }
}
```

### `POST /api/otp/send`

- Sends OTP via Twilio Verify.
- Enforces 60-second resend cooldown per phone.
- Returns `retryAfterSec` on success and on cooldown response.

### `POST /api/otp/verify`

- Verifies OTP via Twilio Verify.

## Local Development

## 1) Install dependencies

```bash
cd c:\KYC
npm install
cd frontend
npm install
```

## 2) Build flexibleKyc artifacts

Requires `circom` in PATH:

```powershell
cd c:\KYC
.\scripts\compile-flexible-kyc.ps1
```

## 3) Run backend

```bash
cd c:\KYC\backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

## 4) Run frontend

```bash
cd c:\KYC\frontend
npm run dev
```

Set `NEXT_PUBLIC_API_BASE_URL` in `frontend/.env.local` to match backend, e.g.:

```env
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:8000
```

## Firebase Rules (MVP)

Current MVP rules allow:

- public read for `kycRequests` and user indices,
- authenticated verifier writes,
- `users/{phone}` read/write for prover proof updates.

Use production-hardening before real deployment.

## Troubleshooting

### Only `OPTIONS /verify-proof` appears, no POST

- Usually CORS or wrong API base URL.
- Ensure frontend uses the same backend host/port as uvicorn.

### `Cannot find module './276.js'` in Next dev

- Caused by stale/corrupt `.next` cache.
- Fix:

```powershell
cd c:\KYC\frontend
Remove-Item -Recurse -Force .next
npm run dev
```

### `snarkjs` backend launch errors on Windows

Backend resolver tries local `node_modules/.bin/snarkjs.cmd` and `npx(.cmd)`. Ensure `npm install` was run at repo root and restart backend from the same shell.

## Security Notes

- Do not log proof payloads in production.
- Keep public signals minimal.
- Treat local storage/session data as part of threat model.
- FlexibleKyc currently uses birth **year** (not full DOB precision).
