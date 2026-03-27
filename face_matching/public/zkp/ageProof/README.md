# Deprecated: `ageProof` artifacts

The application **only** loads Groth16 artifacts from:

`frontend/public/zkp/flexibleKyc/`

(build via `scripts/compile-flexible-kyc.ps1`).

Do not add new code that references this folder. You can delete old `ageProof` wasm/zkey files here if present.
