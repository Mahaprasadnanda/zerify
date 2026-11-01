"use client";

import { useState, type FormEvent } from "react";

type Props = {
  mode: "login" | "register";
  onSubmit: (phone: string, password: string) => Promise<void>;
};

function normalizeIndianPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  return "";
}

export function ProverPasswordForm({ mode, onSubmit }: Props) {
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const phoneE164 = normalizeIndianPhone(phone);
  const registering = mode === "register";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!phoneE164) {
      setError("Enter a valid 10-digit Indian mobile number.");
      return;
    }
    if (password.length < 8) {
      setError("Password must contain at least 8 characters.");
      return;
    }
    if (registering && password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await onSubmit(phoneE164, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gradient-border">
      <section className="card-glass rounded-[2rem] border border-slate-800/70 p-8 shadow-soft md:p-10">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-50 md:text-4xl">
          {registering ? "Create prover account" : "Login as prover"}
        </h1>
        <p className="mt-3 text-base leading-7 text-slate-300">
          {registering
            ? "Create your account using your mobile number and a password."
            : "Enter your registered mobile number and password to continue."}
        </p>
        <form className="mt-7 grid gap-4" onSubmit={handleSubmit}>
          <label className="grid gap-2">
            <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Mobile number</span>
            <input
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="9876543210"
              inputMode="numeric"
              autoComplete="tel"
              required
              className="w-full rounded-2xl border border-slate-800 bg-slate-950/40 px-4 py-3 text-base text-slate-100 outline-none focus:ring-2 focus:ring-sky-400/30"
            />
            <span className="text-xs text-slate-400">India only. Enter your 10-digit mobile number.</span>
          </label>
          <label className="grid gap-2">
            <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={registering ? "new-password" : "current-password"}
              minLength={8}
              required
              className="w-full rounded-2xl border border-slate-800 bg-slate-950/40 px-4 py-3 text-base text-slate-100 outline-none focus:ring-2 focus:ring-sky-400/30"
            />
          </label>
          {registering ? (
            <label className="grid gap-2">
              <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Confirm password</span>
              <input
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
                className="w-full rounded-2xl border border-slate-800 bg-slate-950/40 px-4 py-3 text-base text-slate-100 outline-none focus:ring-2 focus:ring-sky-400/30"
              />
            </label>
          ) : null}
          <button
            type="submit"
            disabled={busy || !phoneE164 || password.length < 8 || (registering && password !== confirmPassword)}
            className="btn-primary shimmer inline-flex w-full items-center justify-center gap-2 rounded-2xl px-6 py-4 text-base font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Please wait…" : registering ? "Create account" : "Login"}
          </button>
          {error ? (
            <div role="alert" className="rounded-2xl border border-rose-400/30 bg-rose-500/10 p-4 text-sm text-rose-100">
              {error}
            </div>
          ) : null}
          <p className="text-xs leading-5 text-amber-200/90">
            Phone numbers are used as account IDs; without OTP, Zerify cannot verify ownership of the number.
          </p>
        </form>
      </section>
    </div>
  );
}
