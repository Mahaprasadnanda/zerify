"use client";

import { useMemo, useState } from "react";
import { FaceLiveness } from "@/components/FaceLiveness";
import { FaceMatchingFlow } from "@/components/FaceMatchingFlow";
import type { LivenessResult } from "@/utils/faceLiveness";

export default function FaceVerificationWithLivenessPage() {
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [liveness, setLiveness] = useState<LivenessResult | null>(null);

  const passed = useMemo(() => liveness?.status === "pass", [liveness]);

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <div className="space-y-6">
        <section className="rounded-[2rem] border border-slate-800 bg-slate-950/40 p-6 shadow-soft">
          <div className="text-sm font-semibold text-slate-100">Step 1 — Liveness</div>
          <div className="mt-1 text-sm text-slate-300">
            Complete liveness first. If it passes, the same camera stream will be reused for face verification (no second
            stream).
          </div>
          <div className="mt-4">
            <FaceLiveness
              onResult={(res) => setLiveness(res)}
              persistStreamOnPass
              onVideoElement={(el) => setVideoEl(el)}
            />
          </div>
        </section>

        <section className="rounded-[2rem] border border-slate-800 bg-slate-950/40 p-6 shadow-soft">
          <div className="text-sm font-semibold text-slate-100">Step 2 — Face Verification</div>
          <div className="mt-1 text-sm text-slate-300">
            Capture 5 frames, confirm, upload Aadhaar/ID image, and compare. All processing is local.
          </div>

          {!passed ? (
            <div className="mt-4 rounded-2xl border border-amber-400/30 bg-amber-500/10 p-4 text-sm text-amber-100">
              Liveness must pass before starting face verification.
            </div>
          ) : (
            <div className="mt-6">
              <FaceMatchingFlow videoElement={videoEl} />
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

