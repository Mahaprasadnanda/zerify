"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AADHAAR_LIVE_FACE_MAX_DISTANCE,
  averageNormalizedDescriptors,
  copyFaceDescriptor,
  cosineSimilarity,
  ensureFaceApiModels,
  detectLivenessFromVideoFrame,
  faceDescriptorEuclideanDistance,
  type LivenessResult,
} from "@/utils/faceLiveness";
import { poseidonHashEmbedding } from "@/utils/poseidon";
import { safeWarn } from "@/utils/safeLog";

type Props = {
  onResult: (res: LivenessResult) => void;
  /** Face embedding from uploaded Aadhaar image (portrait). If set, live face must match this, not just session stability. */
  aadhaarFaceDescriptor?: Float32Array | null;
  /** When true (e.g. commitment proof), refuse to pass without a detected Aadhaar face + live match. */
  requireAadhaarFaceMatch?: boolean;
  /**
   * When true, keep the camera stream alive after a pass so downstream modules
   * (e.g. face matching) can reuse the same stream without opening a second one.
   * Default false to preserve existing behavior.
   */
  persistStreamOnPass?: boolean;
  /** Exposes the internal <video> element for stream handoff (no data). */
  onVideoElement?: (el: HTMLVideoElement | null) => void;
};

function Spinner() {
  return (
    <span
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white/90"
      aria-hidden="true"
    />
  );
}

function Badge({ tone, label }: { tone: "ok" | "warn" | "idle"; label: string }) {
  const cls =
    tone === "ok"
      ? "border-emerald-400/35 bg-emerald-500/10 text-emerald-100"
      : tone === "warn"
        ? "border-amber-400/35 bg-amber-500/10 text-amber-100"
        : "border-slate-800 bg-slate-950/40 text-slate-300";
  return <span className={`inline-flex rounded-2xl border px-3 py-1 text-xs font-semibold ${cls}`}>{label}</span>;
}

export function FaceLiveness({
  onResult,
  aadhaarFaceDescriptor = null,
  requireAadhaarFaceMatch = false,
  persistStreamOnPass = false,
  onVideoElement,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const loopRef = useRef<number | null>(null);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [faceDetected, setFaceDetected] = useState(false);
  const [events, setEvents] = useState({ blink: false, headLeft: false, headRight: false });
  const [done, setDone] = useState(false);
  /** L2 distance(live, Aadhaar portrait) — identity check (lower = more similar). */
  const [distanceVsAadhaar, setDistanceVsAadhaar] = useState<number | null>(null);
  const [cosineVsAadhaar, setCosineVsAadhaar] = useState<number | null>(null);
  /** Cosine(first frame, current) — same session only; advisory. */
  const [sessionStability, setSessionStability] = useState<number | null>(null);
  /** Camera session ended (gestures completed); identityOk is false when Aadhaar match failed. */
  const [livenessFinished, setLivenessFinished] = useState(false);
  const [identityOk, setIdentityOk] = useState<boolean | null>(null);
  const [identityFailMessage, setIdentityFailMessage] = useState<string | null>(null);

  const passed = useMemo(() => events.blink && events.headLeft && events.headRight, [events]);

  const stop = (opts: { stopStream: boolean; closeUi: boolean } = { stopStream: true, closeUi: true }) => {
    if (loopRef.current) {
      cancelAnimationFrame(loopRef.current);
      loopRef.current = null;
    }
    if (opts.stopStream) {
      const stream = streamRef.current;
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    }
    if (opts.closeUi) setOpen(false);
  };

  useEffect(() => stop, []);

  /** Video must have non-zero dimensions before face-api runs; otherwise detection always fails. */
  const waitForVideoReady = (video: HTMLVideoElement, timeoutMs = 25000) =>
    new Promise<void>((resolve, reject) => {
      const ok = () => video.videoWidth > 1 && video.videoHeight > 1;
      if (ok()) {
        resolve();
        return;
      }
      const t = window.setTimeout(() => {
        video.removeEventListener("loadeddata", tryOk);
        video.removeEventListener("loadedmetadata", tryOk);
        video.removeEventListener("canplay", tryOk);
        video.removeEventListener("resize", tryOk);
        reject(new Error("Camera preview has no size yet. Try again or another browser."));
      }, timeoutMs);
      const tryOk = () => {
        if (ok()) {
          window.clearTimeout(t);
          video.removeEventListener("loadeddata", tryOk);
          video.removeEventListener("loadedmetadata", tryOk);
          video.removeEventListener("canplay", tryOk);
          video.removeEventListener("resize", tryOk);
          resolve();
        }
      };
      video.addEventListener("loadeddata", tryOk);
      video.addEventListener("loadedmetadata", tryOk);
      video.addEventListener("canplay", tryOk);
      video.addEventListener("resize", tryOk);
    });

  const startCamera = async () => {
    setError(null);
    setBusy(true);
    setDone(false);
    setFaceDetected(false);
    setEvents({ blink: false, headLeft: false, headRight: false });
    setDistanceVsAadhaar(null);
    setCosineVsAadhaar(null);
    setLivenessFinished(false);
    setIdentityOk(null);
    setIdentityFailMessage(null);
    setSessionStability(null);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Camera not available in this browser.");
      }
      await ensureFaceApiModels("/models/face-api");
      if (requireAadhaarFaceMatch && !aadhaarFaceDescriptor) {
        throw new Error(
          "Could not detect a face on your uploaded Aadhaar image. Upload a clear scan with the photo side visible, then try again.",
        );
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      streamRef.current = stream;
      setOpen(true);

      let video: HTMLVideoElement | null = null;
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => window.setTimeout(r, 50));
        video = videoRef.current;
        if (video) break;
      }
      if (!video) {
        throw new Error("Camera preview element did not mount.");
      }
      video.playsInline = true;
      video.muted = true;
      video.setAttribute("playsinline", "");
      video.srcObject = stream;
      await video.play().catch(() => {});
      await waitForVideoReady(video);

      const state = {
        blinkArmed: true,
        noseCenterX: null as number | null,
        prevEar: null as number | null,
        events: { blink: false, headLeft: false, headRight: false },
      };
      let reference: Float32Array | null = null;
      let latest: Float32Array | null = null;
      const recentLive: Float32Array[] = [];
      const MAX_RECENT_LIVE = 8;
      let lastRunAt = 0;

      const tick = async () => {
        try {
          if (!videoRef.current || done) return;
          const now = performance.now();
          if (now - lastRunAt < 55) {
            loopRef.current = requestAnimationFrame(() => void tick());
            return;
          }
          lastRunAt = now;
          const res = await detectLivenessFromVideoFrame({ video: videoRef.current, prev: state });
          setFaceDetected(res.faceDetected);
          state.blinkArmed = res.next.blinkArmed;
          state.noseCenterX = res.next.noseCenterX;
          state.prevEar = res.next.prevEar;
          state.events = res.next.events;
          setEvents(res.next.events);
          if (res.descriptor) {
            latest = res.descriptor;
            recentLive.push(copyFaceDescriptor(res.descriptor));
            if (recentLive.length > MAX_RECENT_LIVE) recentLive.shift();
            if (!reference) reference = res.descriptor;
            if (reference && latest) {
              const stab = cosineSimilarity(reference, latest);
              setSessionStability(Number.isFinite(stab) ? stab : null);
            }
            if (aadhaarFaceDescriptor && latest) {
              const dist = faceDescriptorEuclideanDistance(aadhaarFaceDescriptor, latest);
              const cos = cosineSimilarity(aadhaarFaceDescriptor, latest);
              setDistanceVsAadhaar(Number.isFinite(dist) ? dist : null);
              setCosineVsAadhaar(Number.isFinite(cos) ? cos : null);
            }
          }

          const ok = res.next.events.blink && res.next.events.headLeft && res.next.events.headRight;
          if (ok) {
            setDone(true);
            // Stop the processing loop; optionally keep stream alive for handoff.
            stop({ stopStream: !persistStreamOnPass, closeUi: !persistStreamOnPass });
            const blended =
              recentLive.length > 0
                ? averageNormalizedDescriptors(recentLive)
                : latest
                  ? averageNormalizedDescriptors([copyFaceDescriptor(latest)])
                  : null;
            const forCompare = blended ?? latest;

            const sessionStab =
              reference && latest ? cosineSimilarity(reference, latest) : undefined;
            const aadhaarDist =
              aadhaarFaceDescriptor && forCompare
                ? faceDescriptorEuclideanDistance(aadhaarFaceDescriptor, forCompare)
                : undefined;
            const aadhaarCos =
              aadhaarFaceDescriptor && forCompare
                ? cosineSimilarity(aadhaarFaceDescriptor, forCompare)
                : undefined;

            if (requireAadhaarFaceMatch && aadhaarFaceDescriptor && forCompare) {
              if (
                typeof aadhaarDist === "number" &&
                aadhaarDist > AADHAAR_LIVE_FACE_MAX_DISTANCE
              ) {
                const failMsg = `Live face does not match the photo on your Aadhaar (distance ${aadhaarDist.toFixed(3)}; need ≤ ${AADHAAR_LIVE_FACE_MAX_DISTANCE}).`;
                setLivenessFinished(true);
                setIdentityOk(false);
                setIdentityFailMessage(failMsg);
                onResult({
                  status: "fail",
                  events: res.next.events,
                  method: "face-api.js",
                  aadhaarMatchDistance: aadhaarDist,
                  aadhaarMatchSimilarity: aadhaarCos,
                  cosineSimilarity: aadhaarCos,
                  sessionStabilitySimilarity: sessionStab,
                  message: failMsg,
                });
                return;
              }
            }

            let faceHash: string | undefined;
            try {
              if (forCompare) {
                faceHash = await poseidonHashEmbedding(forCompare);
              }
            } catch {
              safeWarn("Face embedding hash failed");
            }
            setLivenessFinished(true);
            setIdentityOk(true);
            setIdentityFailMessage(null);
            onResult({
              status: "pass",
              events: res.next.events,
              method: "face-api.js",
              aadhaarMatchDistance: aadhaarDist,
              aadhaarMatchSimilarity: aadhaarCos,
              cosineSimilarity: aadhaarCos ?? sessionStab,
              sessionStabilitySimilarity: sessionStab,
              faceHash,
            });
            return;
          }
        } catch (e) {
          setError(e instanceof Error ? e.message : "Liveness check failed.");
          setDone(true);
          stop({ stopStream: true, closeUi: true });
          onResult({
            status: "fail",
            events,
            method: "face-api.js",
            cosineSimilarity: cosineVsAadhaar ?? sessionStability ?? undefined,
            aadhaarMatchDistance: distanceVsAadhaar ?? undefined,
            message: e instanceof Error ? e.message : "Liveness check failed.",
          });
          return;
        }
        loopRef.current = requestAnimationFrame(() => void tick());
      };
      loopRef.current = requestAnimationFrame(() => void tick());
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not start liveness.";
      if (/denied|permission/i.test(msg)) {
        setError("Camera permission denied. Please allow access or skip this step.");
      } else {
        setError(msg);
      }
      stop({ stopStream: true, closeUi: true });
      onResult({
        status: "fail",
        events: { blink: false, headLeft: false, headRight: false },
        method: "face-api.js",
        message: msg,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-[2rem] border border-slate-800 bg-slate-950/40 p-6 shadow-soft">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-sm font-semibold text-slate-100">Liveness (optional)</div>
          <div className="mt-1 text-sm text-slate-300">
            Blink once and turn your head left then right. This does not block proof generation.
          </div>
        </div>
        <button
          type="button"
          className="btn-primary shimmer inline-flex items-center justify-center gap-2 rounded-2xl px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50"
          disabled={busy || open}
          onClick={() => void startCamera()}
        >
          {busy ? <Spinner /> : null}
          Start liveness
        </button>
      </div>

      {error ? (
        <div className="mt-4 rounded-2xl border border-rose-400/30 bg-rose-500/10 p-4 text-sm text-rose-100">
          {error}
        </div>
      ) : null}

      {identityFailMessage ? (
        <div className="mt-4 rounded-2xl border border-amber-400/35 bg-amber-500/10 p-4 text-sm text-amber-50">
          <p className="font-semibold text-amber-100">Identity check failed</p>
          <p className="mt-1">{identityFailMessage}</p>
          <p className="mt-2 text-xs text-amber-200/90">
            Retry with the same person as on the Aadhaar photo, facing the camera, in good light.
          </p>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <Badge tone={events.blink ? "ok" : "idle"} label={events.blink ? "Blink detected" : "Blink"} />
        <Badge tone={events.headLeft ? "ok" : "idle"} label={events.headLeft ? "Head left" : "Turn left"} />
        <Badge tone={events.headRight ? "ok" : "idle"} label={events.headRight ? "Head right" : "Turn right"} />
        <Badge tone={faceDetected ? "ok" : "warn"} label={faceDetected ? "Face detected" : "No face yet"} />
        {livenessFinished && identityOk === false ? (
          <>
            <Badge tone="ok" label="Gestures done" />
            <Badge tone="warn" label="Face does not match ID" />
          </>
        ) : livenessFinished && identityOk === true ? (
          <Badge tone="ok" label="Liveness pass" />
        ) : passed ? (
          <Badge tone="ok" label="Gestures done" />
        ) : null}
      </div>
      <div className="mt-3 space-y-1 text-xs text-slate-400">
        <div>
          <span className="text-slate-300">Distance vs Aadhaar photo: </span>
          {aadhaarFaceDescriptor
            ? distanceVsAadhaar === null
              ? "…"
              : `${distanceVsAadhaar.toFixed(3)} (same person if ≤ ${AADHAAR_LIVE_FACE_MAX_DISTANCE})`
            : "— (upload Aadhaar with visible portrait)"}
        </div>
        {aadhaarFaceDescriptor && cosineVsAadhaar !== null ? (
          <div className="text-slate-500">
            Cosine (diagnostic): {cosineVsAadhaar.toFixed(3)}
          </div>
        ) : null}
        <div>
          <span className="text-slate-500">Session stability (same camera feed): </span>
          {sessionStability === null ? "—" : sessionStability.toFixed(3)}
        </div>
      </div>

      <div
        className={
          open
            ? "mt-4 space-y-3 rounded-2xl border border-slate-800 bg-slate-950/30 p-4"
            : "pointer-events-none fixed left-0 top-0 h-px w-px overflow-hidden opacity-0"
        }
        aria-hidden={!open}
      >
        <video
          ref={(el) => {
            videoRef.current = el;
            onVideoElement?.(el);
          }}
          className="h-auto max-h-72 w-full rounded-xl bg-black object-contain"
          playsInline
          muted
          autoPlay
        />
      </div>

      {open ? (
        <div className="mt-3">
          <button
            type="button"
            className="w-full rounded-2xl border border-slate-800 bg-slate-950/25 px-4 py-3 text-sm font-semibold text-slate-100 hover:border-slate-700"
            onClick={() => {
              stop({ stopStream: true, closeUi: true });
              onResult({ status: "fail", events, method: "face-api.js", message: "User closed camera." });
            }}
          >
            Close camera
          </button>
        </div>
      ) : null}
    </section>
  );
}

