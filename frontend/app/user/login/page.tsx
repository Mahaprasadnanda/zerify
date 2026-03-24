"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { OtpFlow } from "@/components/OtpFlow";

const STORAGE_KEYS = {
  users: "zerify.users.v1",
  userSession: "zerify.user.session",
} as const;

type UserRecord = {
  phone: string;
  registeredAt: number;
};

function loadUsers(): UserRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.users);
    return raw ? (JSON.parse(raw) as UserRecord[]) : [];
  } catch {
    return [];
  }
}

export default function LoginPage() {
  const router = useRouter();
  const [warning, setWarning] = useState<string | null>(null);

  const knownUsers = useMemo(() => loadUsers(), []);

  return (
    <main className="min-h-screen surface">
      <div className="pointer-events-none absolute -top-52 left-1/2 h-[520px] w-[980px] -translate-x-1/2 rounded-full glow-orb opacity-80" />
      <div className="pointer-events-none absolute inset-0 noise" />

      <div className="relative mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-6 py-16">
        <OtpFlow
          title="Login as user"
          subtitle="Enter your registered mobile number. We’ll verify it with OTP."
          primaryCtaLabel="Verify & continue"
          onVerified={(phoneE164) => {
            const isRegistered = knownUsers.some((u) => u.phone === phoneE164);
            if (!isRegistered) {
              setWarning("This number is not registered yet. Please register first.");
              return;
            }
            localStorage.setItem(
              STORAGE_KEYS.userSession,
              JSON.stringify({ phone: phoneE164, verifiedAt: Date.now() }),
            );
            router.push("/prover");
          }}
        />

        {warning ? (
          <div className="mt-4 rounded-2xl border border-amber-400/30 bg-amber-500/10 p-4 text-sm text-amber-100">
            {warning}
          </div>
        ) : null}

        <div className="mt-6 grid gap-3 text-center text-sm text-slate-300">
          <a
            className="text-slate-200 underline decoration-slate-600 hover:decoration-slate-300"
            href="/user/register"
          >
            New here? Register as new user
          </a>
          <a
            className="text-slate-400 underline decoration-slate-700 hover:decoration-slate-400"
            href="/"
          >
            Back to home
          </a>
        </div>
      </div>
    </main>
  );
}

