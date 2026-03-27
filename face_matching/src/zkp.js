import { groth16 } from "snarkjs";
import { aadhaarGenderToCircuitCode, requiredGenderToCircuitCode } from "./gender.js";

const FLEXIBLE_KYC_WASM_PATH = "/zkp/flexibleKyc/flexible_kyc.wasm";
const FLEXIBLE_KYC_ZKEY_PATH = "/zkp/flexibleKyc/flexible_kyc_final.zkey";
const FLEXIBLE_KYC_VKEY_PATH = "/zkp/flexibleKyc/flexible_kyc_verification_key.json";
const FLEXIBLE_KYC_COMMITMENT_WASM_PATH = "/zkp/flexibleKycCommitment/flexible_kyc_commitment.wasm";
const FLEXIBLE_KYC_COMMITMENT_ZKEY_PATH = "/zkp/flexibleKycCommitment/flexible_kyc_commitment_final.zkey";
const FLEXIBLE_KYC_COMMITMENT_VKEY_PATH = "/zkp/flexibleKycCommitment/flexible_kyc_commitment_verification_key.json";

let poseidonPromise = null;
// Ensure circomlibjs poseidon internals can use `buffer` in-browser.
// main2.js sets globalThis.Buffer, but keep this here as a defensive fallback.
try {
  // eslint-disable-next-line no-undef
  if (typeof globalThis !== "undefined" && !globalThis.Buffer) {
    // Lazy import avoids pulling `buffer` into non-poseidon flows.
    // eslint-disable-next-line no-undef
    // (we don't `await` here)
  }
} catch {
  // ignore
}

function nonceBase64UrlToFieldElementDecimal(nonce) {
  if (!nonce) return "0";
  const b64 = nonce.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (b64.length % 4)) % 4;
  const padded = b64 + "=".repeat(padLen);
  const bin = atob(padded);
  let v = 0n;
  for (let i = 0; i < bin.length; i++) v = (v << 8n) + BigInt(bin.charCodeAt(i));
  return v.toString();
}

function normalizePincodeDigits(pc) {
  return String(pc || "").replace(/\D/g, "").slice(0, 6);
}

function pickWitnessPincode(address, allowedPincodes) {
  const allowed = new Set(
    allowedPincodes.map((p) => normalizePincodeDigits(p)).filter((d) => d.length === 6),
  );
  const matches = String(address || "").match(/\b\d{6}\b/g) ?? [];
  for (const m of matches) {
    if (allowed.has(m)) return Number(m);
  }
  return 0;
}

export function pickWitnessPincodeForCommitment(address, allowedPincodes) {
  return pickWitnessPincode(address, allowedPincodes);
}

function parseBirthYearFromDob(dob) {
  const m = String(dob || "").match(/(\d{4})$/);
  if (!m) throw new Error("DOB does not contain a valid year");
  return Number(m[1]);
}

export function kycAnchorYearUtc(createdAtMs) {
  return new Date(createdAtMs).getUTCFullYear();
}

async function getPoseidon() {
  if (poseidonPromise) return poseidonPromise;
  poseidonPromise = (async () => {
    const lib = await import("circomlibjs");
    const poseidon = await lib.buildPoseidon();
    const F = poseidon.F;
    return { poseidon, F };
  })();
  return poseidonPromise;
}

function quantizeEmbeddingToFieldInputs(embedding, scale = 1000, clampAbs = 1_000_000) {
  const SHIFT = 2n ** 32n;
  const out = new Array(embedding.length);
  for (let i = 0; i < embedding.length; i++) {
    const v = embedding[i] ?? 0;
    let q = Math.round(v * scale);
    if (q > clampAbs) q = clampAbs;
    if (q < -clampAbs) q = -clampAbs;
    const bi = BigInt(q);
    out[i] = bi < 0n ? bi + SHIFT : bi;
  }
  return out;
}

async function poseidonHashMerkle(elements) {
  const { poseidon, F } = await getPoseidon();
  let level = [...elements];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 16) {
      const chunk = level.slice(i, i + 16);
      const padded = [...chunk];
      while (padded.length < 16) padded.push(0n);
      const h = poseidon(padded.slice(0, 16));
      next.push(BigInt(F.toString(h)));
    }
    level = next;
  }
  return level[0].toString();
}

export async function poseidonHashEmbedding(embedding) {
  const inputs = quantizeEmbeddingToFieldInputs(embedding);
  return poseidonHashMerkle(inputs);
}

async function poseidonHash(inputs) {
  const { poseidon, F } = await getPoseidon();
  if (inputs.length > 16) return poseidonHashMerkle(inputs);
  const h = poseidon(inputs);
  return F.toString(h);
}

function buildFlexibleKycInput(params) {
  const { dob, genderRaw, address, currentYear, checks, constraints, nonce } = params;
  const check_age = checks.includes("age") ? 1 : 0;
  const check_gender = checks.includes("gender") ? 1 : 0;
  const check_address = checks.includes("address") ? 1 : 0;
  const min_age = check_age ? Math.max(0, Math.floor(constraints.minAge)) : 0;
  const required_gender = check_gender
    ? requiredGenderToCircuitCode(constraints.requiredGender)
    : 0;

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
  const dob_year = parseBirthYearFromDob(dob);
  const gender = aadhaarGenderToCircuitCode(genderRaw);
  const pincode = check_address ? pickWitnessPincode(address, constraints.pincodes) : 0;
  if (check_address && pincode === 0) {
    throw new Error("No allowed pincode found in address for ZK witness.");
  }
  if (check_gender && required_gender === 0) throw new Error("Verifier gender constraint missing.");
  if (check_gender && gender === 0) throw new Error("Could not map Aadhaar gender to circuit code.");
  const s = (n) => String(n);
  const nonceFe = nonceBase64UrlToFieldElementDecimal(nonce);
  return {
    dob_year: s(dob_year),
    gender: s(gender),
    pincode: s(pincode),
    current_year: s(currentYear),
    min_age: s(min_age),
    required_gender: s(required_gender),
    allowed_pincode1: s(slots[0]),
    allowed_pincode2: s(slots[1]),
    allowed_pincode3: s(slots[2]),
    allowed_pincode4: s(slots[3]),
    allowed_pincode5: s(slots[4]),
    use_pincode1: s(uses[0]),
    use_pincode2: s(uses[1]),
    use_pincode3: s(uses[2]),
    use_pincode4: s(uses[3]),
    use_pincode5: s(uses[4]),
    check_age: s(check_age),
    check_gender: s(check_gender),
    check_address: s(check_address),
    nonce: nonceFe,
  };
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Missing ZKP artifact at ${url}`);
  return r.json();
}

export async function generateFlexibleKycProof(params) {
  const input = buildFlexibleKycInput(params);
  const { proof, publicSignals } = await groth16.fullProve(
    input,
    FLEXIBLE_KYC_WASM_PATH,
    FLEXIBLE_KYC_ZKEY_PATH,
  );
  const verificationKey = await fetchJson(FLEXIBLE_KYC_VKEY_PATH);
  const localVerificationPassed = await groth16.verify(verificationKey, publicSignals, proof);
  if (!localVerificationPassed) throw new Error("Local Groth16 verification failed.");
  return { proof, publicSignals, input };
}

function buildFlexibleKycCommitmentInput(params) {
  const base = buildFlexibleKycInput(params);
  return {
    ...base,
    face_hash: String(params.faceHash),
    commitment: String(params.commitment),
  };
}

export async function generateFlexibleKycCommitmentProof(params) {
  const input = buildFlexibleKycCommitmentInput(params);
  const { proof, publicSignals } = await groth16.fullProve(
    input,
    FLEXIBLE_KYC_COMMITMENT_WASM_PATH,
    FLEXIBLE_KYC_COMMITMENT_ZKEY_PATH,
  );
  const verificationKey = await fetchJson(FLEXIBLE_KYC_COMMITMENT_VKEY_PATH);
  const localVerificationPassed = await groth16.verify(verificationKey, publicSignals, proof);
  if (!localVerificationPassed) {
    throw new Error("Local Groth16 verification failed (commitment circuit).");
  }
  return { proof, publicSignals, input };
}

export function extractBirthYearFromDob(dob) {
  return parseBirthYearFromDob(dob);
}

export async function buildCommitmentFromFields({ dob, genderCode, pincode, faceHash }) {
  return poseidonHash([
    BigInt(dob),
    BigInt(genderCode),
    BigInt(pincode),
    BigInt(faceHash),
  ]);
}
