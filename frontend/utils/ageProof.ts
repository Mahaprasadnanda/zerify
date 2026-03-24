/**
 * QR scanner / demo helpers — uses the **flexibleKyc** wasm/zkey only (see flexibleKycArtifacts.ts).
 * Filename kept for imports; there is no separate age-only circuit in the bundle.
 */
import { groth16 } from "snarkjs";

import {
  FLEXIBLE_KYC_VKEY_PATH,
  FLEXIBLE_KYC_WASM_PATH,
  FLEXIBLE_KYC_ZKEY_PATH,
} from "@/utils/flexibleKycArtifacts";
import {
  buildFlexibleKycInput,
  extractBirthYearFromDob,
  kycAnchorYearUtc,
} from "@/utils/flexibleKycWitness";

/** Demo / QR scanner: age-only check with min age 18 (matches flexible circuit, age flag only). */
export const DEMO_AGE_MIN = 18;

export type AgeProofGenerationResult = {
  proof: Record<string, unknown>;
  publicSignals: string[];
  localVerificationPassed: boolean;
  backendVerified: boolean | null;
  /** UTC anchor year used in the circuit (from proofBinding.createdAt). */
  currentYear: number;
  birthYear: number;
  isAdult: boolean;
  /** Epoch ms — must be passed to verifyProof as requestContext.createdAt. */
  proofCreatedAtMs: number;
};

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Missing ZKP artifact at ${url} (run scripts/compile-flexible-kyc.ps1).`);
  }
  return (await response.json()) as T;
}

/**
 * Age demonstration using the **flexibleKyc** circuit with only `age` enabled (same wasm/zkey as KYC flow).
 */
export async function generateAgeProofFromDob(dob: string): Promise<AgeProofGenerationResult> {
  const proofCreatedAtMs = Date.now();
  const anchorYear = kycAnchorYearUtc(proofCreatedAtMs);
  const birthYear = extractBirthYearFromDob(dob);

  const input = buildFlexibleKycInput({
    dob,
    genderRaw: "M",
    address: "",
    currentYear: anchorYear,
    checks: ["age"],
    constraints: {
      minAge: DEMO_AGE_MIN,
      requiredGender: "",
      pincodes: [],
    },
  });

  const { proof, publicSignals } = await groth16.fullProve(
    input,
    FLEXIBLE_KYC_WASM_PATH,
    FLEXIBLE_KYC_ZKEY_PATH,
  );

  const verificationKey = await fetchJson<Record<string, unknown>>(FLEXIBLE_KYC_VKEY_PATH);
  const localVerificationPassed = await groth16.verify(verificationKey, publicSignals, proof);
  if (!localVerificationPassed) {
    throw new Error("Local proof verification failed");
  }

  return {
    proof: proof as Record<string, unknown>,
    publicSignals,
    localVerificationPassed,
    backendVerified: null,
    currentYear: anchorYear,
    birthYear,
    isAdult: true,
    proofCreatedAtMs,
  };
}
