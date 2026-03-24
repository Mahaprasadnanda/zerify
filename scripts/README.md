# Scripts

This directory holds helper scripts for local development and circuit workflows.

## Flexible KYC (only circuit used by the app)

- `compile-flexible-kyc.ps1` compiles `Circuit/circom/flexible_kyc.circom`, runs Groth16 setup (powers of tau 2^16), and copies artifacts into `frontend/public/zkp/flexibleKyc/`. Requires **circom** on `PATH` and repo-root `npm install` (for `circomlib` + `snarkjs` via `npx`).
- `verify_groth16_proof.mjs` verifies any Groth16 proof given a vkey path (used by `POST /verify-proof` in the FastAPI backend).

## Deprecated (not wired into the app)

- `compile-age-proof.ps1` targets an older standalone age circuit and `frontend/public/zkp/ageProof/`. The product uses **flexibleKyc** only; do not point new code at `ageProof` artifacts.
