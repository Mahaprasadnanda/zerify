"use client";

import { useEffect, useMemo, useState } from "react";
import { get, onValue, ref } from "firebase/database";
import { firebaseDb } from "@/lib/firebaseClient";

const STORAGE_KEYS = {
  userSession: "zerify.user.session",
} as const;

type UserSession = { phone: string; verifiedAt: number };

export default function ProverPage() {
  const faceMatchingBaseUrl =
    process.env.NEXT_PUBLIC_FACE_MATCHING_URL ?? "http://localhost:3010";
  const [session, setSession] = useState<UserSession | null>(null);
  const [requestSummaries, setRequestSummaries] = useState<
    Array<{
      requestId: string;
      verifierName?: string;
      createdAt?: number;
      riskStatus?: "verified" | "suspicious" | "matched" | "mismatch" | "unknown";
      proofScheme?: string | null;
    }>
  >([]);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEYS.userSession) ?? localStorage.getItem(STORAGE_KEYS.userSession);
      if (raw) setSession(JSON.parse(raw) as UserSession);
      if (raw) {
        // Migrate legacy persistent session into tab-scoped session.
        sessionStorage.setItem(STORAGE_KEYS.userSession, raw);
        localStorage.removeItem(STORAGE_KEYS.userSession);
      }
    } catch {
      setSession(null);
    }
  }, []);

  // Prevent stale bfcache state showing authenticated UI after logout/tab close.
  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      try {
        const raw = sessionStorage.getItem(STORAGE_KEYS.userSession);
        setSession(raw ? (JSON.parse(raw) as UserSession) : null);
      } catch {
        setSession(null);
      }
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  useEffect(() => {
    if (!session?.phone) return;
    const idxRef = ref(firebaseDb, `indices/userRequests/${session.phone}`);
    return onValue(idxRef, (snap) => {
      const val = snap.val() as Record<
        string,
        { requestId: string; verifierName?: string; createdAt?: number }
      > | null;
      if (!val) {
        setRequestSummaries([]);
        return;
      }
      const rows = Object.keys(val).map((requestId) => ({
        requestId,
        verifierName: val[requestId]?.verifierName,
        createdAt: val[requestId]?.createdAt,
      }));
      rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
      // Defensive UI guard: if index is stale but kycRequests entry is deleted, hide it.
      void (async () => {
        const checks = await Promise.all(
          rows.map(async (r) => {
            const exists = (await get(ref(firebaseDb, `kycRequests/${r.requestId}`))).exists();
            return { r, exists };
          }),
        );
        setRequestSummaries(checks.filter((x) => x.exists).map((x) => x.r));
      })();
    });
  }, [session?.phone]);

  const topRequestIdsKey = useMemo(
    () => requestSummaries.slice(0, 12).map((r) => r.requestId).join("|"),
    [requestSummaries],
  );

  useEffect(() => {
    if (!session?.phone) return;
    if (requestSummaries.length === 0) return;
    const unsubs: Array<() => void> = [];
    for (const r of requestSummaries.slice(0, 12)) {
      const base = `kycRequests/${r.requestId}/users/${session.phone}`;
      const riskRef = ref(firebaseDb, `${base}/risk/status`);
      const schemeRef = ref(firebaseDb, `${base}/proof/scheme`);
      unsubs.push(
        onValue(riskRef, (snap) => {
          const v = snap.val() as "verified" | "suspicious" | "matched" | "mismatch" | null;
          setRequestSummaries((prev) =>
            prev.map((x) => (x.requestId === r.requestId ? { ...x, riskStatus: v ?? "unknown" } : x)),
          );
        }),
      );
      unsubs.push(
        onValue(schemeRef, (snap) => {
          const v = snap.val() as string | null;
          setRequestSummaries((prev) =>
            prev.map((x) => (x.requestId === r.requestId ? { ...x, proofScheme: v ?? null } : x)),
          );
        }),
      );
    }
    return () => unsubs.forEach((u) => u());
  }, [topRequestIdsKey, session?.phone, requestSummaries.length, requestSummaries]);

  const hasSession = Boolean(session?.phone);

  const openFaceMatching = (reqId: string) => {
    if (!session?.phone) return;
    let resolvedBase = faceMatchingBaseUrl;
    try {
      const candidate = new URL(faceMatchingBaseUrl);
      if (
        typeof window !== "undefined" &&
        candidate.origin === window.location.origin &&
        (candidate.pathname === "/" || candidate.pathname === "")
      ) {
        resolvedBase = "http://localhost:3010";
      }
    } catch {
      resolvedBase = "http://localhost:3010";
    }
    const u = new URL(resolvedBase);
    u.searchParams.set("request_id", reqId);
    u.searchParams.set("phone", session.phone);
    u.searchParams.set("return_url", window.location.href);
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
      // ignore token encoding failures
    }
    window.location.href = u.toString();
  };

  return (
    <main className="min-h-screen surface">
      <div className="pointer-events-none absolute -top-52 left-1/2 h-[520px] w-[980px] -translate-x-1/2 rounded-full glow-orb opacity-80" />
      <div className="pointer-events-none absolute inset-0 noise" />

      <div className="relative mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
        <header className="mb-10">
          <div className="inline-flex w-fit items-center gap-2 rounded-full border border-slate-800 bg-slate-950/40 px-4 py-1 text-xs font-semibold uppercase tracking-[0.22em] text-slate-200 shadow-soft">
            Zerify • Prover Launcher
          </div>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-50 md:text-4xl">
            Your KYC requests
          </h1>
          <p className="mt-2 text-base text-slate-300">
            This page only launches the dedicated prover site. All prover operations now run in Face Matching App: Aadhaar upload, QR decode, liveness, face match, and proof submission.
          </p>
        </header>

        {!hasSession ? (
          <section className="rounded-[2rem] border border-slate-800 bg-slate-950/40 p-7 shadow-soft">
            <h2 className="text-xl font-semibold text-slate-50">Login required</h2>
            <p className="mt-2 text-sm text-slate-300">
              Please login as user (Twilio OTP) to view your requests.
            </p>
            <a
              href="/user/login"
              className="btn-primary shimmer mt-5 inline-flex rounded-2xl px-6 py-4 text-base font-semibold text-slate-950"
            >
              Go to user login
            </a>
          </section>
        ) : (
          <section className="rounded-[2rem] border border-slate-800 bg-slate-950/40 p-7 shadow-soft">
            <div className="flex items-end justify-between gap-4">
              <div>
                <div className="text-sm text-slate-300">Logged in phone</div>
                <div className="mt-1 font-mono text-slate-100">{session?.phone}</div>
              </div>
              <button
                type="button"
                className="rounded-2xl border border-slate-800 bg-slate-950/30 px-4 py-2 text-sm font-semibold text-slate-100 hover:border-slate-700"
                onClick={() => {
                  sessionStorage.removeItem(STORAGE_KEYS.userSession);
                  localStorage.removeItem(STORAGE_KEYS.userSession);
                  setSession(null);
                  setRequestSummaries([]);
                  window.location.replace("/user/login");
                }}
              >
                Logout
              </button>
            </div>

            <div className="mt-6 overflow-x-auto rounded-2xl border border-slate-800">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-950/50 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                  <tr>
                    <th className="px-4 py-3">Request</th>
                    <th className="px-4 py-3">Verifier</th>
                    <th className="px-4 py-3">Risk</th>
                    <th className="px-4 py-3">Sent</th>
                    <th className="px-4 py-3">Open</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800 bg-slate-950/20">
                  {requestSummaries.length === 0 ? (
                    <tr>
                      <td className="px-4 py-6 text-slate-400" colSpan={5}>
                        No requests yet. When a verifier adds your number to a KYC request, it will appear here.
                      </td>
                    </tr>
                  ) : (
                    requestSummaries.slice(0, 12).map((r) => (
                      <tr key={r.requestId} className="text-slate-200">
                        <td className="px-4 py-4">
                          <div className="font-semibold text-slate-100">
                            {r.requestId}
                          </div>
                          {r.proofScheme ? (
                            <div className="mt-1 text-[11px] text-slate-400">
                              Proof: {r.proofScheme === "groth16-flexible-kyc-commitment" ? "commitment" : "standard"}
                            </div>
                          ) : null}
                        </td>
                        <td className="px-4 py-4 text-slate-300">
                          {r.verifierName ?? "—"}
                        </td>
                        <td className="px-4 py-4">
                          <span
                            className={`inline-flex rounded-2xl border px-3 py-1 text-xs font-semibold ${
                              r.riskStatus === "verified" || r.riskStatus === "matched"
                                ? "border-emerald-400/35 bg-emerald-500/10 text-emerald-100"
                                : r.riskStatus === "suspicious"
                                  ? "border-amber-400/35 bg-amber-500/10 text-amber-100"
                                  : r.riskStatus === "mismatch"
                                    ? "border-rose-400/35 bg-rose-500/10 text-rose-100"
                                  : "border-slate-800 bg-slate-950/40 text-slate-300"
                            }`}
                          >
                            {r.riskStatus ?? "unknown"}
                          </span>
                        </td>
                        <td className="px-4 py-4 text-slate-400">
                          {r.createdAt
                            ? new Date(r.createdAt).toLocaleString()
                            : "—"}
                        </td>
                        <td className="px-4 py-4">
                          <button
                            type="button"
                            className="btn-primary shimmer inline-flex rounded-2xl px-4 py-2 text-sm font-semibold text-slate-950"
                            onClick={() => openFaceMatching(r.requestId)}
                          >
                            Open Prover App
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

