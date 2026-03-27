import { groth16 } from "snarkjs";

import {
  FLEXIBLE_KYC_VKEY_PATH,
  FLEXIBLE_KYC_WASM_PATH,
  FLEXIBLE_KYC_ZKEY_PATH,
  FLEXIBLE_KYC_COMMITMENT_VKEY_PATH,
  FLEXIBLE_KYC_COMMITMENT_WASM_PATH,
  FLEXIBLE_KYC_COMMITMENT_ZKEY_PATH,
} from "@/utils/flexibleKycArtifacts";
import {
  buildFlexibleKycInput,
  type FlexibleKycFullInput,
  buildFlexibleKycCommitmentInput,
  type FlexibleKycCommitmentFullInput,
  type KycConstraints,
  type VerificationType,
} from "@/utils/flexibleKycWitness";

export type FlexibleKycProofResult = {
  proof: Record<string, unknown>;
  publicSignals: string[];
  input: FlexibleKycFullInput;
  localVerificationPassed: boolean;
};

export type FlexibleKycCommitmentProofResult = {
  proof: Record<string, unknown>;
  publicSignals: string[];
  input: FlexibleKycCommitmentFullInput;
  localVerificationPassed: boolean;
};

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Missing ZKP artifact at ${url} (run scripts/compile-flexible-kyc.ps1).`);
  }
  return (await response.json()) as T;
}

/**
 * Generate a single Groth16 proof covering all requested checks (age / gender / address).
 * Sensitive fields stay in-browser; only `proof` and `publicSignals` should be sent onward.
 *
 * `anchorYear` must match the verifier request (we use UTC year of `kycRequests.createdAt`)
 * so the prover cannot pick a far-future year to fake age.
 */
export async function generateFlexibleKycProof(params: {
  dob: string;
  genderRaw: string;
  address: string;
  checks: VerificationType[];
  constraints: KycConstraints;
  anchorYear: number;
  nonce?: string | null;
}): Promise<FlexibleKycProofResult> {
  const input = buildFlexibleKycInput({
    ...params,
    currentYear: params.anchorYear,
    nonce: params.nonce ?? null,
  });

  const { proof, publicSignals } = await groth16.fullProve(
    input,
    FLEXIBLE_KYC_WASM_PATH,
    FLEXIBLE_KYC_ZKEY_PATH,
  );

  const verificationKey = await fetchJson<Record<string, unknown>>(FLEXIBLE_KYC_VKEY_PATH);
  const localVerificationPassed = await groth16.verify(verificationKey, publicSignals, proof);
  if (!localVerificationPassed) {
    throw new Error("Local Groth16 verification failed.");
  }

  return {
    proof: proof as Record<string, unknown>,
    publicSignals,
    input,
    localVerificationPassed,
  };
}

export async function generateFlexibleKycCommitmentProof(params: {
  dob: string;
  genderRaw: string;
  address: string;
  checks: VerificationType[];
  constraints: KycConstraints;
  anchorYear: number;
  faceHash: string;
  commitment: string;
  nonce?: string | null;
}): Promise<FlexibleKycCommitmentProofResult> {
  const input = buildFlexibleKycCommitmentInput({
    ...params,
    currentYear: params.anchorYear,
    nonce: params.nonce ?? null,
  });

  const { proof, publicSignals } = await groth16.fullProve(
    input,
    FLEXIBLE_KYC_COMMITMENT_WASM_PATH,
    FLEXIBLE_KYC_COMMITMENT_ZKEY_PATH,
  );

  const verificationKey = await fetchJson<Record<string, unknown>>(FLEXIBLE_KYC_COMMITMENT_VKEY_PATH);
  const localVerificationPassed = await groth16.verify(verificationKey, publicSignals, proof);
  if (!localVerificationPassed) {
    throw new Error("Local Groth16 verification failed (commitment circuit).");
  }

  return {
    proof: proof as Record<string, unknown>,
    publicSignals,
    input,
    localVerificationPassed,
  };
}
