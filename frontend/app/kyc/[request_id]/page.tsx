"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { get, onValue, ref, update } from "firebase/database";
import { firebaseDb } from "@/lib/firebaseClient";
import { gendersMatch } from "@/lib/genderNormalize";
import { decodeQrFromFile } from "@/utils/qrDecoder";
import { normalizeSecureQrPayload, verifyAadhaarSecureQr } from "@/utils/aadhaarVerifier";
import { kycAnchorYearUtc } from "@/utils/flexibleKycWitness";
import { poseidonHash } from "@/utils/poseidon";
import {
  aadhaarGenderToCircuitCodeSync,
  extractBirthYearFromDob,
  pickWitnessPincode,
} from "@/utils/flexibleKycWitness";

type VerificationType = "age" | "gender" | "address";

type KycConstraints = {
  minAge: number;
  requiredGender: "Male" | "Female" | "Other" | "";
  pincodes: string[];
};

type ZkStoredProof = {
  version: 1 | 2;
  scheme: "groth16-flexible-kyc" | "groth16-flexible-kyc-commitment";
  createdAt: number;
  nonce?: string;
  proof: Record<string, unknown>;
  publicSignals: string[];
};

type KycUserState = {
  proof: null | ZkStoredProof;
  verification: {
    ageVerified: boolean | null;
    genderVerified: boolean | null;
    addressVerified: boolean | null;
    verifiedAtByAttribute?: {
      age?: number;
      gender?: number;
      address?: number;
    };
  };
};

type KycRequest = {
  requestId: string;
  verifier: { uid: string; email: string; name: string };
  checks: VerificationType[];
  constraints: KycConstraints;
  purpose?: string;
  nonce?: string;
  security?: { requireCommitment?: boolean; nonce?: string };
  createdAt: number;
  users: Record<string, KycUserState>;
};

/** Stored under indices/userRequests/{phoneE164}/{requestId} for prover (no Firebase Auth). */
type UserRequestIndexEntry = {
  requestId: string;
  createdAt: number;
  verifierName?: string;
  checks?: VerificationType[];
  constraints?: KycConstraints;
  purpose?: string;
  nonce?: string;
  security?: { requireCommitment?: boolean; nonce?: string };
};

/** Lazy-load snarkjs/ffjavascript only when proving — smaller initial graph, fewer webpack chunk issues. */
let flexibleKycProofModulePromise: Promise<typeof import("@/utils/flexibleKycProof")> | null = null;

function loadFlexibleKycProofModule() {
  if (!flexibleKycProofModulePromise) {
    flexibleKycProofModulePromise = import("@/utils/flexibleKycProof");
  }
  return flexibleKycProofModulePromise;
}

function phoneDigitsOnly(phone: string): string {
  return phone.replace(/\D/g, "");
}

function defaultEmptyUserState(): KycUserState {
  return {
    proof: null,
    verification: {
      ageVerified: null,
      genderVerified: null,
      addressVerified: null,
      verifiedAtByAttribute: {},
    },
  };
}

/**
 * RTDB may store partial `users/{phone}` (e.g. only `proof` after an update) — always merge with defaults.
 */
function normalizeUserState(raw: Partial<KycUserState> | null | undefined): KycUserState {
  const base = defaultEmptyUserState();
  if (!raw) return base;
  const v = raw.verification;
  return {
    proof: raw.proof ?? null,
    verification: {
      ageVerified: v?.ageVerified ?? null,
      genderVerified: v?.genderVerified ?? null,
      addressVerified: v?.addressVerified ?? null,
      verifiedAtByAttribute: v?.verifiedAtByAttribute ?? {},
    },
  };
}

/** Match Firebase `users` keys: E.164 may be stored as +91… or as digits-only after import / tooling. */
function getUserStateForPhone(
  users: Record<string, KycUserState> | undefined,
  phoneE164: string,
): KycUserState | null {
  if (!users) return null;
  let raw: Partial<KycUserState> | undefined;
  if (users[phoneE164]) raw = users[phoneE164];
  else {
    const want = phoneDigitsOnly(phoneE164);
    for (const key of Object.keys(users)) {
      if (phoneDigitsOnly(key) === want) {
        raw = users[key];
        break;
      }
    }
  }
  if (raw === undefined) return null;
  return normalizeUserState(raw);
}

/**
 * Ensures the logged-in phone always has a `users` entry when the index says they belong on this request.
 * Important: we used to return `full` from RTDB verbatim; if `users` used a different string key than
 * `sessionPhone`, `users[+917…]` was undefined and the UI showed "not part of this request".
 */
function mergeRequestForProver(
  full: KycRequest | null,
  indexEntry: UserRequestIndexEntry | null,
  phoneE164: string,
): KycRequest | null {
  const hasIndexPayload = Boolean(indexEntry?.checks && indexEntry.constraints);

  if (!full?.requestId) {
    if (!hasIndexPayload || !indexEntry) return null;
    return {
      requestId: indexEntry.requestId,
      createdAt: indexEntry.createdAt,
      verifier: { uid: "", email: "", name: indexEntry.verifierName ?? "Verifier" },
      checks: indexEntry.checks!,
      constraints: indexEntry.constraints!,
      purpose: indexEntry.purpose,
      nonce: indexEntry.nonce,
      security: indexEntry.security,
      users: { [phoneE164]: defaultEmptyUserState() },
    };
  }

  const users: Record<string, KycUserState> = { ...(full.users ?? {}) };
  if (!getUserStateForPhone(users, phoneE164)) {
    users[phoneE164] = defaultEmptyUserState();
  }
  return { ...full, users };
}


const STORAGE_KEYS = {
  userSession: "zerify.user.session",
} as const;

function normalizeToE164India(raw: string): string {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.startsWith("91") && digits.length === 12) return `+${digits}`;
  if (raw.trim().startsWith("+")) return raw.trim();
  throw new Error("Invalid phone number");
}

function computeAgeFromDob(dob: string) {
  const birthYear = Number(dob.slice(-4));
  const currentYear = new Date().getFullYear();
  return { birthYear, currentYear, age: currentYear - birthYear };
}

/**
 * Every distinct 6-digit sequence in the address (word boundaries).
 * Pincode check uses OR logic: pass if **any one** of these equals **any one** allowed PIN.
 */
function extractPincodesFromAddress(address: string): string[] {
  const matches = address.match(/\b\d{6}\b/g);
  if (!matches?.length) return [];
  return [...new Set(matches)];
}

function normalizeAllowedPincodes(allowed: string[]): Set<string> {
  return new Set(
    allowed
      .map((p) => p.replace(/\D/g, ""))
      .filter((d) => d.length === 6),
  );
}

/** True iff some PIN found in the address matches some entry in the verifier list (OR, not AND). */
function addressMatchesAnyAllowedPincode(address: string, allowedPincodes: string[]): boolean {
  const allowedSet = normalizeAllowedPincodes(allowedPincodes);
  if (allowedSet.size === 0) return false;
  const found = extractPincodesFromAddress(address);
  return found.some((pc) => allowedSet.has(pc));
}

function Spinner() {
  return (
    <span
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white/90"
      aria-hidden="true"
    />
  );
}

function StatusRow({
  label,
  tone,
  busy,
}: {
  label: string;
  tone: "pending" | "ok" | "error";
  busy?: boolean;
}) {
  const cls =
    tone === "ok"
      ? "text-emerald-200"
      : tone === "error"
        ? "text-rose-200"
        : "text-slate-300";

  return (
    <div className={`flex items-center justify-between gap-4 text-sm ${cls}`}>
      <span className="flex items-center gap-2">
        {tone === "ok" ? <span aria-hidden="true">✓</span> : null}
        {tone === "error" ? <span aria-hidden="true">✕</span> : null}
        {label}
      </span>
      {busy ? <Spinner /> : null}
    </div>
  );
}

export default function KycRequestPage({
  params,
}: {
  params: { request_id: string };
}) {
  const router = useRouter();
  const requestId = params.request_id;
  const faceMatchingBaseUrl = process.env.NEXT_PUBLIC_FACE_MATCHING_URL ?? "http://localhost:3010";

  const [fullRequest, setFullRequest] = useState<KycRequest | null>(null);
  const [indexEntry, setIndexEntry] = useState<UserRequestIndexEntry | null>(null);
  const [indexFetched, setIndexFetched] = useState(false);
  const [indexLoadError, setIndexLoadError] = useState<string | null>(null);

  const [sessionPhone, setSessionPhone] = useState<string | null>(null);

  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [uidaiValid, setUidaiValid] = useState<null | boolean>(null);
  const [checksResult, setChecksResult] = useState<null | {
    agePass?: boolean;
    genderPass?: boolean;
    addressPass?: boolean;
    reason?: string;
    /** Duplicated here so the UI always has extraction data in the same update as pass/fail. */
    extracted?: {
      name: string;
      dob: string;
      gender: string;
      address: string;
    };
  }>(null);

  /** Shown after successful UIDAI verification (local only). */
  const [extractedFields, setExtractedFields] = useState<{
    name: string;
    dob: string;
    gender: string;
    address: string;
  } | null>(null);

  const [proofBusy, setProofBusy] = useState(false);
  const [proofError, setProofError] = useState<string | null>(null);
  const [proofOk, setProofOk] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [scanMethod, setScanMethod] = useState<string | null>(null);
  const [riskStatus, setRiskStatus] = useState<"verified" | "suspicious">("suspicious");
  const [faceVerificationPassed, setFaceVerificationPassed] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      const token = sp.get("session_token");
      if (token) {
        const padded = token.replace(/-/g, "+").replace(/_/g, "/");
        const normalized = padded + "=".repeat((4 - (padded.length % 4)) % 4);
        const decoded = decodeURIComponent(escape(atob(normalized)));
        sessionStorage.setItem(STORAGE_KEYS.userSession, decoded);
        localStorage.removeItem(STORAGE_KEYS.userSession);
      }
      const raw = sessionStorage.getItem(STORAGE_KEYS.userSession) ?? localStorage.getItem(STORAGE_KEYS.userSession);
      if (raw) {
        sessionStorage.setItem(STORAGE_KEYS.userSession, raw);
        localStorage.removeItem(STORAGE_KEYS.userSession);
      }
      if (raw) {
        const parsed = JSON.parse(raw) as { phone: string };
        setSessionPhone(parsed.phone);
      }
    } catch {
      setSessionPhone(null);
    }
  }, []);

  useEffect(() => {
    return () => {
      stopCamera();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  useEffect(() => {
    const key = `kyc_face_match_${requestId}`;
    const sp = new URLSearchParams(window.location.search);
    const cb = sp.get("face_match");
    if (cb) {
      const passed = cb === "passed";
      setFaceVerificationPassed(passed);
      setRiskStatus(passed ? "verified" : "suspicious");
      try {
        sessionStorage.setItem(key, passed ? "passed" : "failed");
      } catch {}
      const cleaned = new URL(window.location.href);
      cleaned.searchParams.delete("face_match");
      cleaned.searchParams.delete("sim");
      cleaned.searchParams.delete("dist");
      cleaned.searchParams.delete("phone");
      cleaned.searchParams.delete("session_token");
      window.history.replaceState({}, "", cleaned.toString());
      return;
    }
    try {
      const v = sessionStorage.getItem(key) ?? localStorage.getItem(key);
      if (v) {
        sessionStorage.setItem(key, v);
        localStorage.removeItem(key);
      }
      const passed = v === "passed";
      setFaceVerificationPassed(passed);
      setRiskStatus(passed ? "verified" : "suspicious");
    } catch {
      setFaceVerificationPassed(false);
    }
  }, [requestId]);

  useEffect(() => {
    if (!sessionPhone || !requestId) return;
    let cancelled = false;
    setIndexFetched(false);
    setIndexLoadError(null);
    setIndexEntry(null);
    setFullRequest(null);

    const idxRef = ref(firebaseDb, `indices/userRequests/${sessionPhone}/${requestId}`);
    void get(idxRef)
      .then((snap) => {
        if (cancelled) return;
        setIndexFetched(true);
        if (!snap.exists()) {
          setIndexEntry(null);
          setIndexLoadError(
            "No request for this ID under your logged-in phone. The verifier must use the same number you used at login.",
          );
          return;
        }
        const entry = snap.val() as UserRequestIndexEntry;
        setIndexEntry(entry);
        if (!entry.checks || !entry.constraints) {
          setIndexLoadError(
            "This request was created before the latest app update. Ask the verifier to send a new KYC request.",
          );
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setIndexFetched(true);
        setIndexLoadError(err instanceof Error ? err.message : "Failed to load request from Firebase.");
      });

    const rRef = ref(firebaseDb, `kycRequests/${requestId}`);
    const unsub = onValue(rRef, (snap) => {
      if (cancelled) return;
      setFullRequest((snap.val() as KycRequest | null) ?? null);
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [sessionPhone, requestId]);

  const request = useMemo(() => {
    if (!sessionPhone) return null;
    return mergeRequestForProver(fullRequest, indexEntry, sessionPhone);
  }, [fullRequest, indexEntry, sessionPhone]);

  const myUserState = useMemo(() => {
    if (!request || !sessionPhone) return null;
    return getUserStateForPhone(request.users, sessionPhone);
  }, [request, sessionPhone]);

  /** Prefer extraction bundled on checks (same React update as pass/fail); fallback for older state. */
  const displayExtracted = useMemo(
    () => checksResult?.extracted ?? extractedFields,
    [checksResult?.extracted, extractedFields],
  );

  const constraintsSummary = useMemo(() => {
    if (!request) return [];
    const items: string[] = [];
    if (request.checks.includes("age")) items.push(`Age ≥ ${request.constraints.minAge}`);
    if (request.checks.includes("gender") && request.constraints.requiredGender)
      items.push(`Gender = ${request.constraints.requiredGender}`);
    if (request.checks.includes("address") && request.constraints.pincodes.length > 0)
      items.push(
        `Pincode matches any of {${request.constraints.pincodes.join(", ")}}`,
      );
    return items;
  }, [request]);

  const showMessage = (nextError: string | null, nextOk: string | null) => {
    setError(nextError);
    setProofOk(nextOk);
  };

  const showPreview = (file: File) => {
    setFileName(file.name);
    setScanMethod(null);
    setChecksResult(null);
    setUidaiValid(null);
    setExtractedFields(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(file));
    setFaceVerificationPassed(false);
    setRiskStatus("suspicious");
    try {
      sessionStorage.removeItem(`kyc_face_match_${requestId}`);
      localStorage.removeItem(`kyc_face_match_${requestId}`);
    } catch {}
  };

  const stopCamera = () => {
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraOpen(false);
  };

  const startCamera = async () => {
    setError(null);
    setCameraBusy(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("No camera available in this browser. Please use Upload Image.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      streamRef.current = stream;
      setCameraOpen(true);
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => {});
        }
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not access camera.";
      if (/denied|permission/i.test(msg)) {
        setError("Camera permission denied. Please allow access or use Upload Image.");
      } else {
        setError(msg);
      }
      stopCamera();
    } finally {
      setCameraBusy(false);
    }
  };

  const sendToBackend = async (file: File): Promise<{ qrData: string; method?: string }> => {
    const apiBase = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/$/, "");
    const url = apiBase ? `${apiBase}/scan-aadhaar` : "/scan-aadhaar";
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch(url, {
      method: "POST",
      body: formData,
    });
    let body: {
      success?: boolean;
      qr_data?: string;
      message?: string;
      method?: string;
    } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // ignore non-json
    }
    if (!res.ok || !body.success || !body.qr_data) {
      throw new Error(body.message || "QR not detected, try again.");
    }
    return { qrData: body.qr_data, method: body.method };
  };

  const startProcessing = async (file: File) => {
    setError(null);
    setBusy(true);
    setUidaiValid(null);
    setChecksResult(null);
    setExtractedFields(null);
    setProofOk(null);

    try {
      let payload: string | null = null;
      let methodLabel: string | null = null;
      try {
        const backendScan = await sendToBackend(file);
        payload = backendScan.qrData;
        methodLabel = backendScan.method ?? "backend";
      } catch {
        payload = await decodeQrFromFile(file);
        methodLabel = payload ? "local-fallback" : null;
      }
      if (!payload) throw new Error("QR not detected, try again.");
      payload = normalizeSecureQrPayload(payload);
      setScanMethod(methodLabel);

      const verification = await verifyAadhaarSecureQr(payload);
      setUidaiValid(verification.isValid);

      if (!verification.isValid) {
        setChecksResult({ reason: "UIDAI signature verification failed." });
        return;
      }

      const { dob, gender, address, name } = verification.data;
      if (!dob || !gender || !address) {
        setChecksResult({ reason: "Missing DOB/Gender/Address in QR." });
        return;
      }

      const extracted = {
        name: name ?? "—",
        dob,
        gender,
        address,
      };
      setExtractedFields(extracted);

      const age = computeAgeFromDob(dob);

      const ageActive = Boolean(request?.checks?.includes("age"));
      const genderActive = Boolean(request?.checks?.includes("gender"));
      const addressActive = Boolean(request?.checks?.includes("address"));

      const minAge = request?.constraints?.minAge ?? 18;
      const requiredGender = request?.constraints?.requiredGender;
      const pincodes = request?.constraints?.pincodes ?? [];

      const agePass = ageActive ? age.age >= minAge : undefined;
      const genderPass =
        genderActive && requiredGender ? gendersMatch(gender, requiredGender) : undefined;
      const addressPass =
        addressActive && pincodes.length ? addressMatchesAnyAllowedPincode(address, pincodes) : undefined;

      let reason: string | undefined;
      if (ageActive && agePass === false) reason = `Age requirement not met (need ≥ ${minAge}).`;
      if (!reason && genderActive && genderPass === false) reason = "Gender mismatch.";
      if (!reason && addressActive && addressPass === false) reason = "Address not in allowed region (pincode mismatch).";

      setChecksResult({
        agePass,
        genderPass,
        addressPass,
        reason: reason ?? undefined,
        extracted,
      });
    } catch (e) {
      showMessage(e instanceof Error ? e.message : "Processing failed.", null);
    } finally {
      setBusy(false);
    }
  };

  const handleUpload = async (file: File) => {
    showPreview(file);
    await startProcessing(file);
  };

  const captureImage = async () => {
    if (!videoRef.current) return;
    const video = videoRef.current;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) {
      setError("Camera is not ready. Please try again.");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setError("Could not capture image.");
      return;
    }
    ctx.drawImage(video, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.92),
    );
    stopCamera();
    if (!blob) {
      setError("Could not capture image.");
      return;
    }
    const captured = new File([blob], `aadhaar-capture-${Date.now()}.jpg`, {
      type: "image/jpeg",
    });
    await handleUpload(captured);
  };

  const canSubmitZk =
    Boolean(request) &&
    uidaiValid === true &&
    displayExtracted &&
    checksResult &&
    !checksResult.reason &&
    sessionPhone &&
    (!request?.security?.requireCommitment || faceVerificationPassed);

  const proofDisabledReason = useMemo(() => {
    if (myUserState?.proof) return null;
    if (!sessionPhone) return "Log in with your phone number.";
    if (!request) return "Loading this KYC request…";
    if (busy) return "Processing Aadhaar image…";
    if (uidaiValid === false) return "UIDAI signature did not verify. Use a sharp photo of the secure QR on the back.";
    if (checksResult?.reason) return `Fix this first: ${checksResult.reason}`;
    if (uidaiValid === true && !displayExtracted) return "Extraction failed to show — try re-uploading the image.";
    if (request.security?.requireCommitment && !faceVerificationPassed) {
      return "This request requires face verification. Open the Face Matching App, complete liveness + 5-frame match, then return here.";
    }
    if (uidaiValid === true && displayExtracted && !checksResult?.reason && sessionPhone) return null;
    return "Upload your Aadhaar and complete the steps above.";
  }, [
    myUserState?.proof,
    sessionPhone,
    request,
    busy,
    uidaiValid,
    checksResult?.reason,
    displayExtracted,
    request?.security?.requireCommitment,
    faceVerificationPassed,
  ]);

  const handleSubmitZkProof = async () => {
    if (!request || !sessionPhone || !displayExtracted) return;
    setProofError(null);
    setProofOk(null);
    setProofBusy(true);
    try {
      const { generateFlexibleKycProof, generateFlexibleKycCommitmentProof } =
        await loadFlexibleKycProofModule();
      const anchorYear = kycAnchorYearUtc(request.createdAt);
      const faceHash = undefined;
      let proof: Record<string, unknown>;
      let publicSignals: string[];
      let scheme: ZkStoredProof["scheme"] = "groth16-flexible-kyc";
      let version: ZkStoredProof["version"] = 1;

      if (faceHash) {
        // commitment = Poseidon(dob_year, gender_code, witness_pincode, face_hash)
        // dob_year/gender/pincode are private in-circuit; only commitment is public.
        // We compute it here so the public signal is fixed and verifier can see binding exists.
        const dobYear = extractBirthYearFromDob(displayExtracted.dob);
        const genderCode = aadhaarGenderToCircuitCodeSync(displayExtracted.gender);
        const pincodeWitness = request.checks.includes("address")
          ? pickWitnessPincode(displayExtracted.address, request.constraints?.pincodes ?? [])
          : 0;
        const commitment = await poseidonHash([
          BigInt(dobYear),
          BigInt(genderCode),
          BigInt(pincodeWitness),
          BigInt(faceHash),
        ]);
        try {
          const res = await generateFlexibleKycCommitmentProof({
            dob: displayExtracted.dob,
            genderRaw: displayExtracted.gender,
            address: displayExtracted.address,
            checks: request.checks,
            constraints: request.constraints,
            anchorYear,
            faceHash,
            commitment,
            nonce: request.nonce ?? request.security?.nonce,
          });
          proof = res.proof;
          publicSignals = res.publicSignals;
          scheme = "groth16-flexible-kyc-commitment";
          version = 2;
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Commitment proof generation failed.";
          const isArtifactMissing = /Missing ZKP artifact/i.test(msg);
          if (isArtifactMissing) {
            // Non-blocking fallback: keep v1 proving working, but mark as suspicious because commitment binding was intended.
            setProofError(
              `${msg} Falling back to standard proof (we recommend re-running compile-flexible-kyc-commitment.ps1).`,
            );
            setRiskStatus("suspicious");
          } else {
            throw e;
          }
          const res = await generateFlexibleKycProof({
            dob: displayExtracted.dob,
            genderRaw: displayExtracted.gender,
            address: displayExtracted.address,
            checks: request.checks,
            constraints: request.constraints,
            anchorYear,
            nonce: request.nonce ?? request.security?.nonce,
          });
          proof = res.proof;
          publicSignals = res.publicSignals;
          scheme = "groth16-flexible-kyc";
          version = 1;
        }
      } else {
        const res = await generateFlexibleKycProof({
          dob: displayExtracted.dob,
          genderRaw: displayExtracted.gender,
          address: displayExtracted.address,
          checks: request.checks,
          constraints: request.constraints,
          anchorYear,
          nonce: request.nonce ?? request.security?.nonce,
        });
        proof = res.proof;
        publicSignals = res.publicSignals;
      }

      const payload: ZkStoredProof = {
        version,
        scheme,
        createdAt: Date.now(),
        nonce: request.nonce ?? request.security?.nonce,
        proof,
        publicSignals,
      };

      await update(ref(firebaseDb, `kycRequests/${request.requestId}/users/${sessionPhone}/proof`), payload);
      setProofOk("Proof generated and saved. The verifier can confirm it against the backend.");
    } catch (e) {
      setProofError(e instanceof Error ? e.message : "Proof generation failed.");
    } finally {
      setProofBusy(false);
    }
  };

  const faceMatchingUrl = useMemo(() => {
    if (typeof window === "undefined") return faceMatchingBaseUrl;
    // After logout (or completion), always return to prover launcher (not back to this sensitive flow page).
    const returnUrl = `${window.location.origin}/prover`;
    let resolvedBase = faceMatchingBaseUrl;
    try {
      const candidate = new URL(faceMatchingBaseUrl);
      // Prevent login-loop misrouting when configured URL points to the main app root.
      if (
        candidate.origin === window.location.origin &&
        (candidate.pathname === "/" || candidate.pathname === "")
      ) {
        resolvedBase = "http://localhost:3010";
      }
    } catch {
      resolvedBase = "http://localhost:3010";
    }
    const u = new URL(resolvedBase);
    u.searchParams.set("request_id", requestId);
    if (sessionPhone) u.searchParams.set("phone", sessionPhone);
    try {
      const raw = sessionStorage.getItem(STORAGE_KEYS.userSession) ?? localStorage.getItem(STORAGE_KEYS.userSession);
      if (raw) {
        const token = btoa(unescape(encodeURIComponent(raw)))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
        u.searchParams.set("session_token", token);
      }
    } catch {
      // ignore storage encoding failures
    }
    u.searchParams.set("return_url", returnUrl);
    u.searchParams.set("source", "kyc");
    return u.toString();
  }, [faceMatchingBaseUrl, requestId, sessionPhone]);

  return (
    <main className="min-h-screen surface">
      <div className="pointer-events-none absolute -top-52 left-1/2 h-[520px] w-[980px] -translate-x-1/2 rounded-full glow-orb opacity-80" />
      <div className="pointer-events-none absolute inset-0 noise" />

      <div className="relative mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
        <header className="mb-10 space-y-3">
          <div className="inline-flex w-fit items-center gap-2 rounded-full border border-slate-800 bg-slate-950/40 px-4 py-1 text-xs font-semibold uppercase tracking-[0.22em] text-slate-200 shadow-soft">
            Zerify • User KYC
          </div>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-50 md:text-4xl">
            KYC request {requestId}
          </h1>
          <p className="text-base text-slate-300">
            Verifier: <span className="font-semibold text-slate-100">{request?.verifier.name ?? "—"}</span>
          </p>
          <p className="text-base text-slate-300">
            Purpose:{" "}
            <span className="font-semibold text-slate-100">{request?.purpose ?? "—"}</span>
          </p>
        </header>

        {!sessionPhone ? (
          <section className="rounded-[2rem] border border-slate-800 bg-slate-950/40 p-8 shadow-soft">
            <h2 className="text-xl font-semibold text-slate-50">Login required</h2>
            <p className="mt-2 text-sm text-slate-300">
              Please login as user first so we can show your specific requests.
            </p>
            <a className="btn-primary shimmer inline-flex rounded-2xl px-6 py-4 text-base font-semibold text-slate-950 mt-5" href="/user/login">
              Go to user login
            </a>
          </section>
        ) : !indexFetched ? (
          <section className="rounded-[2rem] border border-slate-800 bg-slate-950/40 p-8 shadow-soft">
            <div className="flex items-center gap-3 text-slate-300">
              <Spinner />
              <span>Loading request…</span>
            </div>
            <p className="mt-3 text-sm text-slate-400">
              Checking Firebase for your invitation under this phone number and request ID.
            </p>
          </section>
        ) : indexLoadError && !request ? (
          <section className="rounded-[2rem] border border-rose-400/30 bg-rose-500/10 p-8 shadow-soft">
            <h2 className="text-xl font-semibold text-rose-100">Can’t open this request</h2>
            <p className="mt-2 text-sm text-rose-100/80">{indexLoadError}</p>
            <p className="mt-4 text-xs text-rose-200/70">
              If you recently changed Firebase rules, provers must be allowed to read{" "}
              <code className="rounded bg-black/20 px-1">kycRequests</code> — see{" "}
              <code className="rounded bg-black/20 px-1">FIREBASE_RTDB_RULES.md</code>.
            </p>
            <a
              href="/prover"
              className="btn-primary shimmer mt-6 inline-flex rounded-2xl px-6 py-3 text-sm font-semibold text-slate-950"
            >
              Back to dashboard
            </a>
          </section>
        ) : !request ? (
          <section className="rounded-[2rem] border border-slate-800 bg-slate-950/40 p-8 shadow-soft">
            <p className="text-slate-300">Could not load request data.</p>
            <a href="/prover" className="mt-4 inline-block text-sky-300 hover:underline">
              Back to dashboard
            </a>
          </section>
        ) : !myUserState ? (
          <section className="rounded-[2rem] border border-rose-400/30 bg-rose-500/10 p-8 shadow-soft">
            <h2 className="text-xl font-semibold text-rose-100">Request not found for this phone</h2>
            <p className="mt-2 text-sm text-rose-100/80">
              Your logged-in phone ({sessionPhone}) isn’t part of this KYC request.
            </p>
          </section>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[1fr_0.95fr]">
            <section className="gradient-border">
              <div className="card-glass rounded-[2rem] border border-slate-800/70 p-7 shadow-soft">
                <h2 className="text-xl font-semibold text-slate-50">Upload Aadhaar QR</h2>
                <p className="mt-2 text-sm text-slate-300">
                  Image stays in your browser. We decode the secure QR and verify the UIDAI signature using the public certificate chain.
                </p>

                <div className="mt-6 rounded-2xl border border-slate-800 bg-slate-950/30 p-5">
                  <h3 className="text-sm font-semibold text-slate-100">Progress</h3>
                  <div className="mt-3 grid gap-2">
                    <StatusRow
                      label="QR detection + UIDAI signature"
                      tone={uidaiValid === null ? "pending" : uidaiValid ? "ok" : "error"}
                      busy={busy && uidaiValid === null}
                    />
                    <StatusRow
                      label="Extract + check conditions"
                      tone={checksResult === null ? "pending" : checksResult.reason ? "error" : "ok"}
                      busy={busy && checksResult === null}
                    />
                  </div>

                  {checksResult?.reason ? (
                    <div className="mt-4 rounded-2xl border border-rose-400/30 bg-rose-500/10 p-4 text-sm text-rose-100">
                      {checksResult.reason}
                    </div>
                  ) : null}

                  {scanMethod ? (
                    <div className="mt-4 rounded-2xl border border-sky-400/30 bg-sky-500/10 p-4 text-sm text-sky-100">
                      QR detected successfully ({scanMethod}).
                    </div>
                  ) : null}

                  {uidaiValid === true && displayExtracted ? (
                    <div className="mt-4 rounded-2xl border border-emerald-400/35 bg-emerald-500/10 p-5 text-sm text-emerald-50">
                      <div className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-200/90">
                        UIDAI signature verified — extracted fields (local only)
                      </div>
                      <dl className="mt-3 grid gap-2 text-slate-100">
                        <div>
                          <dt className="text-xs text-emerald-200/80">Name</dt>
                          <dd className="font-medium">{displayExtracted.name}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-emerald-200/80">Date of birth</dt>
                          <dd className="font-medium">{displayExtracted.dob}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-emerald-200/80">Gender</dt>
                          <dd className="font-medium">{displayExtracted.gender}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-emerald-200/80">Address</dt>
                          <dd className="leading-relaxed">{displayExtracted.address}</dd>
                        </div>
                      </dl>
                    </div>
                  ) : null}
                </div>

                <div className="mt-6 rounded-2xl border border-slate-800 bg-slate-950/30 p-5">
                  <div className="space-y-4">
                    <div className="space-y-1">
                      <div className="text-sm font-semibold text-slate-100">Aadhaar image source</div>
                      <div className="text-sm text-slate-400">{fileName || "Upload or capture an image"}</div>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="btn-primary shimmer inline-flex cursor-pointer items-center justify-center rounded-2xl px-6 py-3 text-sm font-semibold text-slate-950 shadow-[0_12px_48px_rgba(56,189,248,0.22)]">
                        Upload Image
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/jpg,image/*"
                          className="sr-only"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            void handleUpload(file);
                          }}
                        />
                      </label>
                      <button
                        type="button"
                        className="rounded-2xl border border-slate-700 bg-slate-900/40 px-6 py-3 text-sm font-semibold text-slate-100 hover:border-slate-600 disabled:opacity-50"
                        onClick={() => void startCamera()}
                        disabled={cameraBusy || cameraOpen}
                      >
                        {cameraBusy ? "Opening camera…" : "Capture Image"}
                      </button>
                    </div>

                    {cameraOpen ? (
                      <div className="space-y-3 rounded-2xl border border-slate-700 bg-slate-900/40 p-4">
                        <video
                          ref={videoRef}
                          className="h-auto max-h-80 w-full rounded-xl bg-black object-contain"
                          playsInline
                          muted
                          autoPlay
                        />
                        <div className="grid gap-3 sm:grid-cols-2">
                          <button
                            type="button"
                            className="btn-primary shimmer rounded-2xl px-5 py-3 text-sm font-semibold text-slate-950"
                            onClick={() => void captureImage()}
                          >
                            Capture
                          </button>
                          <button
                            type="button"
                            className="rounded-2xl border border-slate-700 bg-slate-900/50 px-5 py-3 text-sm font-semibold text-slate-100 hover:border-slate-600"
                            onClick={stopCamera}
                          >
                            Close Camera
                          </button>
                        </div>
                      </div>
                    ) : null}

                    {previewUrl ? (
                      <div className="space-y-2 rounded-2xl border border-slate-700 bg-slate-900/30 p-3">
                        <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">
                          Preview
                        </div>
                        <img
                          src={previewUrl}
                          alt="Selected Aadhaar preview"
                          className="h-auto max-h-72 w-full rounded-xl object-contain"
                        />
                      </div>
                    ) : null}
                  </div>
                </div>

                {myUserState?.proof ? (
                  <div className="mt-5 rounded-2xl border border-sky-400/30 bg-sky-500/10 p-4 text-sm text-sky-100">
                    A Groth16 proof is already stored for this request. The verifier can run backend verification.
                  </div>
                ) : null}

                {proofError ? (
                  <div className="mt-4 rounded-2xl border border-rose-400/30 bg-rose-500/10 p-4 text-sm text-rose-100">
                    {proofError}
                  </div>
                ) : null}
                {proofOk ? (
                  <div className="mt-4 rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-4 text-sm text-emerald-100">
                    {proofOk}
                  </div>
                ) : null}

                <div className="mt-6 grid gap-3">
                  <div className="rounded-[2rem] border border-slate-800 bg-slate-950/40 p-6 shadow-soft">
                    <div className="text-sm font-semibold text-slate-100">Face matching (separate local app)</div>
                    <div className="mt-1 text-sm text-slate-300">
                      Aadhaar QR verification and KYC checks continue here. Liveness + 5-frame face matching runs in your dedicated
                      <code className="rounded bg-black/20 px-1">face_matching</code> frontend.
                    </div>
                    <div className="mt-4">
                      <a
                        href={faceMatchingUrl}
                        className="btn-primary shimmer inline-flex rounded-2xl px-5 py-3 text-sm font-semibold text-slate-950"
                      >
                        Open Face Matching App
                      </a>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4 text-sm text-slate-200">
                    <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">
                      Face verification status
                    </div>
                    <div className="mt-1 font-semibold">
                      {faceVerificationPassed ? "verified" : "pending"}
                    </div>
                    <div className="mt-2 text-xs text-slate-400">
                      {faceVerificationPassed
                        ? "Face verification callback received from Face Matching App."
                        : "Open Face Matching App, complete liveness + 5-frame comparison, then return here."}
                    </div>
                    {request.security?.requireCommitment ? (
                      <div className="mt-2 text-xs text-amber-200">
                        Commitment proof requires face verification to be marked verified.
                      </div>
                    ) : null}
                  </div>

                  <button
                    type="button"
                    disabled
                    title="Proof flow moved to Face Matching App"
                    className="btn-primary shimmer rounded-2xl px-6 py-4 text-base font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Generate proof & send to verifier (moved)
                  </button>
                  <p className="text-center text-xs text-amber-200/90">
                    Complete the entire flow in Face Matching App. Proof submission from this page is disabled.
                  </p>
                  <p className="text-center text-xs text-slate-500">
                    One Groth16 proof covers every check on this request. Ensure{" "}
                    <code className="rounded bg-black/25 px-1">scripts/compile-flexible-kyc.ps1</code> has been run so{" "}
                    <code className="rounded bg-black/25 px-1">public/zkp/flexibleKyc</code> artifacts exist.
                  </p>
                  <button
                    type="button"
                    onClick={() => router.push("/prover")}
                    className="rounded-2xl border border-slate-800 bg-slate-950/25 px-6 py-4 text-base font-semibold text-slate-100 hover:border-slate-700"
                  >
                    Back to dashboard
                  </button>
                </div>
              </div>
            </section>

            <aside className="rounded-[2rem] border border-slate-800 bg-slate-950/40 p-7 shadow-soft">
              <h2 className="text-xl font-semibold text-slate-50">Request requirements</h2>
              <div className="mt-4 flex flex-wrap gap-2">
                {constraintsSummary.length ? (
                  constraintsSummary.map((it) => (
                    <Pill key={it}>{it}</Pill>
                  ))
                ) : (
                  <span className="text-sm text-slate-300">—</span>
                )}
              </div>

              <div className="mt-6 rounded-2xl border border-slate-800 bg-slate-950/30 p-5 text-sm text-slate-300">
                <div className="text-sm font-semibold text-slate-100">Verifier decision</div>
                <div className="mt-3 grid gap-2">
                  <div className="flex items-center justify-between">
                    <span>Age</span>
                    <span className="text-slate-300">
                      {myUserState.verification.ageVerified === null ? "pending" : myUserState.verification.ageVerified ? "verified" : "failed"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Gender</span>
                    <span className="text-slate-300">
                      {myUserState.verification.genderVerified === null ? "pending" : myUserState.verification.genderVerified ? "verified" : "failed"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Address</span>
                    <span className="text-slate-300">
                      {myUserState.verification.addressVerified === null ? "pending" : myUserState.verification.addressVerified ? "verified" : "failed"}
                    </span>
                  </div>
                </div>
              </div>
            </aside>
          </div>
        )}
      </div>
    </main>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-slate-800 bg-slate-950/30 px-4 py-2 text-xs font-semibold text-slate-200">
      {children}
    </span>
  );
}

