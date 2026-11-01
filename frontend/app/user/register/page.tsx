"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ProverPasswordForm } from "@/components/ProverPasswordForm";
import { registerProver } from "@/lib/proverAuth";

const STORAGE_KEY = "zerify.user.session";

export default function RegisterPage() {
  const router = useRouter();

  return (
    <main className="min-h-screen surface">
      <div className="pointer-events-none absolute -top-52 left-1/2 h-[520px] w-[980px] -translate-x-1/2 rounded-full glow-orb opacity-80" />
      <div className="pointer-events-none absolute inset-0 noise" />
      <div className="relative mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-4 py-10 sm:px-6 sm:py-16">
        <ProverPasswordForm
          mode="register"
          onSubmit={async (phone, password) => {
            const registeredPhone = await registerProver(phone, password);
            sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ phone: registeredPhone, authenticatedAt: Date.now() }));
            router.push("/prover");
          }}
        />
        <div className="mt-6 grid gap-3 text-center text-sm text-slate-300">
          <Link className="text-slate-200 underline decoration-slate-600 hover:decoration-slate-300" href="/user/login">
            Already registered? Login as prover
          </Link>
          <Link className="text-slate-400 underline decoration-slate-700 hover:decoration-slate-400" href="/">Back to home</Link>
        </div>
      </div>
    </main>
  );
}
