/**
 * Single source of truth for Groth16 artifacts — flexibleKyc circuit only.
 * Legacy `ageProof` paths are not used anywhere in the app.
 */

export const FLEXIBLE_KYC_ARTIFACT_BASE = "/zkp/flexibleKyc";
export const FLEXIBLE_KYC_WASM_PATH = `${FLEXIBLE_KYC_ARTIFACT_BASE}/flexible_kyc.wasm`;
export const FLEXIBLE_KYC_ZKEY_PATH = `${FLEXIBLE_KYC_ARTIFACT_BASE}/flexible_kyc_final.zkey`;
export const FLEXIBLE_KYC_VKEY_PATH = `${FLEXIBLE_KYC_ARTIFACT_BASE}/flexible_kyc_verification_key.json`;

const ARTIFACT_PATHS = [
  FLEXIBLE_KYC_ARTIFACT_BASE,
  FLEXIBLE_KYC_WASM_PATH,
  FLEXIBLE_KYC_ZKEY_PATH,
  FLEXIBLE_KYC_VKEY_PATH,
] as const;

function assertFlexibleKycOnly(): void {
  for (const p of ARTIFACT_PATHS) {
    if (p.includes("ageProof") || p.includes("/ageProof")) {
      throw new Error(
        `ZKP configuration error: legacy ageProof path leaked into flexibleKyc bundle (${p}).`,
      );
    }
  }
}

assertFlexibleKycOnly();

if (typeof window !== "undefined") {
  console.info("[Zerify ZKP] Using flexibleKyc ZKP artifacts");
}
