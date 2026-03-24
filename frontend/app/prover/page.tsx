"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { onValue, ref } from "firebase/database";
import { firebaseDb } from "@/lib/firebaseClient";

const STORAGE_KEYS = {
  userSession: "zerify.user.session",
} as const;

type UserSession = { phone: string; verifiedAt: number };

export default function ProverPage() {
  const router = useRouter();
  const [session, setSession] = useState<UserSession | null>(null);
  const [requestSummaries, setRequestSummaries] = useState<
    Array<{ requestId: string; verifierName?: string; createdAt?: number }>
  >([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.userSession);
      if (raw) setSession(JSON.parse(raw) as UserSession);
    } catch {
      setSession(null);
    }
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
      setRequestSummaries(rows);
    });
  }, [session?.phone]);

  const hasSession = Boolean(session?.phone);

  return (
    <main className="min-h-screen surface">
      <div className="pointer-events-none absolute -top-52 left-1/2 h-[520px] w-[980px] -translate-x-1/2 rounded-full glow-orb opacity-80" />
      <div className="pointer-events-none absolute inset-0 noise" />

      <div className="relative mx-auto w-full max-w-6xl px-6 py-14">
        <header className="mb-10">
          <div className="inline-flex w-fit items-center gap-2 rounded-full border border-slate-800 bg-slate-950/40 px-4 py-1 text-xs font-semibold uppercase tracking-[0.22em] text-slate-200 shadow-soft">
            Zerify • Prover
          </div>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight text-slate-50">
            Your KYC requests
          </h1>
          <p className="mt-2 text-base text-slate-300">
            Pending requests come from Firebase (matched to your logged-in phone). Open one to upload Aadhaar QR and run local checks—ZK proofs come later.
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
                  localStorage.removeItem(STORAGE_KEYS.userSession);
                  setSession(null);
                  setRequestSummaries([]);
                }}
              >
                Logout
              </button>
            </div>

            <div className="mt-6 overflow-hidden rounded-2xl border border-slate-800">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-950/50 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                  <tr>
                    <th className="px-4 py-3">Request</th>
                    <th className="px-4 py-3">Verifier</th>
                    <th className="px-4 py-3">Sent</th>
                    <th className="px-4 py-3">Open</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800 bg-slate-950/20">
                  {requestSummaries.length === 0 ? (
                    <tr>
                      <td className="px-4 py-6 text-slate-400" colSpan={4}>
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
                        </td>
                        <td className="px-4 py-4 text-slate-300">
                          {r.verifierName ?? "—"}
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
                            onClick={() => router.push(`/kyc/${encodeURIComponent(r.requestId)}`)}
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
          </section>
        )}
      </div>
    </main>
  );
}

