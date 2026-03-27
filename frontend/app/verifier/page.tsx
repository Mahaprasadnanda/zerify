"use client";

import { useEffect, useMemo, useState } from "react";
import {
  signInWithEmailAndPassword,
  signOut,
  type User as FirebaseUser,
} from "firebase/auth";
import { onValue, ref, set, update } from "firebase/database";
import { firebaseAuth, firebaseAuthPersistenceReady, firebaseDb } from "@/lib/firebaseClient";
import { verifyProof } from "@/lib/api";
import { onAuthStateChanged } from "firebase/auth";

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
  risk?: {
    status?: "verified" | "suspicious" | "matched" | "mismatch";
    faceMatchStatus?: "matched" | "suspicious" | "mismatch";
    /** L2 distance vs Aadhaar portrait (primary when present). */
    aadhaarFaceDistance?: number | null;
    cosineSimilarity?: number | null;
    /** Max allowed distance for “same person” (lower is stricter). */
    threshold?: number;
    infraUnavailable?: boolean | null;
    liveness?: {
      status?: "pass" | "fail";
      blink?: boolean;
      headLeft?: boolean;
      headRight?: boolean;
    };
    updatedAt?: number;
  };
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

function generateNonceBase64Url(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]!);
  const b64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return b64;
}

function defaultEmptyUserState(): KycUserState {
  return {
    proof: null,
    risk: {
      status: undefined,
      aadhaarFaceDistance: null,
      cosineSimilarity: null,
      threshold: 0.65,
      infraUnavailable: null,
      liveness: {},
      updatedAt: undefined,
    },
    verification: {
      ageVerified: null,
      genderVerified: null,
      addressVerified: null,
      verifiedAtByAttribute: {},
    },
  };
}

/** RTDB may omit `verification` when only `proof` was written — merge with defaults. */
function normalizeUserState(raw: Partial<KycUserState> | null | undefined): KycUserState {
  const base = defaultEmptyUserState();
  if (!raw) return base;
  const v = raw.verification;
  const r = raw.risk;
  return {
    proof: raw.proof ?? null,
    risk: {
      status: r?.status,
      faceMatchStatus: r?.faceMatchStatus,
      aadhaarFaceDistance: typeof r?.aadhaarFaceDistance === "number" ? r?.aadhaarFaceDistance : null,
      cosineSimilarity: typeof r?.cosineSimilarity === "number" ? r?.cosineSimilarity : null,
      threshold: typeof r?.threshold === "number" ? r?.threshold : 0.65,
      infraUnavailable: r?.infraUnavailable ?? null,
      liveness: {
        status: r?.liveness?.status,
        blink: r?.liveness?.blink,
        headLeft: r?.liveness?.headLeft,
        headRight: r?.liveness?.headRight,
      },
      updatedAt: r?.updatedAt,
    },
    verification: {
      ageVerified: v?.ageVerified ?? null,
      genderVerified: v?.genderVerified ?? null,
      addressVerified: v?.addressVerified ?? null,
      verifiedAtByAttribute: v?.verifiedAtByAttribute ?? {},
    },
  };
}

const INDICES = {
  user: (phone: string) => `indices/userRequests/${phone}`,
  verifier: (uid: string) => `indices/verifierRequests/${uid}`,
} as const;

function normalizeToE164India(raw: string): string {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.startsWith("91") && digits.length === 12) return `+${digits}`;
  if (raw.trim().startsWith("+")) return raw.trim();
  throw new Error("Invalid phone number");
}

function parseMobiles(value: string): { valid: string[]; invalid: string[] } {
  const rawList = value
    .split(/[,\n]/g)
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => v.replace(/\s+/g, ""));

  const valid: string[] = [];
  const invalid: string[] = [];

  for (const raw of rawList) {
    try {
      valid.push(normalizeToE164India(raw));
    } catch {
      invalid.push(raw);
    }
  }

  return { valid, invalid };
}

function createRequestId() {
  return `REQ-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Date.now().toString().slice(-4)}`;
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-slate-800 bg-slate-950/35 px-3 py-1 text-xs font-semibold text-slate-200">
      {children}
    </span>
  );
}

function AttrBadge({ status }: { status: "verified" | "not-verified" | "pending" }) {
  const cls =
    status === "verified"
      ? "border-emerald-400/35 bg-emerald-500/10 text-emerald-100"
      : status === "not-verified"
        ? "border-rose-400/30 bg-rose-500/10 text-rose-100"
        : "border-slate-800 bg-slate-950/40 text-slate-300";
  return <span className={`inline-flex rounded-2xl border px-3 py-1 text-xs font-semibold ${cls}`}>{status}</span>;
}

function isGroth16FlexibleKycScheme(
  scheme: string | undefined,
): scheme is ZkStoredProof["scheme"] {
  return scheme === "groth16-flexible-kyc" || scheme === "groth16-flexible-kyc-commitment";
}

function RiskBadge({ status }: { status: "verified" | "suspicious" | "matched" | "mismatch" | "unknown" }) {
  const cls =
    status === "verified" || status === "matched"
      ? "border-emerald-400/35 bg-emerald-500/10 text-emerald-100"
      : status === "suspicious"
        ? "border-amber-400/35 bg-amber-500/10 text-amber-100"
        : status === "mismatch"
          ? "border-rose-400/35 bg-rose-500/10 text-rose-100"
        : "border-slate-800 bg-slate-950/40 text-slate-300";
  return <span className={`inline-flex rounded-2xl border px-3 py-1 text-xs font-semibold ${cls}`}>{status}</span>;
}

function safeNameFromEmail(email: string) {
  const part = email.split("@")[0] || "Verifier";
  return part.slice(0, 30);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export default function VerifierPage() {
  const [authUser, setAuthUser] = useState<FirebaseUser | null>(null);
  const [showLogin, setShowLogin] = useState(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);

  const [checks, setChecks] = useState<Record<VerificationType, boolean>>({
    age: true,
    gender: false,
    address: false,
  });
  const selectedChecks = useMemo(
    () => (Object.keys(checks) as VerificationType[]).filter((k) => checks[k]),
    [checks],
  );

  const [minAge, setMinAge] = useState(18);
  const [requiredGender, setRequiredGender] = useState<KycConstraints["requiredGender"]>("");
  const [purpose, setPurpose] = useState("");
  const [requireCommitment, setRequireCommitment] = useState(false);
  const [pincodeInput, setPincodeInput] = useState("");
  const [pincodes, setPincodes] = useState<string[]>([]);
  const [mobilesInput, setMobilesInput] = useState("");
  const parsedMobiles = useMemo(() => parseMobiles(mobilesInput), [mobilesInput]);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendSuccess, setSendSuccess] = useState<string | null>(null);
  const [sendStage, setSendStage] = useState<string | null>(null);
  const [verifyBusyPhone, setVerifyBusyPhone] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteSuccess, setDeleteSuccess] = useState<string | null>(null);

  const [requestIds, setRequestIds] = useState<string[]>([]);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);

  const [request, setRequest] = useState<KycRequest | null>(null);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    void firebaseAuthPersistenceReady.then(() => {
      unsub = onAuthStateChanged(firebaseAuth, (u) => setAuthUser(u));
    });
    return () => unsub?.();
  }, []);

  /** After logout, browser “back” can restore a cached page with stale React state — resync with Firebase. */
  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) {
        setAuthUser(firebaseAuth.currentUser);
      }
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  useEffect(() => {
    if (!authUser) return;
    const idxRef = ref(firebaseDb, INDICES.verifier(authUser.uid));
    return onValue(idxRef, (snap) => {
      const val = snap.val() as Record<string, unknown> | null;
      const ids = val ? Object.keys(val) : [];
      setRequestIds(ids.sort((a, b) => b.localeCompare(a)));
    });
  }, [authUser]);

  useEffect(() => {
    if (!selectedRequestId) {
      setRequest(null);
      return;
    }
    setVerifyError(null);
    const rRef = ref(firebaseDb, `kycRequests/${selectedRequestId}`);
    return onValue(rRef, (snap) => {
      setRequest(snap.val() as KycRequest | null);
    });
  }, [selectedRequestId]);

  const canSend =
    authUser &&
    selectedChecks.length > 0 &&
    purpose.trim().length > 0 &&
    parsedMobiles.valid.length > 0 &&
    parsedMobiles.invalid.length === 0 &&
    (!checks.age || minAge >= 1) &&
    (!checks.gender || requiredGender !== "") &&
    (!checks.address || pincodes.length > 0);

  const handleLogin = async () => {
    setLoginError(null);
    try {
      await firebaseAuthPersistenceReady;
      const res = await signInWithEmailAndPassword(firebaseAuth, email, password);
      setAuthUser(res.user);
      setShowLogin(false);
    } catch (e) {
      setLoginError(e instanceof Error ? e.message : "Login failed");
    }
  };

  const handleVerifierLogout = async () => {
    try {
      await firebaseAuthPersistenceReady;
      await signOut(firebaseAuth);
    } catch {
      // still clear UI even if signOut throws
    }
    setEmail("");
    setPassword("");
    setShowLogin(false);
    setLoginError(null);
    setSelectedRequestId(null);
    setRequest(null);
    setRequestIds([]);
    setAuthUser(null);
    // Full navigation replaces history so “Back” does not return to a cached logged-in dashboard.
    window.location.replace("/verifier");
  };

  const handleSendRequest = async () => {
    if (!authUser) return;
    setSendError(null);
    setSendSuccess(null);
    setSending(true);
    setSendStage("Preparing request...");
    try {
      const phoneNumbers = parsedMobiles.valid;
      if (phoneNumbers.length === 0) {
        throw new Error("Enter at least one valid mobile number.");
      }
      if (parsedMobiles.invalid.length > 0) {
        throw new Error(
          `Invalid mobile number(s): ${parsedMobiles.invalid.join(", ")}. Use 10-digit India numbers or +91 format.`,
        );
      }
      const requestId = createRequestId();
      const verifierEmail = authUser.email ?? email.trim();
      const nonce = generateNonceBase64Url(16);
      const payload: KycRequest = {
        requestId,
        nonce,
        verifier: {
          uid: authUser.uid,
          email: verifierEmail,
          name: safeNameFromEmail(verifierEmail),
        },
        checks: selectedChecks,
        constraints: {
          minAge,
          requiredGender: requiredGender,
          pincodes,
        },
        purpose: purpose.trim(),
        security: { requireCommitment, nonce },
        createdAt: Date.now(),
        users: Object.fromEntries(
          phoneNumbers.map((p) => [
            p,
            {
              proof: null,
              verification: {
                ageVerified: null,
                genderVerified: null,
                addressVerified: null,
                verifiedAtByAttribute: {},
              },
            } satisfies KycUserState,
          ]),
        ) as Record<string, KycUserState>,
      };

      // 1) Store canonical request in RTDB
      setSendStage("Saving request...");
      await withTimeout(
        set(ref(firebaseDb, `kycRequests/${requestId}`), payload),
        15000,
        "Saving request",
      );

      // 2) Store user indices (so prover sees this request under their phone)
      setSendStage("Saving recipients...");
      await withTimeout(
        Promise.all(
        phoneNumbers.map((phone) =>
          set(ref(firebaseDb, `${INDICES.user(phone)}/${requestId}`), {
            requestId,
            createdAt: payload.createdAt,
            verifierName: payload.verifier.name,
            checks: payload.checks,
            constraints: payload.constraints,
            purpose: payload.purpose,
            security: payload.security,
            nonce: payload.nonce,
          }),
        ),
        ),
        15000,
        "Saving recipients",
      );

      // 3) Store verifier index (so dashboard lists this request)
      setSendStage("Updating dashboard...");
      await withTimeout(
        set(ref(firebaseDb, `${INDICES.verifier(authUser.uid)}/${requestId}`), {
          requestId,
          createdAt: payload.createdAt,
        }),
        15000,
        "Updating dashboard",
      );

      // 4) Recipient registry (digits-only key) — prover lists requests via indices/userRequests; this keeps a simple phone record for ops / future SMS.
      setSendStage("Saving recipient records...");
      await withTimeout(
        Promise.all(
          phoneNumbers.map((phone) => {
            const phoneDigits = phone.replace(/\D/g, "");
            return set(ref(firebaseDb, `recipientProfiles/${phoneDigits}`), {
              phoneE164: phone,
              updatedAt: payload.createdAt,
            });
          }),
        ),
        15000,
        "Saving recipient records",
      );

      setMobilesInput("");
      setPincodes([]);
      setPincodeInput("");
      setPurpose("");
      setRequireCommitment(false);
      setSendSuccess(
        `Request ${requestId} saved. Recipients can open it from their prover dashboard after logging in with the same number (no SMS for now).`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to send request";
      const isTimeout = /timed out/i.test(msg);
      setSendError(
        isTimeout
          ? `${msg} — Check Firebase Console → Realtime Database → Rules: allow authenticated write/read on kycRequests and indices (see FIREBASE_RTDB_RULES.md).`
          : msg,
      );
    } finally {
      setSending(false);
      setSendStage(null);
    }
  };

  const handleVerifyZkProof = async (phone: string) => {
    if (!authUser || !request) return;
    const userState = normalizeUserState(request.users?.[phone]);
    const zk = userState.proof;
    setVerifyError(null);
    if (!zk || (zk.scheme !== "groth16-flexible-kyc" && zk.scheme !== "groth16-flexible-kyc-commitment")) {
      setVerifyError("No Groth16 proof on file for this recipient.");
      return;
    }

    setVerifyBusyPhone(phone);
    const now = Date.now();
    const prevTimes = userState.verification.verifiedAtByAttribute || {};

    try {
      const res = await verifyProof({
        proof: zk.proof,
        publicSignals: zk.publicSignals,
        scheme: zk.scheme,
        nonce: zk.nonce ?? request.nonce ?? request.security?.nonce ?? null,
        requestContext: {
          createdAt: request.createdAt,
          checks: request.checks,
          constraints: {
            minAge: request.constraints.minAge,
            requiredGender: request.constraints.requiredGender,
            pincodes: request.constraints.pincodes,
          },
          security: {
            requireCommitment: Boolean(request.security?.requireCommitment),
            nonce: request.nonce ?? request.security?.nonce ?? null,
          },
        },
      });

      // End “Verifying…” as soon as the API responds. Firebase `update` can hang (offline, rules),
      // and previously blocked `finally`, leaving the button stuck forever.
      setVerifyBusyPhone(null);

      const toUpdate: Partial<KycUserState["verification"]> = {
        verifiedAtByAttribute: { ...prevTimes },
      };

      const ok = res.verified;
      if (request.checks.includes("age")) {
        toUpdate.ageVerified = ok;
        if (ok) toUpdate.verifiedAtByAttribute!.age = now;
      }
      if (request.checks.includes("gender")) {
        toUpdate.genderVerified = ok;
        if (ok) toUpdate.verifiedAtByAttribute!.gender = now;
      }
      if (request.checks.includes("address")) {
        toUpdate.addressVerified = ok;
        if (ok) toUpdate.verifiedAtByAttribute!.address = now;
      }

      try {
        await withTimeout(
          update(
            ref(firebaseDb, `kycRequests/${request.requestId}/users/${phone}/verification`),
            toUpdate,
          ),
          20000,
          "Saving verification to Firebase",
        );
      } catch (firebaseErr) {
        setVerifyError(
          firebaseErr instanceof Error
            ? `${firebaseErr.message} — Proof was verified on the server; refresh after fixing connectivity or rules.`
            : "Could not save verification status to Firebase.",
        );
      }

      if (!ok) {
        setVerifyError(res.message || "Backend rejected the proof.");
      }
    } catch (e) {
      setVerifyError(e instanceof Error ? e.message : "Verification request failed.");
    } finally {
      setVerifyBusyPhone(null);
    }
  };

  const handleDeleteRequest = async () => {
    if (!authUser || !request) return;
    if (request.verifier.uid !== authUser.uid) {
      setDeleteError("Only the request owner can delete this KYC request.");
      return;
    }
    const confirmed = window.confirm(
      `Delete request ${request.requestId}? This will remove the request and recipient indices.`,
    );
    if (!confirmed) return;

    setDeleteError(null);
    setDeleteSuccess(null);
    setDeleteBusy(true);
    try {
      const updates: Record<string, null> = {
        [`kycRequests/${request.requestId}`]: null,
        [`${INDICES.verifier(authUser.uid)}/${request.requestId}`]: null,
      };
      for (const phone of Object.keys(request.users ?? {})) {
        updates[`${INDICES.user(phone)}/${request.requestId}`] = null;
      }
      await withTimeout(update(ref(firebaseDb), updates), 20000, "Deleting KYC request");
      setDeleteSuccess(`Request ${request.requestId} deleted.`);
      setSelectedRequestId(null);
      setRequest(null);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Failed to delete request.");
    } finally {
      setDeleteBusy(false);
    }
  };

  if (!authUser) {
    return (
      <main className="min-h-screen surface">
        <div className="pointer-events-none absolute -top-52 left-1/2 h-[520px] w-[980px] -translate-x-1/2 rounded-full glow-orb opacity-80" />
        <div className="pointer-events-none absolute inset-0 noise" />
        <div className="relative mx-auto w-full max-w-4xl px-6 py-16">
          <section className="gradient-border">
            <div className="card-glass rounded-[2rem] border border-slate-800/70 p-8 shadow-soft md:p-10">
              <h1 className="text-3xl font-semibold tracking-tight text-slate-50">Verifier login</h1>
              <p className="mt-3 text-base leading-7 text-slate-300">
                Sign in with email/password to create and verify KYC requests.
              </p>

              <div className="mt-6 grid gap-4">
                <button
                  className="btn-primary shimmer rounded-2xl px-6 py-4 text-base font-semibold text-slate-950"
                  onClick={() => setShowLogin(true)}
                >
                  Login as Verifier
                </button>
                <a
                  className="rounded-2xl border border-slate-800 bg-slate-950/30 px-6 py-4 text-center text-base font-semibold text-slate-100 hover:border-slate-700"
                  href="/"
                >
                  Back to home
                </a>
              </div>

              {showLogin ? (
                <div className="mt-6 rounded-2xl border border-slate-800 bg-slate-950/30 p-6">
                  <div className="grid gap-3">
                    <label className="grid gap-2">
                      <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Email</span>
                      <input
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="w-full rounded-2xl border border-slate-800 bg-slate-950/40 px-4 py-3 text-base text-slate-100 outline-none focus:ring-2 focus:ring-sky-400/30"
                      />
                    </label>
                    <label className="grid gap-2">
                      <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Password</span>
                      <input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="w-full rounded-2xl border border-slate-800 bg-slate-950/40 px-4 py-3 text-base text-slate-100 outline-none focus:ring-2 focus:ring-sky-400/30"
                      />
                    </label>
                    {loginError ? (
                      <div className="rounded-2xl border border-rose-400/30 bg-rose-500/10 p-4 text-sm text-rose-100">
                        {loginError}
                      </div>
                    ) : null}
                    <button
                      className="btn-primary shimmer rounded-2xl px-6 py-4 text-base font-semibold text-slate-950"
                      onClick={handleLogin}
                      disabled={!email.trim() || !password.trim()}
                    >
                      Login
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen surface">
      <div className="pointer-events-none absolute -top-52 left-1/2 h-[520px] w-[980px] -translate-x-1/2 rounded-full glow-orb opacity-80" />
      <div className="pointer-events-none absolute inset-0 noise" />

      <div className="relative mx-auto w-full max-w-6xl px-6 py-14">
        <header className="mb-10 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className="space-y-2">
            <div className="inline-flex w-fit items-center gap-2 rounded-full border border-slate-800 bg-slate-950/40 px-4 py-1 text-xs font-semibold uppercase tracking-[0.22em] text-slate-200 shadow-soft">
              Zerify • Verifier
            </div>
            <h1 className="text-4xl font-semibold tracking-tight text-slate-50">Request & result dashboard</h1>
            <p className="text-base text-slate-300">
              Build KYC constraints, add recipient numbers (saved to Firebase). Provers see pending requests on their dashboard after login—SMS is disabled until your team picks a provider.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Pill>Logged in: {authUser.email ?? "verifier"}</Pill>
            <button
              type="button"
              className="rounded-2xl border border-slate-800 bg-slate-950/30 px-4 py-2 text-sm font-semibold text-slate-100 hover:border-slate-700"
              onClick={handleVerifierLogout}
            >
              Logout
            </button>
          </div>
        </header>

        <div className="grid gap-8 lg:grid-cols-[1.05fr_0.95fr]">
          <section className="gradient-border">
            <div className="card-glass rounded-[2rem] border border-slate-800/70 p-7 shadow-soft">
              <h2 className="text-xl font-semibold text-slate-50">Send KYC request</h2>

              <div className="mt-6 grid gap-6">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                    Verification type
                  </div>
                  <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    {(["age", "gender", "address"] as VerificationType[]).map((key) => (
                      <label
                        key={key}
                        className="flex cursor-pointer items-center gap-3 rounded-2xl border border-slate-800 bg-slate-950/30 px-4 py-3 text-sm font-semibold text-slate-200 hover:border-slate-700"
                      >
                        <input
                          type="checkbox"
                          checked={checks[key]}
                          onChange={(e) => setChecks((p) => ({ ...p, [key]: e.target.checked }))}
                          className="h-4 w-4 accent-sky-300"
                        />
                        {key === "age" ? "Age" : key === "gender" ? "Gender" : "Address"}
                      </label>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                    Constraints
                  </div>

                  <div className="mt-3 grid gap-4">
                    {checks.age ? (
                      <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4">
                        <div className="text-sm font-semibold text-slate-100">Minimum age</div>
                        <input
                          type="number"
                          min={1}
                          value={minAge}
                          onChange={(e) => setMinAge(Number(e.target.value))}
                          className="mt-3 w-full rounded-2xl border border-slate-800 bg-slate-950/40 px-4 py-3 text-base text-slate-100 outline-none focus:ring-2 focus:ring-sky-400/30"
                        />
                      </div>
                    ) : null}

                    {checks.gender ? (
                      <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4">
                        <div className="text-sm font-semibold text-slate-100">Required gender</div>
                        <select
                          value={requiredGender}
                          onChange={(e) => setRequiredGender(e.target.value as KycConstraints["requiredGender"])}
                          className="mt-3 w-full rounded-2xl border border-slate-800 bg-slate-950/40 px-4 py-3 text-base text-slate-100 outline-none focus:ring-2 focus:ring-sky-400/30"
                        >
                          <option value="">Select…</option>
                          <option value="Male">Male</option>
                          <option value="Female">Female</option>
                          <option value="Other">Other</option>
                        </select>
                      </div>
                    ) : null}

                    {checks.address ? (
                      <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4">
                        <div className="text-sm font-semibold text-slate-100">Allowed pincodes (max 5)</div>
                        <div className="mt-3 flex gap-3">
                          <input
                            value={pincodeInput}
                            onChange={(e) => setPincodeInput(e.target.value)}
                            placeholder="754109"
                            className="w-full rounded-2xl border border-slate-800 bg-slate-950/40 px-4 py-3 text-base text-slate-100 outline-none focus:ring-2 focus:ring-sky-400/30"
                          />
                          <button
                            type="button"
                            className="rounded-2xl border border-slate-800 bg-slate-950/30 px-4 py-3 text-sm font-semibold text-slate-100 hover:border-slate-700 disabled:opacity-40"
                            disabled={!pincodeInput.trim() || pincodes.length >= 5}
                            onClick={() => {
                              const pc = pincodeInput.trim();
                              if (!pc) return;
                              if (pincodes.includes(pc)) return;
                              setPincodes((prev) => [...prev, pc].slice(0, 5));
                              setPincodeInput("");
                            }}
                          >
                            + Add
                          </button>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {pincodes.map((pc) => (
                            <span
                              key={pc}
                              className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-950/35 px-3 py-1 text-sm font-semibold text-slate-200"
                            >
                              {pc}
                              <button
                                type="button"
                                className="text-slate-400 hover:text-slate-100"
                                onClick={() => setPincodes((prev) => prev.filter((v) => v !== pc))}
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>

                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                    Purpose of KYC
                  </div>
                  <textarea
                    value={purpose}
                    onChange={(e) => setPurpose(e.target.value)}
                    placeholder="e.g. Employment eligibility verification / Visa verification / Tenant screening"
                    className="mt-3 min-h-20 w-full resize-none rounded-2xl border border-slate-800 bg-slate-950/40 px-4 py-3 text-base text-slate-100 outline-none focus:ring-2 focus:ring-sky-400/30"
                  />
                  <p className="mt-2 text-xs text-slate-400">
                    This will be shown to the prover for this request.
                  </p>
                </div>

                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                    Security policy
                  </div>
                  <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-2xl border border-slate-800 bg-slate-950/30 px-4 py-3 text-sm font-semibold text-slate-200 hover:border-slate-700">
                    <input
                      type="checkbox"
                      checked={requireCommitment}
                      onChange={(e) => setRequireCommitment(e.target.checked)}
                      className="mt-1 h-4 w-4 accent-sky-300"
                    />
                    <span className="leading-6">
                      Require commitment-bound proof (liveness + face hash). If prover can’t produce it, backend verification will fail.
                    </span>
                  </label>
                  <p className="mt-2 text-xs text-slate-400">
                    This hardens against proof downgrades and binds identity attributes to the liveness session.
                  </p>
                </div>

                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                    Target mobile numbers
                  </div>
                  <textarea
                    value={mobilesInput}
                    onChange={(e) => setMobilesInput(e.target.value)}
                    placeholder="9876543210, 9123456789"
                    className="mt-3 min-h-28 w-full resize-none rounded-2xl border border-slate-800 bg-slate-950/40 px-4 py-3 text-base text-slate-100 outline-none focus:ring-2 focus:ring-sky-400/30"
                  />
                  {parsedMobiles.invalid.length > 0 ? (
                    <div className="mt-2 text-sm text-amber-200">
                      Invalid number(s): {parsedMobiles.invalid.join(", ")}
                    </div>
                  ) : null}
                </div>

                <button
                  type="button"
                  className="btn-primary shimmer w-full rounded-2xl px-6 py-4 text-base font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={!canSend || sending}
                  onClick={handleSendRequest}
                >
                  {sending ? "Sending…" : "SEND KYC REQUEST"}
                </button>

                {sendSuccess ? (
                  <div className="rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-4 text-sm text-emerald-100">
                    {sendSuccess}
                  </div>
                ) : null}
                {sendError ? (
                  <div className="rounded-2xl border border-rose-400/30 bg-rose-500/10 p-4 text-sm text-rose-100">
                    {sendError}
                  </div>
                ) : null}
                {!canSend && !sending && (parsedMobiles.valid.length === 0 || parsedMobiles.invalid.length > 0) ? (
                  <p className="text-xs text-slate-400">
                    Enter at least one valid 10-digit mobile number (e.g. 8260057716) to enable.
                  </p>
                ) : null}
                {sending && sendStage ? (
                  <p className="text-xs text-slate-300">Status: {sendStage}</p>
                ) : null}
              </div>
            </div>
          </section>

          <section className="card-glass rounded-[2rem] border border-slate-800/70 p-7 shadow-soft">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold text-slate-50">Result dashboard</h2>
                <p className="mt-2 text-sm text-slate-300">Select a request to verify proof per credential.</p>
              </div>
            </div>

            <div className="mt-6 overflow-hidden rounded-2xl border border-slate-800">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-950/50 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                  <tr>
                    <th className="px-4 py-3">Request</th>
                    <th className="px-4 py-3">Recipients</th>
                    <th className="px-4 py-3">Open</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800 bg-slate-950/20">
                  {requestIds.length === 0 ? (
                    <tr>
                      <td className="px-4 py-6 text-slate-400" colSpan={3}>
                        No requests yet.
                      </td>
                    </tr>
                  ) : (
                    requestIds.slice(0, 12).map((id) => (
                      <tr key={id} className="text-slate-200">
                        <td className="px-4 py-4">
                          <div className="font-semibold text-slate-100">{id}</div>
                        </td>
                        <td className="px-4 py-4 text-slate-300">
                          {request?.requestId === id && request
                            ? Object.keys(request.users ?? {}).length
                            : "…"}
                        </td>
                        <td className="px-4 py-4">
                          <button
                            type="button"
                            className="btn-primary shimmer inline-flex rounded-2xl px-4 py-2 text-sm font-semibold text-slate-950"
                            onClick={() => setSelectedRequestId(id)}
                          >
                            Open
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {selectedRequestId && request ? (
              <div className="mt-6 rounded-2xl border border-slate-800 bg-slate-950/30 p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-sm font-semibold text-slate-100">Request details</div>
                    <div className="mt-1 text-sm text-slate-300">
                      Constraints + proof received status
                    </div>
                  </div>
                  <button
                    type="button"
                    className="rounded-2xl border border-rose-400/35 bg-rose-500/10 px-4 py-2 text-sm font-semibold text-rose-100 hover:bg-rose-500/15 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={
                      deleteBusy ||
                      request.verifier.uid !== authUser.uid
                    }
                    onClick={() => void handleDeleteRequest()}
                    title={
                      request.verifier.uid !== authUser.uid
                        ? "Only the request owner can delete this request."
                        : undefined
                    }
                  >
                    {deleteBusy ? "Deleting…" : "Delete request"}
                  </button>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  {request.checks.map((c) => (
                    <Pill key={c}>
                      {c === "age"
                        ? `Age ≥ ${request.constraints.minAge}`
                        : c === "gender"
                          ? `Gender = ${request.constraints.requiredGender}`
                          : `Pincode any of {${request.constraints.pincodes.join(", ")}}`}
                    </Pill>
                  ))}
                </div>

                {request.purpose ? (
                  <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/25 px-4 py-3 text-sm text-slate-200">
                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                      Purpose of KYC
                    </div>
                    <div className="mt-1 break-words font-medium">{request.purpose}</div>
                  </div>
                ) : null}

                {verifyError ? (
                  <div className="mt-4 rounded-2xl border border-rose-400/30 bg-rose-500/10 p-4 text-sm text-rose-100">
                    {verifyError}
                  </div>
                ) : null}
                {deleteError ? (
                  <div className="mt-4 rounded-2xl border border-rose-400/30 bg-rose-500/10 p-4 text-sm text-rose-100">
                    {deleteError}
                  </div>
                ) : null}
                {deleteSuccess ? (
                  <div className="mt-4 rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-4 text-sm text-emerald-100">
                    {deleteSuccess}
                  </div>
                ) : null}

                <div className="mt-6 space-y-4">
                  {Object.entries(request.users ?? {}).map(([phone, raw]) => {
                    const userState = normalizeUserState(raw);
                    const proof = userState.proof;

                    const ageStatus =
                      userState.verification.ageVerified === null
                        ? "pending"
                        : userState.verification.ageVerified
                          ? "verified"
                          : "not-verified";
                    const genderStatus =
                      userState.verification.genderVerified === null
                        ? "pending"
                        : userState.verification.genderVerified
                          ? "verified"
                          : "not-verified";
                    const addressStatus =
                      userState.verification.addressVerified === null
                        ? "pending"
                        : userState.verification.addressVerified
                          ? "verified"
                          : "not-verified";

                    return (
                      <div
                        key={phone}
                        className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4"
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <div className="text-sm font-semibold text-slate-100">{phone}</div>
                            <div className="mt-1 text-xs text-slate-400">
                              Proof: {proof ? "received" : "not received"}
                            </div>
                          </div>
                        </div>

                        <div className="mt-4 grid gap-3 sm:grid-cols-4">
                          <div className="space-y-2">
                            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Age</div>
                            <AttrBadge status={ageStatus} />
                          </div>
                          <div className="space-y-2">
                            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Gender</div>
                            <AttrBadge status={genderStatus} />
                          </div>
                          <div className="space-y-2">
                            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Address</div>
                            <AttrBadge status={addressStatus} />
                          </div>
                          <div className="space-y-2">
                            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Risk</div>
                            <RiskBadge
                              status={
                                userState.risk?.faceMatchStatus ??
                                (userState.risk?.status === "verified" ? "matched" : userState.risk?.status ?? "unknown")
                              }
                            />
                          </div>
                        </div>

                        {userState.risk?.aadhaarFaceDistance !== null &&
                        typeof userState.risk?.aadhaarFaceDistance === "number" ? (
                          <div className="mt-3 text-xs text-slate-400">
                            Face vs Aadhaar photo: distance {userState.risk.aadhaarFaceDistance.toFixed(3)} (same person
                            if ≤ {userState.risk.threshold ?? 0.65})
                          </div>
                        ) : userState.risk?.cosineSimilarity !== null &&
                          typeof userState.risk?.cosineSimilarity === "number" ? (
                          <div className="mt-3 text-xs text-slate-400">
                            Cosine (legacy): {userState.risk.cosineSimilarity.toFixed(3)} (older runs used cosine; lower
                            distance above is authoritative when present)
                          </div>
                        ) : userState.risk?.infraUnavailable ? (
                          <div className="mt-3 text-xs text-slate-400">
                            Similarity unavailable on prover device (models/camera).
                          </div>
                        ) : null}

                        <button
                          type="button"
                          disabled={
                            !proof ||
                            !isGroth16FlexibleKycScheme(proof.scheme) ||
                            verifyBusyPhone === phone
                          }
                          className="btn-primary shimmer mt-4 w-full rounded-2xl px-4 py-3 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
                          onClick={() => void handleVerifyZkProof(phone)}
                        >
                          {verifyBusyPhone === phone ? "Verifying…" : "Verify ZK proof (backend)"}
                        </button>

                        {proof && isGroth16FlexibleKycScheme(proof.scheme) ? (
                          <div className="mt-3 text-xs text-slate-300">
                            Groth16 proof on file ({proof.scheme}) • {proof.publicSignals.length} public signals • saved{" "}
                            {new Date(proof.createdAt).toLocaleString()}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </main>
  );
}

