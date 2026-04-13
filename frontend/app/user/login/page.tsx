"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { OtpFlow } from "@/components/OtpFlow";
import { isRegisteredUser } from "@/lib/userRegistry";

const STORAGE_KEYS = {
  userSession: "zerify.user.session",
} as const;

export default function LoginPage() {
  const router = useRouter();
  const [warning, setWarning] = useState<string | null>(null);

  const assertRegistered = async (phoneE164: string) => {
    const lookup = await isRegisteredUser(phoneE164);
    if (!lookup.ok || !lookup.phone) {
      throw new Error(lookup.message ?? "We could not check this number right now.");
    }

    if (!lookup.registered) {
      const message = "This number is not registered yet. Please register first.";
      setWarning(message);
      throw new Error(message);
    }

    return lookup.phone;
  };

  useEffect(() => {
    sessionStorage.removeItem(STORAGE_KEYS.userSession);
    localStorage.removeItem(STORAGE_KEYS.userSession);
  }, []);

  return (
    <main className="min-h-screen surface">
      <div className="pointer-events-none absolute -top-52 left-1/2 h-[520px] w-[980px] -translate-x-1/2 rounded-full glow-orb opacity-80" />
      <div className="pointer-events-none absolute inset-0 noise" />

      <div className="relative mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-4 py-10 sm:px-6 sm:py-16">
        <OtpFlow
          title="Login as user"
          subtitle="Enter your registered mobile number. We'll verify it with OTP."
          primaryCtaLabel="Verify & continue"
          onBeforeSend={async (phoneE164) => {
            setWarning(null);
            await assertRegistered(phoneE164);
          }}
          onVerified={async (phoneE164) => {
            setWarning(null);
            const registeredPhone = await assertRegistered(phoneE164);

            sessionStorage.setItem(
              STORAGE_KEYS.userSession,
              JSON.stringify({ phone: registeredPhone, verifiedAt: Date.now() }),
            );
            // Clean legacy persistent session for stricter security.
            localStorage.removeItem(STORAGE_KEYS.userSession);
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
