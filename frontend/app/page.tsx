export default function HomePage() {
  return (
    <main className="min-h-screen surface">
      <div className="pointer-events-none absolute -top-52 left-1/2 h-[520px] w-[980px] -translate-x-1/2 rounded-full glow-orb opacity-80" />
      <div className="pointer-events-none absolute inset-0 noise" />

      <div className="relative mx-auto flex min-h-screen w-full max-w-6xl flex-col justify-center px-6 py-16">
        <section className="grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
          <div className="space-y-6">
            <div className="inline-flex w-fit items-center gap-2 rounded-full border border-slate-800 bg-slate-950/40 px-4 py-1 text-xs font-semibold uppercase tracking-[0.22em] text-slate-200 shadow-soft">
              Welcome to Zerify
              <span className="h-1 w-1 rounded-full bg-sky-300/80" />
              Privacy-first KYC
            </div>

            <h1 className="text-4xl font-semibold tracking-tight text-slate-50 md:text-6xl">
              Verify identity
              <span className="block bg-gradient-to-r from-sky-300 via-slate-50 to-indigo-300 bg-clip-text text-transparent">
                without revealing personal data.
              </span>
            </h1>

            <p className="max-w-xl text-lg leading-8 text-slate-300">
              Zerify now runs as two-site architecture: this frontend is for verifier and request launch, and the dedicated prover app (`face_matching`) handles Aadhaar upload, QR decode, liveness, face matching, and proof submission.
            </p>

            <div className="flex flex-col gap-3 sm:flex-row">
              <a
                href="/verifier"
                className="btn-primary shimmer inline-flex items-center justify-center rounded-2xl px-6 py-4 text-base font-semibold text-slate-950"
              >
                Login as Verifier
              </a>
              <a
                href="/user/login"
                className="inline-flex items-center justify-center rounded-2xl border border-slate-800 bg-slate-950/30 px-6 py-4 text-base font-semibold text-slate-100 hover:border-slate-700"
              >
                Login as User
              </a>
              <a
                href="/user/register"
                className="inline-flex items-center justify-center rounded-2xl border border-slate-800 bg-slate-950/30 px-6 py-4 text-base font-semibold text-slate-100 hover:border-slate-700"
              >
                Register as New User
              </a>
            </div>

            <div className="grid max-w-xl gap-3 text-sm text-slate-200">
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
          </div>

          <div className="gradient-border lg:justify-self-end">
            <div className="card-glass rounded-[2rem] border border-slate-800/70 p-8 shadow-soft">
              <h2 className="text-xl font-semibold text-slate-50">Demo routes</h2>
              <div className="mt-4 grid gap-3 text-sm text-slate-300">
                <a className="rounded-2xl border border-slate-800 bg-slate-950/30 px-4 py-3 hover:border-slate-700" href="/verifier">
                  <span className="font-semibold text-slate-100">/verifier</span> — create KYC requests
                </a>
                <a className="rounded-2xl border border-slate-800 bg-slate-950/30 px-4 py-3 hover:border-slate-700" href="/prover">
                  <span className="font-semibold text-slate-100">/prover</span> — prover launcher (opens Face Matching App)
                </a>
                <a className="rounded-2xl border border-slate-800 bg-slate-950/30 px-4 py-3 hover:border-slate-700" href="/user/register">
                  <span className="font-semibold text-slate-100">/user/register</span> — register user (OTP)
                </a>
                <a className="rounded-2xl border border-slate-800 bg-slate-950/30 px-4 py-3 hover:border-slate-700" href="/user/login">
                  <span className="font-semibold text-slate-100">/user/login</span> — login user (OTP)
                </a>
              </div>

              <p className="mt-6 text-xs leading-6 text-slate-400">
                Verifier remains on this site. Prover flow is consolidated in the separate Face Matching app for unambiguous operation.
              </p>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
