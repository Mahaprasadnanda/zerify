"use client";

import { type FormEvent, useEffect, useMemo, useState } from "react";
import { sendOtp, verifyOtp } from "@/lib/otpClient";

type Props = {
  title: string;
  subtitle: string;
  primaryCtaLabel: string;
  onVerified: (phoneE164: string) => void;
};

function Spinner() {
  return (
    <span
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white/90"
      aria-hidden="true"
    />
  );
}

function normalizeToE164India(raw: string): string {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.startsWith("91") && digits.length === 12) return `+${digits}`;
  if (raw.trim().startsWith("+")) return raw.trim();
  return "";
}

export function OtpFlow({ title, subtitle, primaryCtaLabel, onVerified }: Props) {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [phase, setPhase] = useState<"phone" | "code">("phone");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [resendRemainingSec, setResendRemainingSec] = useState(0);

  const phoneE164 = useMemo(() => normalizeToE164India(phone), [phone]);

  useEffect(() => {
    if (phase !== "code") return;
    if (resendRemainingSec <= 0) return;
    const timer = setInterval(() => {
      setResendRemainingSec((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [phase, resendRemainingSec]);

  const handleSend = async () => {
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      const res = await sendOtp(phone);
      if (!res.ok) throw new Error(res.message ?? "Failed to send OTP.");
      setPhase("code");
      setResendRemainingSec(res.retryAfterSec ?? 60);
      setInfo(`OTP sent to ${phoneE164 || phone}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send OTP.");
    } finally {
      setBusy(false);
    }
  };

  const handleVerify = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await verifyOtp(phone, code);
      if (!res.ok) throw new Error(res.message ?? "OTP verification failed.");
      onVerified(phoneE164 || phone);
    } catch (e) {
      setError(e instanceof Error ? e.message : "OTP verification failed.");
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    if (phase === "phone") {
      if (!phoneE164) return;
      await handleSend();
      return;
    }
    await handleVerify();
  };

  return (
    <div className="gradient-border">
      <section className="card-glass rounded-[2rem] border border-slate-800/70 p-8 shadow-soft md:p-10">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-50 md:text-4xl">
          {title}
        </h1>
        <p className="mt-3 text-base leading-7 text-slate-300">{subtitle}</p>

        <form className="mt-7 grid gap-4" onSubmit={handleSubmit}>
          {phase === "phone" ? (
            <>
              <label className="grid gap-2">
                <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                  Mobile number
                </span>
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="8658996694"
                  inputMode="numeric"
                  className="w-full rounded-2xl border border-slate-800 bg-slate-950/40 px-4 py-3 text-base text-slate-100 outline-none focus:ring-2 focus:ring-sky-400/30"
                />
                <span className="text-xs text-slate-400">
                  Enter 10-digit number (India) or E.164 like +91XXXXXXXXXX.
                </span>
              </label>

              <button
                type="submit"
                className="btn-primary shimmer inline-flex w-full items-center justify-center gap-2 rounded-2xl px-6 py-4 text-base font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={busy || !phoneE164}
              >
                {busy ? <Spinner /> : null}
                Send OTP
              </button>
            </>
          ) : (
            <>
              {info ? (
                <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4 text-sm text-slate-300">
                  {info}
                </div>
              ) : null}
              <label className="grid gap-2">
                <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                  Enter OTP
                </span>
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="123456"
                  inputMode="numeric"
                  className="w-full rounded-2xl border border-slate-800 bg-slate-950/40 px-4 py-3 text-base text-slate-100 outline-none focus:ring-2 focus:ring-sky-400/30"
                />
              </label>

              <button
                type="submit"
                className="btn-primary shimmer inline-flex w-full items-center justify-center gap-2 rounded-2xl px-6 py-4 text-base font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={busy}
              >
                {busy ? <Spinner /> : null}
                {primaryCtaLabel}
              </button>

              <button
                type="button"
                className="w-full rounded-2xl border border-slate-800 bg-slate-950/25 px-6 py-4 text-base font-semibold text-slate-100 hover:border-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={busy || resendRemainingSec > 0}
                onClick={handleSend}
              >
                {resendRemainingSec > 0
                  ? `Resend OTP in ${resendRemainingSec}s`
                  : "Resend OTP"}
              </button>

              <button
                type="button"
                className="w-full rounded-2xl border border-slate-800 bg-slate-950/25 px-6 py-4 text-base font-semibold text-slate-100 hover:border-slate-700 disabled:opacity-50"
                disabled={busy}
                onClick={() => {
                  setCode("");
                  setResendRemainingSec(0);
                  setPhase("phone");
                }}
              >
                Use a different number
              </button>
            </>
          )}

          {error ? (
            <div className="rounded-2xl border border-rose-400/30 bg-rose-500/10 p-4 text-sm text-rose-100">
              {error}
            </div>
          ) : null}
        </form>
      </section>
    </div>
  );
}

