# Zerify

Privacy-preserving KYC platform that verifies user eligibility without transmitting raw Aadhaar data to the backend.

Zerify combines browser-side Aadhaar QR processing, liveness checks, face matching, and Groth16 zero-knowledge proofs with a verifier dashboard and a FastAPI verification service. The result is a workflow where the prover reveals only a proof of compliance with verifier constraints such as age, gender, and pincode, while sensitive identity attributes stay on the client.

## Why Zerify

- Privacy first: Aadhaar QR extraction, face processing, and proof generation happen in the browser.
- Selective disclosure: verifiers request only the attributes they need.
- Verifiable trust: submitted claims are backed by Groth16 proofs and server-side verification.
- Practical workflow: includes verifier request creation, recipient notification, prover handoff, and result tracking.

## What The Product Does

Zerify supports two user roles:

- Verifier: signs in with Firebase Auth, creates KYC requests, chooses checks and constraints, notifies recipients, and validates submitted proofs.
- Prover: signs in with OTP, opens assigned KYC requests, uploads an Aadhaar image, passes QR-based eligibility checks, completes liveness and face matching, generates a proof locally, and submits only proof artifacts.

The application currently uses a two-site architecture:

- `frontend/`: Next.js app for landing page, verifier dashboard, OTP flows, request management, and prover launcher.
- `face_matching/`: dedicated browser-side prover application served separately, responsible for Aadhaar image processing, UIDAI QR validation, liveness, face matching, and proof generation/submission.

## Architecture Overview

```text
Verifier (Next.js)
  -> Create request in Firebase RTDB
  -> Optional SMS notification via Twilio
  -> Review recipient proof status
  -> Send proof to FastAPI for backend verification

Prover (Vite app)
  -> Open request from Firebase
  -> Upload Aadhaar image
  -> Decode secure QR locally and validate UIDAI signature
  -> Check age / gender / pincode constraints locally
  -> Run liveness and face comparison locally
  -> Generate Groth16 proof in browser with snarkjs
  -> Store proof + public signals in Firebase

Backend (FastAPI)
  -> Recompute expected public signals from request context
  -> Verify Groth16 proof via Node/snarkjs wrapper
  -> Return verification result to verifier UI
```

## Repository Structure

```text
.
|-- frontend/         Next.js 14 verifier app and OTP-based user flows
|-- backend/          FastAPI API for proof verification and QR scan helpers
|-- face_matching/    Dedicated prover application built with Vite
|-- Circuit/          Circom circuits, wasm, zkeys, and verification keys
|-- scripts/          Circuit compilation and proof utility scripts
|-- package.json      Root snarkjs/circomlib dependencies for circuit workflows
`-- README.md
```

## Frontend Analysis

### 1. Next.js verifier application

The Next.js app is the operational shell of the product.

Key responsibilities:

- Public landing page and product entry point.
- Verifier authentication with Firebase email/password.
- OTP-powered user registration and login flows.
- KYC request creation with configurable checks:
  - minimum age
  - required gender
  - allowed pincodes
- Request persistence in Firebase Realtime Database.
- SMS notifications to recipients using Twilio from Next.js server routes.
- Verifier-side proof verification by calling the FastAPI backend.
- Prover handoff to the dedicated `face_matching` app.

Important pages:

- `frontend/app/page.tsx`: product landing page.
- `frontend/app/verifier/page.tsx`: verifier dashboard, request creation, result review, backend proof verification.
- `frontend/app/user/register/page.tsx`: OTP-based user onboarding.
- `frontend/app/user/login/page.tsx`: OTP-based user login.
- `frontend/app/prover/page.tsx`: request inbox and launcher into the dedicated prover app.
- `frontend/app/face-verification/page.tsx`: in-app liveness and face verification flow component page.

### 2. Prover experience in the Next.js app

The Next.js prover page is intentionally lightweight. It does not perform the full proof journey itself anymore. Instead, it:

- reads assigned requests from Firebase
- shows proof/risk summaries
- transfers session context to the dedicated prover app

This split is reflected directly in `frontend/app/page.tsx` and `frontend/app/prover/page.tsx`, which describe the system as a two-site architecture.

### 3. Shared browser-side privacy utilities

The frontend also contains reusable TypeScript utilities for:

- Aadhaar QR decoding and certificate handling
- face liveness checks
- face matching and ONNX/face-api model loading
- Poseidon hashing
- flexible KYC witness creation and proof generation

These utilities mirror the backend’s proof-binding logic so request constraints and public signal encoding remain consistent across the system.

## Prover App Analysis

The `face_matching/` application is the core privacy engine of the product.

Key responsibilities:

- loads request context from Firebase using `request_id`
- verifies the uploaded Aadhaar secure QR locally
- checks verifier constraints before liveness is enabled
- captures live face frames from camera
- performs liveness checks with turn-left, turn-right, and blink prompts
- extracts embeddings using ONNX MobileFaceNet when available
- falls back to face-api.js descriptors if ONNX is unavailable
- compares live face with Aadhaar portrait locally
- generates either:
  - `groth16-flexible-kyc`
  - `groth16-flexible-kyc-commitment`
- writes proof artifacts and risk metadata back to Firebase

Notable implementation details:

- Vite is configured with `base: '/prover/'` and port `3010`.
- The app expects to be opened with query parameters like `request_id`, `phone`, and `return_url`.
- Proof generation is gated behind successful QR processing and face comparison.
- No raw Aadhaar payload or biometric image is sent to the FastAPI backend during normal proof submission.

## Backend Analysis

The backend is a FastAPI service focused on cryptographic verification and QR processing support.

Core modules:

- `backend/app/main.py`: API entrypoint, CORS, health check, Aadhaar scan endpoint, proof verification endpoint, and legacy Twilio OTP endpoints.
- `backend/app/verifier.py`: executes `snark_verifier.js` through Node.js and parses structured verification output.
- `backend/app/flexible_kyc_public.py`: reconstructs expected public signals from verifier request context.
- `backend/app/aadhaar_qr.py`: OpenCV + pyzbar based QR detection pipeline with multiple preprocessing passes.
- `backend/app/schemas.py`: Pydantic models for proof verification payloads.
- `backend/app/nonce_store.py`: Redis-backed nonce replay helper with in-memory fallback.

Backend responsibilities:

- verifies Groth16 proofs using verification keys stored in `backend/app/`
- binds proof verification to verifier intent using `createdAt`, `checks`, `constraints`, and nonce-like request context
- exposes health and helper endpoints
- supports Aadhaar image upload and QR extraction

Important note on current state:

- The nonce replay helper exists, but the current `verify_proof` route does not actively enforce nonce replay protection.
- Legacy backend Twilio OTP endpoints exist, while the primary user OTP flow in the current product is implemented through Next.js API routes in `frontend/app/api/otp/*`.

## Zero-Knowledge Proof Design

The live product is built around the flexible KYC circuit family:

- `Circuit/circom/flexible_kyc.circom`
- `Circuit/circom/flexible_kyc_commitment.circom`

### Standard flexible KYC proof

Proves requested policy checks over private witness data:

- birth year from Aadhaar DOB
- Aadhaar gender
- pincode extracted from Aadhaar address

Public signals encode:

- anchor year derived from request creation time
- verifier-selected checks
- verifier constraints
- request nonce encoded as a field element

### Commitment-based flexible KYC proof

Adds privacy-preserving commitment support by binding the proof to:

- face hash
- commitment derived from witness fields

This is the scheme currently favored by the verifier dashboard when `requireCommitment` is enabled.

## Data Flow

### Verifier flow

1. Verifier signs in with Firebase Auth.
2. Verifier creates a request with selected checks and target mobile numbers.
3. Request is stored in Firebase RTDB under `kycRequests/` and indexed for both verifier and user lookup.
4. Optional SMS notifications are sent with Twilio.
5. Verifier opens a request later and reviews proof and risk status for each recipient.
6. Verifier sends the stored proof to the FastAPI backend for cryptographic validation.

### Prover flow

1. User registers or logs in via OTP.
2. User opens a request from the prover inbox.
3. Next.js launcher redirects to the dedicated prover site.
4. Prover uploads Aadhaar image.
5. Prover app:
   - detects and validates the secure QR
   - extracts DOB, gender, and address locally
   - checks requested constraints locally
   - unlocks liveness
6. Prover completes liveness and face comparison.
7. Browser generates a Groth16 proof locally.
8. Proof and public signals are stored in Firebase for verifier retrieval.

## Technology Stack

### Frontend

- Next.js 14
- React 18
- TypeScript
- Tailwind CSS
- Firebase Web SDK
- Twilio Node SDK in server routes
- snarkjs
- circomlibjs
- face-api.js
- onnxruntime-web

### Prover app

- Vite
- Vanilla JavaScript modules
- face-api.js / `@vladmandic/face-api`
- ONNX Runtime Web
- Firebase Realtime Database
- snarkjs
- circomlibjs

### Backend

- FastAPI
- Pydantic / pydantic-settings
- OpenCV
- NumPy
- Pillow
- pyzbar
- Redis
- Node.js subprocess integration for snarkjs verification

### ZK and circuit tooling

- Circom
- snarkjs
- Groth16
- Poseidon-based hashing/commitment helpers

## Firebase Data Model

The current codebase revolves around these RTDB collections:

- `kycRequests/{requestId}`: canonical KYC request, verifier metadata, user proof/risk/verification states
- `indices/verifierRequests/{uid}/{requestId}`: verifier dashboard lookup
- `indices/userRequests/{phone}/{requestId}`: prover inbox lookup
- `recipientProfiles/{phoneDigits}`: recipient registry / SMS support metadata

## Local Setup

### Prerequisites

- Node.js 18+
- npm
- Python 3.11+ recommended
- JavaScript-enabled modern browser
- optional: Redis for replay-protection experiments
- optional: Circom for circuit recompilation

### 1. Install root dependencies

```bash
npm install
```

### 2. Start the Next.js app

```bash
cd frontend
npm install
npm run dev
```

Default local URL:

- [http://localhost:3000](http://localhost:3000)

### 3. Start the prover app

```bash
cd face_matching
npm install
npm run setup
npm run dev
```

Default local URL:

- [http://localhost:3010/prover/](http://localhost:3010/prover/)

### 4. Start the FastAPI backend

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Default local URL:

- [http://127.0.0.1:8000](http://127.0.0.1:8000)

### 5. Rebuild circuits when needed

Requires `circom` on `PATH`.

```powershell
.\scripts\compile-flexible-kyc.ps1
```

## Docker Deployment

You can run the full stack with Docker Compose:

1. Copy the example environment file:

```bash
cp .env.docker.example .env
```

2. Fill in Twilio values in `.env` if you want OTP and SMS flows enabled.

3. Build and start the containers:

```bash
docker compose up --build
```

Exposed services:

- frontend: [http://localhost:3000](http://localhost:3000)
- prover app: [http://localhost:3010/prover/](http://localhost:3010/prover/)
- backend API: [http://localhost:8000/api/health](http://localhost:8000/api/health)
- redis: `localhost:6379`

To stop everything:

```bash
docker compose down
```

## Environment Variables

### `frontend/.env.local`

```env
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:8000
NEXT_PUBLIC_FACE_MATCHING_URL=http://localhost:3010/prover/

TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_SERVICE_SID=your_twilio_verify_service_sid
TWILIO_SMS_FROM=your_twilio_sender_number
# or
TWILIO_SMS_MESSAGING_SERVICE_SID=your_twilio_messaging_service_sid
```

### `backend/.env`

```env
APP_ENV=development
APP_HOST=0.0.0.0
APP_PORT=8000
REDIS_URL=redis://localhost:6379/0

TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_VERIFY_SERVICE_SID=your_twilio_verify_service_sid
```

### Prover app

Optional Vite variable:

```env
VITE_VERIFIER_URL=http://localhost:3000
```

## API Summary

### FastAPI

- `GET /api/health`
- `POST /api/scan-aadhaar`
- `POST /api/verify-proof`
- `POST /api/otp/send` (legacy backend route)
- `POST /api/otp/verify` (legacy backend route)

### Next.js server routes

- `POST /api/otp/send`
- `POST /api/otp/verify`
- `POST /api/sms/send`
- `GET /api/otp/debug`

## Security And Privacy Model

What stays in the browser:

- Aadhaar image
- QR payload extraction
- DOB, gender, and address parsing
- face embeddings
- face comparison
- witness generation
- Groth16 proof generation

What leaves the browser in the primary flow:

- proof
- public signals
- request-bound metadata
- risk/proof status metadata stored in Firebase

Current protections:

- verifier intent is bound into public signals
- liveness is required before proof generation in the dedicated prover app
- face comparison status is attached to the prover result
- proof is locally verified before submission
- sensitive console logging is intentionally reduced in several modules

## Known Limitations

- Firebase web configuration is currently hardcoded in client files instead of being fully environment-driven.
- Firebase RTDB rules in `frontend/FIREBASE_RTDB_RULES.md` are demo-oriented and should be hardened before production use.
- Some backend tests appear out of sync with the current API routing and nonce behavior.
- The backend contains replay-protection utilities, but nonce replay enforcement is not fully wired into the active verification endpoint.
- Local user registration state in the Next.js prover flow is stored in browser storage, which is acceptable for an MVP but not sufficient for production identity management.
- The repository contains both modern and legacy flow artifacts, so not every endpoint/file is part of the primary happy-path runtime.

## Testing Notes

The repository includes backend tests under `backend/tests/`, but in the current environment they were not runnable because `pytest` is not installed in the active Python environment.

Suggested verification commands once dependencies are available:

```bash
cd backend
python -m pytest
```

```bash
cd frontend
npm run build
```

```bash
cd face_matching
npm run build
```

## Production Hardening Recommendations

- move Firebase config to environment variables
- enforce strict RTDB read/write rules and per-user access scoping
- fully wire nonce replay protection into proof verification
- centralize OTP handling to avoid duplicated Twilio paths
- add CI for frontend build, prover build, and backend tests
- separate demo assets from production circuit artifacts
- audit biometric retention and threat model before real-world deployment

## Why This Project Stands Out

Zerify is not a generic KYC CRUD application. It is a privacy-preserving identity verification workflow that combines applied cryptography, client-side biometric processing, verifier orchestration, and practical web product design. The codebase already demonstrates a meaningful architecture for selective disclosure KYC, especially in the way it binds verifier intent to zero-knowledge proofs while keeping raw identity data off the backend.
