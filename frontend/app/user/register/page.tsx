"use client";

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

function saveUsers(users: UserRecord[]) {
  localStorage.setItem(STORAGE_KEYS.users, JSON.stringify(users));
}

export default function RegisterPage() {
  const router = useRouter();

  return (
    <main className="min-h-screen surface">
      <div className="pointer-events-none absolute -top-52 left-1/2 h-[520px] w-[980px] -translate-x-1/2 rounded-full glow-orb opacity-80" />
      <div className="pointer-events-none absolute inset-0 noise" />

      <div className="relative mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-6 py-16">
        <OtpFlow
          title="Register as new user"
          subtitle="We only register your mobile number. No name, DOB, or Aadhaar details are stored on the server."
          primaryCtaLabel="Verify & register"
          onVerified={(phoneE164) => {
            const users = loadUsers();
            const next: UserRecord = { phone: phoneE164, registeredAt: Date.now() };
            const deduped = [next, ...users.filter((u) => u.phone !== phoneE164)];
            saveUsers(deduped);
            localStorage.setItem(
              STORAGE_KEYS.userSession,
              JSON.stringify({ phone: phoneE164, verifiedAt: Date.now() }),
            );
            router.push("/prover");
          }}
        />

        <div className="mt-6 grid gap-3 text-center text-sm text-slate-300">
          <a
            className="text-slate-200 underline decoration-slate-600 hover:decoration-slate-300"
            href="/user/login"
          >
            Already registered? Login as user
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

