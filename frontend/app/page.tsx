export default function HomePage() {
  return (
    <main className="min-h-screen surface">
      <div className="pointer-events-none absolute -top-52 left-1/2 h-[520px] w-[980px] -translate-x-1/2 rounded-full glow-orb opacity-80" />
      <div className="pointer-events-none absolute inset-0 noise" />

      <div className="relative mx-auto flex min-h-screen w-full max-w-6xl flex-col justify-center px-4 py-10 sm:px-6 sm:py-16">
        <section className="hero-wrap mx-auto w-full max-w-4xl min-h-[620px] space-y-6 pt-6 lg:ml-20 xl:ml-28">
          <div className="hero-badge inline-flex w-fit items-center gap-2 rounded-full border border-slate-800 bg-slate-950/40 px-4 py-1 text-xs font-semibold uppercase tracking-[0.22em] text-slate-200 shadow-soft">
            Welcome to Zerify
            <span className="h-1 w-1 rounded-full bg-sky-300/80" />
            Privacy-first KYC
          </div>

          <h1 className="pb-2 text-4xl font-semibold leading-[1.26] tracking-tight text-slate-50 md:text-6xl md:leading-[1.2]">
            Verify identity
            <span className="block pb-1 bg-gradient-to-r from-sky-300 via-slate-50 to-indigo-300 bg-clip-text leading-[1.26] text-transparent md:leading-[1.2]">
              without revealing personal data.
            </span>
          </h1>

          <p className="max-w-3xl text-lg leading-8 text-slate-300">
            Zerify now runs as two-site architecture: this frontend is for verifier and request launch, and the dedicated prover
            app handles Aadhaar upload, QR decode, liveness, face matching, and proof submission.
          </p>

          <div className="flex flex-col gap-3 sm:flex-row">
            <a
              href="/verifier"
              className="btn-hero btn-solid btn-primary inline-flex items-center justify-center rounded-2xl px-7 py-4 text-base font-semibold text-slate-950"
            >
              Login as Verifier
            </a>
            <a
              href="/user/login"
              className="btn-hero btn-solid btn-user inline-flex items-center justify-center rounded-2xl px-7 py-4 text-base font-semibold text-slate-50"
            >
              Login as User
            </a>
            <a
              href="/user/register"
              className="btn-hero btn-solid btn-register inline-flex items-center justify-center rounded-2xl px-7 py-4 text-base font-semibold text-slate-50"
            >
              Register as New User
            </a>
          </div>

          <div className="grid max-w-3xl gap-3 text-sm text-slate-200">
            <div className="flex items-center gap-3 rounded-2xl border border-slate-800 bg-slate-950/35 px-4 py-3">
              <span className="h-2 w-2 rounded-full bg-emerald-300/80" />
              Aadhaar data never leaves the browser
            </div>
            <div className="flex items-center gap-3 rounded-2xl border border-slate-800 bg-slate-950/35 px-4 py-3">
              <span className="h-2 w-2 rounded-full bg-sky-300/80" />
              Proofs generated with snarkjs (Groth16)
            </div>
            <div className="flex items-center gap-3 rounded-2xl border border-slate-800 bg-slate-950/35 px-4 py-3">
              <span className="h-2 w-2 rounded-full bg-indigo-300/80" />
              OTP login + Firebase-backed request inbox
            </div>
          </div>
        </section>

        <footer className="mt-12 border-t border-slate-800/80 pt-6 text-sm text-slate-300">
          <div className="flex flex-col items-center justify-between gap-3 sm:flex-row">
            <p>©2026 Zerify Application. All Rights Reserved.</p>
            <a
              href="mailto:tandav2026@gmail.com"
              className="inline-flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/30 px-3 py-2 text-slate-200 transition hover:border-sky-400/50 hover:text-sky-200"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M4 4h16v16H4z" />
                <path d="m4 7 8 6 8-6" />
              </svg>
              tandav2026@gmail.com
            </a>
          </div>
        </footer>
      </div>
    </main>
  );
}
