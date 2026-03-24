"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { get, onValue, ref, update } from "firebase/database";
import { firebaseDb } from "@/lib/firebaseClient";
import { gendersMatch } from "@/lib/genderNormalize";
import { decodeQrFromFile } from "@/utils/qrDecoder";
import { verifyAadhaarSecureQr } from "@/utils/aadhaarVerifier";
import { generateFlexibleKycProof } from "@/utils/flexibleKycProof";
import { kycAnchorYearUtc } from "@/utils/flexibleKycWitness";

type VerificationType = "age" | "gender" | "address";

type KycConstraints = {
  minAge: number;
  requiredGender: "Male" | "Female" | "Other" | "";
  pincodes: string[];
};

type ZkStoredProof = {
  version: 1;
  scheme: "groth16-flexible-kyc";
  createdAt: number;
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
};

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
      <span>{label}</span>
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

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.userSession);
      if (raw) {
        const parsed = JSON.parse(raw) as { phone: string };
        setSessionPhone(parsed.phone);
      }
    } catch {
      setSessionPhone(null);
    }
  }, []);

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

  const startProcessing = async (file: File) => {
    setError(null);
    setBusy(true);
    setUidaiValid(null);
    setChecksResult(null);
    setExtractedFields(null);

    try {
      const payload = await decodeQrFromFile(file);
      if (!payload) throw new Error("No readable QR found.");

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

      setExtractedFields({
        name: name ?? "—",
        dob,
        gender,
        address,
      });

      const age = computeAgeFromDob(dob);

      const ageActive = request?.checks.includes("age");
      const genderActive = request?.checks.includes("gender");
      const addressActive = request?.checks.includes("address");

      const agePass = ageActive ? age.age >= (request?.constraints.minAge ?? 18) : undefined;
      const genderPass =
        genderActive && request?.constraints.requiredGender
          ? gendersMatch(gender, request.constraints.requiredGender)
          : undefined;
      const addressPass =
        addressActive && request?.constraints.pincodes.length
          ? addressMatchesAnyAllowedPincode(address, request.constraints.pincodes)
          : undefined;

      let reason: string | undefined;
      if (ageActive && agePass === false) reason = `Age requirement not met (need ≥ ${request?.constraints.minAge ?? 18}).`;
      if (!reason && genderActive && genderPass === false) reason = "Gender mismatch.";
      if (!reason && addressActive && addressPass === false) reason = "Address not in allowed region (pincode mismatch).";

      setChecksResult({
        agePass,
        genderPass,
        addressPass,
        reason: reason ?? undefined,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Processing failed.");
    } finally {
      setBusy(false);
    }
  };

  const canSubmitZk =
    Boolean(request) &&
    uidaiValid === true &&
    extractedFields &&
    checksResult &&
    !checksResult.reason &&
    sessionPhone;

  const handleSubmitZkProof = async () => {
    if (!request || !sessionPhone || !extractedFields) return;
    setProofError(null);
    setProofOk(null);
    setProofBusy(true);
    try {
      const anchorYear = kycAnchorYearUtc(request.createdAt);
      const { proof, publicSignals } = await generateFlexibleKycProof({
        dob: extractedFields.dob,
        genderRaw: extractedFields.gender,
        address: extractedFields.address,
        checks: request.checks,
        constraints: request.constraints,
        anchorYear,
      });

      const payload: ZkStoredProof = {
        version: 1,
        scheme: "groth16-flexible-kyc",
        createdAt: Date.now(),
        proof,
        publicSignals,
      };

      await update(ref(firebaseDb, `kycRequests/${request.requestId}/users/${sessionPhone}`), {
        proof: payload,
      });
      setProofOk("Proof generated and saved. The verifier can confirm it against the backend.");
    } catch (e) {
      setProofError(e instanceof Error ? e.message : "Proof generation failed.");
    } finally {
      setProofBusy(false);
    }
  };

  return (
    <main className="min-h-screen surface">
      <div className="pointer-events-none absolute -top-52 left-1/2 h-[520px] w-[980px] -translate-x-1/2 rounded-full glow-orb opacity-80" />
      <div className="pointer-events-none absolute inset-0 noise" />

      <div className="relative mx-auto w-full max-w-5xl px-6 py-14">
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
                  <label className="flex cursor-pointer items-center justify-between gap-4">
                    <div className="space-y-1">
                      <div className="text-sm font-semibold text-slate-100">QR image</div>
                      <div className="text-sm text-slate-400">{fileName || "PNG/JPG"}</div>
                    </div>
                    <span className="btn-primary shimmer rounded-2xl px-6 py-3 text-sm font-semibold text-slate-950 shadow-[0_12px_48px_rgba(56,189,248,0.22)]">
                      Choose file
                    </span>
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/jpg"
                      className="sr-only"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        setFileName(file.name);
                        void startProcessing(file);
                      }}
                    />
                  </label>
                </div>

                <div className="mt-6 rounded-2xl border border-slate-800 bg-slate-950/30 p-5">
                  <h3 className="text-sm font-semibold text-slate-100">Progress</h3>
                  <div className="mt-3 grid gap-2">
                    <StatusRow
                      label="UIDAI signature"
                      tone={uidaiValid === null ? "pending" : uidaiValid ? "ok" : "error"}
                      busy={busy && uidaiValid === null}
                    />
                    <StatusRow
                      label="Extract + check conditions"
                      tone={checksResult === null ? "pending" : checksResult.reason ? "error" : "ok"}
                      busy={busy && checksResult === null}
                    />
                  </div>
                </div>

                {checksResult?.reason ? (
                  <div className="mt-5 rounded-2xl border border-rose-400/30 bg-rose-500/10 p-4 text-sm text-rose-100">
                    {checksResult.reason}
                  </div>
                ) : null}

                {uidaiValid === true && extractedFields ? (
                  <div className="mt-5 rounded-2xl border border-emerald-400/35 bg-emerald-500/10 p-5 text-sm text-emerald-50">
                    <div className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-200/90">
                      UIDAI signature verified — extracted fields (local only)
                    </div>
                    <dl className="mt-3 grid gap-2 text-slate-100">
                      <div>
                        <dt className="text-xs text-emerald-200/80">Name</dt>
                        <dd className="font-medium">{extractedFields.name}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-emerald-200/80">Date of birth</dt>
                        <dd className="font-medium">{extractedFields.dob}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-emerald-200/80">Gender</dt>
                        <dd className="font-medium">{extractedFields.gender}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-emerald-200/80">Address</dt>
                        <dd className="leading-relaxed">{extractedFields.address}</dd>
                      </div>
                    </dl>
                  </div>
                ) : null}

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
                  <button
                    type="button"
                    disabled={!canSubmitZk || proofBusy || Boolean(myUserState?.proof)}
                    title={
                      !canSubmitZk
                        ? "Complete UIDAI verification and satisfy all requested checks first."
                        : myUserState?.proof
                          ? "Proof already submitted."
                          : undefined
                    }
                    onClick={() => void handleSubmitZkProof()}
                    className="btn-primary shimmer rounded-2xl px-6 py-4 text-base font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {proofBusy ? "Generating proof…" : "Generate proof & send to verifier"}
                  </button>
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

