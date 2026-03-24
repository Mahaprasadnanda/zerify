===============================
ZKP MODULE — FLEXIBLE KYC (Zerify)
===============================

This folder holds the **Circom source** for the combined age + gender + address
circuit, sample inputs, and a copy of the verification key after you build.

The browser loads proving artifacts from:

  frontend/public/zkp/flexibleKyc/

The FastAPI app verifies proofs with:

  POST http://127.0.0.1:8000/verify-proof

--------------------------------
SOURCE LAYOUT
--------------------------------

1. circom/flexible_kyc.circom
   → Circom 2 circuit (uses circomlib from repo root `node_modules`).

2. sample_input/flexible_input.json
   → Example witness/public layout (numeric reference).

3. vkey/flexible_kyc_verification_key.json
   → Populated when you run the PowerShell build script (overwrites any stale key).

4. verifier/verify_api.py
   → Standalone sample (subprocess + snarkjs). Production verification lives in
     backend/app/main.py (`/verify-proof`).


--------------------------------
CIRCUIT SEMANTICS
--------------------------------

Private inputs (never leave the browser):

  dob_year, gender (1=Male, 2=Female, 3=Other), pincode (6-digit int)

Public inputs (snarkjs `publicSignals`, must match the Firebase KYC request):

  current_year       — UTC year of kycRequests.createdAt (anti fake-age)
  min_age, required_gender, allowed_pincode1..5, use_pincode1..5,
  check_age, check_gender, check_address (0/1 toggles)

When a check_* flag is 0, that clause is not enforced.

Address: pincode must equal at least one allowed_pincodeN with use_pincodeN = 1.


--------------------------------
PREREQUISITES
--------------------------------

- Node.js + npm (repo root: `npm install` — installs snarkjs + circomlib).
- Circom compiler 2.x on PATH: https://docs.circom.io/getting-started/installation/
- PowerShell (Windows) for the one-shot build script.


--------------------------------
BUILD (RECOMMENDED)
--------------------------------

From the repository root:

  npm install
  .\scripts\compile-flexible-kyc.ps1

This will:

  - Compile `Circuit/circom/flexible_kyc.circom` → R1CS + WASM
  - Run Groth16 trusted setup (local dev ceremony — NOT production-grade)
  - Copy `flexible_kyc.wasm`, `flexible_kyc_final.zkey`,
    `flexible_kyc_verification_key.json` into:
        frontend/public/zkp/flexibleKyc/
    and refresh:
        Circuit/vkey/flexible_kyc_verification_key.json


--------------------------------
MANUAL SNARKJS (optional)
--------------------------------

If you prefer bash-style commands, mirror `scripts/compile-flexible-kyc.ps1`:
compile with circom from `Circuit/circom`, then run the same `snarkjs`
powersoftau → groth16 setup → zkey contribute → export verification key steps,
using at least the constraint power suggested by:

  snarkjs r1cs info Circuit/build/flexible_kyc.r1cs


--------------------------------
FRONTEND PROVING (reference)
--------------------------------

  snarkjs.groth16.fullProve(
    input,
    "/zkp/flexibleKyc/flexible_kyc.wasm",
    "/zkp/flexibleKyc/flexible_kyc_final.zkey"
  )

`input` is built in `frontend/utils/flexibleKycWitness.ts`.


--------------------------------
BACKEND VERIFY
--------------------------------

POST /verify-proof

{
  "proof": { ... },
  "publicSignals": [ "..." , ... ],
  "requestContext": {
    "createdAt": <kycRequests.createdAt ms>,
    "checks": ["age","gender","address"],
    "constraints": {
      "minAge": 18,
      "requiredGender": "Male",
      "pincodes": ["754109"]
    }
  }
}

The server checks that `publicSignals` match the request (including UTC anchor
year from `createdAt`), then runs Groth16 verify with
`frontend/public/zkp/flexibleKyc/flexible_kyc_verification_key.json`.


--------------------------------
SECURITY NOTES
--------------------------------

- Trusted setup here is for **development only**. Production needs a proper
  ceremony and pinned artifacts.
- Never send raw Aadhaar fields to the backend; only proof + publicSignals +
  requestContext metadata.
