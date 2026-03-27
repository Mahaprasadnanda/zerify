import { canonicalGender as canonicalGenderFn } from "@/lib/genderNormalize";

/** Must match `component main {public [...]}` order in Circuit/circom/flexible_kyc.circom */
export const FLEXIBLE_KYC_PUBLIC_SIGNAL_COUNT = 17;
/** Must match Circuit/circom/flexible_kyc_commitment.circom public order */
export const FLEXIBLE_KYC_COMMITMENT_PUBLIC_SIGNAL_COUNT = 18;

/**
 * Nonce in requests is generated as base64url random bytes in the frontend.
 * The circuit expects a numeric field element `nonce`, so we convert the same
 * bytes to a big-endian decimal string.
 */
export function nonceBase64UrlToFieldElementDecimal(nonce: string | null | undefined): string {
  if (!nonce) return "0";
  // base64url -> standard base64
  const b64 = nonce.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (b64.length % 4)) % 4;
  const padded = b64 + "=".repeat(padLen);
  const bin = atob(padded);
  let v = 0n;
  for (let i = 0; i < bin.length; i++) {
    v = (v << 8n) + BigInt(bin.charCodeAt(i)!);
  }
  return v.toString();
}

/** UTC calendar year for `current_year` in the circuit — tied to request creation time. */
export function kycAnchorYearUtc(createdAtMs: number): number {
  return new Date(createdAtMs).getUTCFullYear();
}

export type VerificationType = "age" | "gender" | "address";

export type KycConstraints = {
  minAge: number;
  requiredGender: "Male" | "Female" | "Other" | "";
  pincodes: string[];
};

/**
 * Map canonical gender to circuit enum (see Circuit/README.txt).
 * 1 = Male, 2 = Female, 3 = Other
 */
export function genderLabelToCircuitCode(
  label: "Male" | "Female" | "Other" | "",
): number {
  if (label === "Male") return 1;
  if (label === "Female") return 2;
  if (label === "Other") return 3;
  return 0;
}

export function aadhaarGenderToCircuitCodeSync(raw: string): number {
  const g = canonicalGenderFn(raw);
  if (g === "male") return 1;
  if (g === "female") return 2;
  if (g === "other") return 3;
  return 0;
}

function normalizePincodeDigits(pc: string): string {
  return pc.replace(/\D/g, "").slice(0, 6);
}

/**
 * Pick a 6-digit pincode from the address that appears in the verifier allow-list
 * (same OR semantics as the KYC page). Used as private witness pincode.
 */
export function pickWitnessPincode(address: string, allowedPincodes: string[]): number {
  const allowed = new Set(
    allowedPincodes.map((p) => normalizePincodeDigits(p)).filter((d) => d.length === 6),
  );
  const matches = address.match(/\b\d{6}\b/g) ?? [];
  for (const m of matches) {
    if (allowed.has(m)) return Number(m);
  }
  return 0;
}

export function extractBirthYearFromDob(dob: string): number {
  const match = dob.match(/(\d{4})$/);
  if (!match) throw new Error("DOB does not contain a valid year");
  return Number(match[1]);
}

export type FlexibleKycFullInput = Record<string, string>;

export type FlexibleKycCommitmentFullInput = Record<string, string>;

/** Public inputs only, in publicSignals order (for verifier-side checks). */
export function encodeFlexibleKycPublicSignals(params: {
  createdAtMs: number;
  checks: VerificationType[];
  constraints: KycConstraints;
  nonce?: string | null;
}): string[] {
  const currentYear = kycAnchorYearUtc(params.createdAtMs);
  const { checks, constraints } = params;
  const check_age = checks.includes("age") ? 1 : 0;
  const check_gender = checks.includes("gender") ? 1 : 0;
  const check_address = checks.includes("address") ? 1 : 0;
  const min_age = check_age ? Math.max(0, Math.floor(constraints.minAge)) : 0;
  const required_gender = check_gender ? genderLabelToCircuitCode(constraints.requiredGender) : 0;
  const slots = [0, 0, 0, 0, 0];
  const uses = [0, 0, 0, 0, 0];
  if (check_address) {
    const list = constraints.pincodes
      .map((p) => normalizePincodeDigits(p))
      .filter((d) => d.length === 6)
      .slice(0, 5);
    for (let i = 0; i < list.length; i++) {
      slots[i] = Number(list[i]);
      uses[i] = 1;
    }
  }
  const s = (n: number) => String(n);
  const nonceFe = nonceBase64UrlToFieldElementDecimal(params.nonce);
  return [
    s(currentYear),
    s(min_age),
    s(required_gender),
    s(slots[0]),
    s(slots[1]),
    s(slots[2]),
    s(slots[3]),
    s(slots[4]),
    s(uses[0]),
    s(uses[1]),
    s(uses[2]),
    s(uses[3]),
    s(uses[4]),
    s(check_age),
    s(check_gender),
    s(check_address),
    nonceFe,
  ];
}

/**
 * Build the full snarkjs input object (private + public). All values as decimal strings.
 */
export function buildFlexibleKycInput(params: {
  dob: string;
  genderRaw: string;
  address: string;
  currentYear: number;
  checks: VerificationType[];
  constraints: KycConstraints;
  nonce?: string | null;
}): FlexibleKycFullInput {
  const { dob, genderRaw, address, currentYear, checks, constraints } = params;

  const check_age = checks.includes("age") ? 1 : 0;
  const check_gender = checks.includes("gender") ? 1 : 0;
  const check_address = checks.includes("address") ? 1 : 0;

  const min_age = check_age ? Math.max(0, Math.floor(constraints.minAge)) : 0;
  const required_gender = check_gender ? genderLabelToCircuitCode(constraints.requiredGender) : 0;

  const slots = [0, 0, 0, 0, 0];
  const uses = [0, 0, 0, 0, 0];
  if (check_address) {
    const list = constraints.pincodes
      .map((p) => normalizePincodeDigits(p))
      .filter((d) => d.length === 6)
      .slice(0, 5);
    for (let i = 0; i < list.length; i++) {
      slots[i] = Number(list[i]);
      uses[i] = 1;
    }
  }

  const dob_year = extractBirthYearFromDob(dob);
  const gender = aadhaarGenderToCircuitCodeSync(genderRaw);
  const pincode =
    check_address ? pickWitnessPincode(address, constraints.pincodes) : 0;

  if (check_address && pincode === 0) {
    throw new Error("No allowed pincode found in address for ZK witness.");
  }
  if (check_gender && required_gender === 0) {
    throw new Error("Verifier gender constraint missing.");
  }
  if (check_gender && gender === 0) {
    throw new Error("Could not map Aadhaar gender to circuit code.");
  }

  const toStr = (n: number) => String(n);
  const nonceFe = nonceBase64UrlToFieldElementDecimal(params.nonce);

  return {
    dob_year: toStr(dob_year),
    gender: toStr(gender),
    pincode: toStr(pincode),
    current_year: toStr(currentYear),
    min_age: toStr(min_age),
    required_gender: toStr(required_gender),
    allowed_pincode1: toStr(slots[0]),
    allowed_pincode2: toStr(slots[1]),
    allowed_pincode3: toStr(slots[2]),
    allowed_pincode4: toStr(slots[3]),
    allowed_pincode5: toStr(slots[4]),
    use_pincode1: toStr(uses[0]),
    use_pincode2: toStr(uses[1]),
    use_pincode3: toStr(uses[2]),
    use_pincode4: toStr(uses[3]),
    use_pincode5: toStr(uses[4]),
    check_age: toStr(check_age),
    check_gender: toStr(check_gender),
    check_address: toStr(check_address),
    nonce: nonceFe,
  };
}

export function buildFlexibleKycCommitmentInput(params: {
  dob: string;
  genderRaw: string;
  address: string;
  currentYear: number;
  checks: VerificationType[];
  constraints: KycConstraints;
  faceHash: string;
  commitment: string;
  nonce?: string | null;
}): FlexibleKycCommitmentFullInput {
  const base = buildFlexibleKycInput(params);
  return {
    ...base,
    face_hash: String(params.faceHash),
    commitment: String(params.commitment),
  };
}

/**
 * Parse publicSignals from snarkjs (decimal strings) and compare to what we expect from the request.
 */
export function publicSignalsMatchRequest(
  publicSignals: string[],
  params: {
    createdAtMs: number;
    checks: VerificationType[];
    constraints: KycConstraints;
    nonce?: string | null;
  },
): boolean {
  if (publicSignals.length !== FLEXIBLE_KYC_PUBLIC_SIGNAL_COUNT) return false;
  const expected = encodeFlexibleKycPublicSignals(params);
  for (let i = 0; i < expected.length; i++) {
    if (publicSignals[i] !== expected[i]) return false;
  }
  return true;
}
