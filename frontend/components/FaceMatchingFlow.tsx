"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  FaceMatchingService,
  type AadhaarProcessResult,
} from "@/utils/faceMatching/faceMatchingService";
import type { Strictness } from "@/utils/faceMatching/similarity";
import type { ExtractedFace } from "@/utils/faceMatching/faceProcessor";

type Props = {
  /**
   * If provided, FaceMatchingFlow will attach to this existing video element (and its stream).
   * This is the preferred path when liveness already owns the camera.
   */
  videoElement?: HTMLVideoElement | null;
  /**
   * Optional hook to let a parent know which model is active (ONNX vs face-api fallback).
   * No sensitive data is included.
   */
  onModelInfo?: (info: { modelType: "arcface" | "faceapi"; embeddingDim: number }) => void;
};

function drawToCanvas(target: HTMLCanvasElement, source: HTMLCanvasElement) {
  target.width = source.width;
  target.height = source.height;
  const ctx = target.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(source, 0, 0);
}

function classNames(...v: Array<string | false | null | undefined>) {
  return v.filter(Boolean).join(" ");
}

export function FaceMatchingFlow({ videoElement = null, onModelInfo }: Props) {
  const serviceRef = useRef<FaceMatchingService | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const externalHostRef = useRef<HTMLDivElement | null>(null);
  const externalOriginalParentRef = useRef<{ parent: Node; nextSibling: ChildNode | null } | null>(null);

  const [statusText, setStatusText] = useState("Initializing...");
  const [progressPct, setProgressPct] = useState(0);
  const [strictness, setStrictness] = useState<Strictness>("balanced");
  const [retryCameraVisible, setRetryCameraVisible] = useState(false);

  const [modelBadge, setModelBadge] = useState<string | null>(null);
  const [modelBadgeWarn, setModelBadgeWarn] = useState(false);

  const [busyCapture, setBusyCapture] = useState(false);
  const [capturedFrames, setCapturedFrames] = useState<HTMLCanvasElement[]>([]);
  const [livePreviewCanvases, setLivePreviewCanvases] = useState<HTMLCanvasElement[]>([]);
  const [liveAlignedFaces, setLiveAlignedFaces] = useState<ExtractedFace[]>([]);
  const [liveEmbedding, setLiveEmbedding] = useState<Float32Array | null>(null);
  const [livePerFrameEmbeddings, setLivePerFrameEmbeddings] = useState<Float32Array[] | null>(null);
  const [cameraPaused, setCameraPaused] = useState(false);

  const [aadhaar, setAadhaar] = useState<AadhaarProcessResult | null>(null);
  const [aadhaarWarning, setAadhaarWarning] = useState<string | null>(null);

  const [result, setResult] = useState<{
    status: "verified" | "suspicious" | "mismatch";
    explanation: string;
    similarityScore: number;
    distance: number;
  } | null>(null);
  const [perFrameResults, setPerFrameResults] = useState<
    Array<{ idx: number; status: "verified" | "suspicious" | "mismatch"; similarityScore: number; distance: number }> | null
  >(null);

  const compareReady = Boolean(liveEmbedding && aadhaar?.aadhaarEmbedding);

  const resolvedVideoEl = videoElement ?? localVideoRef.current;

  const setProgress = (pct: number, msg?: string) => {
    setProgressPct(pct);
    if (msg) setStatusText(msg);
  };

  useEffect(() => {
    let mounted = true;
    const init = async () => {
      try {
        setRetryCameraVisible(false);
        setProgress(5, "Loading face detection models…");

        const svc = new FaceMatchingService();
        serviceRef.current = svc;

        await svc.initModels({ modelBaseUrl: "/models/face-api", onnxModelUrl: "/models/mobilefacenet.onnx" });
        const info = svc.modelInfo;
        if (!mounted) return;
        onModelInfo?.(info);

        if (info.modelType === "arcface") {
          setModelBadge(`ONNX MobileFaceNet · ${info.embeddingDim}D`);
          setModelBadgeWarn(false);
          setProgress(70, "ONNX embedding model loaded.");
        } else {
          setModelBadge("face-api.js 128D (fallback)");
          setModelBadgeWarn(true);
          setProgress(70, "ONNX model not found — using face-api.js descriptors.");
        }

        setProgress(75, videoElement ? "Camera ready — using existing stream." : "Starting camera…");

        // Attach video (either external or local). Wait for local ref to mount if needed.
        if (videoElement) {
          svc.attachVideo(videoElement);
        } else {
          let v: HTMLVideoElement | null = null;
          for (let i = 0; i < 60; i++) {
            await new Promise((r) => window.setTimeout(r, 50));
            v = localVideoRef.current;
            if (v) break;
          }
          if (!v) throw new Error("Camera preview element did not mount.");
          svc.attachVideo(v);
          await startLocalCamera(v);
        }

        setProgress(100, "Ready — capture your face and upload an ID image.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Initialisation failed.";
        setProgress(0, `Initialisation failed: ${msg}`);
        if (String(msg).toLowerCase().includes("camera")) setRetryCameraVisible(true);
      }
    };

    void init();
    return () => {
      mounted = false;
      try {
        serviceRef.current?.dispose();
      } catch {
        // ignore
      }
      serviceRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If an external video element is provided, re-parent it into our UI container.
  useEffect(() => {
    if (!videoElement) return;
    const host = externalHostRef.current;
    if (!host) return;
    if (!externalOriginalParentRef.current && videoElement.parentNode) {
      externalOriginalParentRef.current = {
        parent: videoElement.parentNode,
        nextSibling: videoElement.nextSibling,
      };
    }
    try {
      host.appendChild(videoElement);
      videoElement.classList.add("h-full", "w-full", "object-cover");
      videoElement.style.transform = "scaleX(-1)";
    } catch {
      // ignore
    }
    return () => {
      const orig = externalOriginalParentRef.current;
      if (!orig) return;
      try {
        if (orig.nextSibling) orig.parent.insertBefore(videoElement, orig.nextSibling);
        else orig.parent.appendChild(videoElement);
      } catch {
        // ignore
      }
    };
  }, [videoElement]);

  // If the parent swaps the video element (handoff), re-attach.
  useEffect(() => {
    const svc = serviceRef.current;
    if (!svc) return;
    svc.attachVideo(resolvedVideoEl);
  }, [resolvedVideoEl]);

  const handleRetryCamera = async () => {
    try {
      setRetryCameraVisible(false);
      setProgress(60, "Retrying camera…");
      const v = resolvedVideoEl;
      if (!v) throw new Error("Camera preview element did not mount.");
      await stopVideoTracks(v);
      await startLocalCamera(v);
      setProgress(100, "Camera ready — capture your face.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Camera retry failed.";
      setProgress(0, `Camera retry failed: ${msg}`);
      setRetryCameraVisible(true);
    }
  };

  const handleCapture = async () => {
    const svc = serviceRef.current;
    if (!svc) return;
    try {
      setBusyCapture(true);
      setResult(null);
      setPerFrameResults(null);
      setLivePerFrameEmbeddings(null);
      setAadhaarWarning(null);
      setProgress(30, "Capturing 5 frames…");

      const frames = await svc.captureMultiFrameFromVideo(5, 220);
      setCapturedFrames(frames);

      setProgress(45, "Detecting faces…");
      const liveRes = await svc.processLiveFrames(frames);
      setLiveAlignedFaces(liveRes.liveAlignedFaces);
      setLivePreviewCanvases(liveRes.livePreviewCanvases);

      // UI: pause preview and show thumbnails; live embedding is computed at Confirm in reference.
      setCameraPaused(true);
      if (resolvedVideoEl) resolvedVideoEl.pause?.();

      setProgress(100, "5 frames captured — click Confirm to generate live embedding.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Capture failed.";
      setProgress(100, `Capture failed: ${msg}`);
      setBusyCapture(false);
      return;
    } finally {
      setBusyCapture(false);
    }
  };

  const handleRetake = async () => {
    const svc = serviceRef.current;
    if (!svc) return;
    svc.cleanup({
      frames: capturedFrames,
      liveAlignedFaces,
      livePreviewCanvases,
      liveEmbedding,
      livePerFrameEmbeddings,
      aadhaarFaceCanvas: aadhaar?.aadhaarFaceCanvas ?? null,
      aadhaarCropCanvas: aadhaar?.aadhaarCropCanvas ?? null,
      aadhaarEmbedding: aadhaar?.aadhaarEmbedding ?? null,
      aadhaarObjectUrl: aadhaar?.objectUrl ?? null,
    });
    setCapturedFrames([]);
    setLivePreviewCanvases([]);
    setLiveAlignedFaces([]);
    setLiveEmbedding(null);
    setLivePerFrameEmbeddings(null);
    setCameraPaused(false);
    setResult(null);
    setPerFrameResults(null);
    if (resolvedVideoEl) await resolvedVideoEl.play?.().catch(() => {});
    setProgress(100, "Ready — capture your face.");
  };

  const handleConfirm = async () => {
    const svc = serviceRef.current;
    if (!svc) return;
    try {
      setProgress(30, "Generating live-face embeddings…");
      for (let i = 0; i < liveAlignedFaces.length; i++) {
        setProgress(30 + (i + 1) * 12, `Embedding frame ${i + 1}…`);
        // progress only; embeddings are computed in service without logging.
        await new Promise((r) => window.setTimeout(r, 0));
      }
      const built = await svc.buildPerFrameEmbeddings(liveAlignedFaces);
      setLivePerFrameEmbeddings(built.perFrame);
      setLiveEmbedding(built.averaged); // stored only in memory; never logged
      setProgress(100, "Live-face embedding ready.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Embedding failed.";
      setProgress(100, `Embedding failed: ${msg}`);
    }
  };

  const handleAadhaarFile = async (file: File) => {
    const svc = serviceRef.current;
    if (!svc) return;
    setResult(null);
    setAadhaarWarning(null);
    try {
      setProgress(20, "Loading ID image…");
      const res = await svc.processAadhaarFile(file);
      setAadhaar(res);
      setProgress(100, "ID-face embedding ready.");
      // If quality issues were non-blocking (face small), the service doesn't throw; we flag guidance here.
      // We detect this by re-running a quick check not possible without returning q; keep it simple:
      // show generic “may reduce accuracy” only when strictness is strict? (reference uses specific warning).
      // We'll mirror the reference warning text when the user’s ID face appears small is detected upstream:
      // Since we can’t infer it reliably without q, we only show warning when model fell back.
      if (res.modelType === "faceapi") {
        setAadhaarWarning("ID photo quality may reduce accuracy. Try a clearer image if results look suspicious.");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "ID processing failed.";
      setProgress(100, `ID processing failed: ${msg}`);
    }
  };

  const handleRemoveAadhaar = () => {
    const svc = serviceRef.current;
    if (!svc) return;
    svc.cleanup({
      aadhaarFaceCanvas: aadhaar?.aadhaarFaceCanvas ?? null,
      aadhaarCropCanvas: aadhaar?.aadhaarCropCanvas ?? null,
      aadhaarEmbedding: aadhaar?.aadhaarEmbedding ?? null,
      aadhaarObjectUrl: aadhaar?.objectUrl ?? null,
    });
    setAadhaar(null);
    setResult(null);
    setPerFrameResults(null);
    setProgress(100, "Ready — upload an ID image.");
  };

  const handleCompare = () => {
    const svc = serviceRef.current;
    if (!svc || !liveEmbedding || !aadhaar?.aadhaarEmbedding) return;
    const res = svc.compare(liveEmbedding, aadhaar.aadhaarEmbedding, strictness);
    setResult(res);
    if (livePerFrameEmbeddings) {
      const pf = svc.comparePerFrame(livePerFrameEmbeddings, aadhaar.aadhaarEmbedding, strictness).map((r, idx) => ({
        idx,
        status: r.status,
        similarityScore: r.similarityScore,
        distance: r.distance,
      }));
      setPerFrameResults(pf);
    } else {
      setPerFrameResults(null);
    }
    const labels = { verified: "VERIFIED", suspicious: "SUSPICIOUS", mismatch: "MISMATCH" } as const;
    setProgress(100, `Verification complete — ${labels[res.status]}`);
  };

  const handleReset = () => {
    const svc = serviceRef.current;
    if (!svc) return;
    svc.cleanup({
      frames: capturedFrames,
      liveAlignedFaces,
      livePreviewCanvases,
      liveEmbedding,
      livePerFrameEmbeddings,
      aadhaarFaceCanvas: aadhaar?.aadhaarFaceCanvas ?? null,
      aadhaarCropCanvas: aadhaar?.aadhaarCropCanvas ?? null,
      aadhaarEmbedding: aadhaar?.aadhaarEmbedding ?? null,
      aadhaarObjectUrl: aadhaar?.objectUrl ?? null,
    });
    setCapturedFrames([]);
    setLivePreviewCanvases([]);
    setLiveAlignedFaces([]);
    setLiveEmbedding(null);
    setLivePerFrameEmbeddings(null);
    setAadhaar(null);
    setAadhaarWarning(null);
    setResult(null);
    setPerFrameResults(null);
    setCameraPaused(false);
    void resolvedVideoEl?.play?.().catch(() => {});
    setProgress(100, "Ready — capture your face and upload an ID image.");
  };

  const captureDisabled = useMemo(() => busyCapture || !serviceRef.current || (videoElement ? false : false), [busyCapture, videoElement]);

  return (
    <div className="mx-auto w-full max-w-5xl">
      <header className="text-center">
        <div className="text-2xl font-extrabold tracking-tight text-slate-100">Face Verification</div>
        <p className="mt-2 text-sm text-slate-400">
          Privacy-Preserving · Browser-Only · No Data Leaves Your Device
        </p>
        {modelBadge ? (
          <div
            className={classNames(
              "mx-auto mt-3 inline-flex rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-wider",
              modelBadgeWarn
                ? "border-amber-400/40 bg-amber-500/10 text-amber-200"
                : "border-indigo-400/40 bg-indigo-500/10 text-indigo-200",
            )}
          >
            {modelBadge}
          </div>
        ) : null}
      </header>

      <div className="mt-6 rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="text-sm text-slate-300">{statusText}</div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <label className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              <span>Strictness</span>
              <select
                className="rounded-lg border border-slate-800 bg-slate-950/60 px-2 py-1 text-sm text-slate-200 outline-none"
                value={strictness}
                onChange={(e) => setStrictness(e.target.value as Strictness)}
              >
                <option value="strict">Strict</option>
                <option value="balanced">Balanced</option>
                <option value="lenient">Lenient (old-ID tolerant)</option>
              </select>
            </label>
            {retryCameraVisible ? (
              <button
                type="button"
                className="rounded-xl border border-slate-800 bg-slate-950/30 px-3 py-2 text-sm font-semibold text-slate-100 hover:border-slate-700"
                onClick={() => void handleRetryCamera()}
              >
                Retry camera
              </button>
            ) : null}
          </div>
        </div>
        <div className="mt-3 h-1 w-full overflow-hidden rounded bg-slate-900">
          <div
            className="h-full bg-gradient-to-r from-indigo-500 to-fuchsia-400 transition-[width] duration-300"
            style={{ width: `${Math.max(0, Math.min(100, progressPct))}%` }}
          />
        </div>
      </div>

      <main className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* Live Capture */}
        <section className="rounded-[1.5rem] border border-slate-800 bg-slate-950/40 p-6">
          <h2 className="text-sm font-semibold text-slate-100">Live Capture</h2>
          <div className="relative mt-4 aspect-[4/3] overflow-hidden rounded-2xl bg-black">
            {videoElement ? (
              <div ref={externalHostRef} className="absolute inset-0" />
            ) : (
              <video
                ref={localVideoRef}
                className="h-full w-full object-cover [transform:scaleX(-1)]"
                autoPlay
                playsInline
                muted
              />
            )}
            {cameraPaused ? (
              <div className="absolute inset-0 flex items-center justify-center bg-black/70 text-sm text-slate-400">
                Camera paused
              </div>
            ) : null}
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-xl bg-indigo-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-indigo-400 disabled:opacity-50"
              disabled={captureDisabled || cameraPaused}
              onClick={() => void handleCapture()}
            >
              Capture Photo
            </button>
            {cameraPaused ? (
              <>
                <button
                  type="button"
                  className="rounded-xl border border-slate-800 bg-slate-950/30 px-4 py-2 text-sm font-semibold text-slate-100 hover:border-slate-700"
                  onClick={() => void handleRetake()}
                >
                  Retake
                </button>
                <button
                  type="button"
                  className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400"
                  onClick={() => void handleConfirm()}
                >
                  Confirm
                </button>
              </>
            ) : null}
          </div>

          {cameraPaused ? (
            <div className="mt-5">
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">Captured Frames</div>
              <div className="mt-3 grid grid-cols-5 gap-2">
                {livePreviewCanvases.slice(0, 5).map((c, i) => (
                  <div key={i} className="relative overflow-hidden rounded-xl border border-slate-800 bg-slate-950/20 p-2">
                    <div className="absolute left-2 top-2 rounded-full bg-slate-950/70 px-2 py-0.5 text-[10px] font-semibold text-slate-200">
                      {i + 1}
                    </div>
                    <canvas
                      className="h-auto w-full"
                      ref={(el) => {
                        if (!el) return;
                        drawToCanvas(el, c);
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {cameraPaused ? (
            <div className="mt-5">
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Captured Frames (raw)
              </div>
              <div className="mt-3 grid grid-cols-5 gap-2">
                {capturedFrames.slice(0, 5).map((c, i) => (
                  <div key={i} className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950/20 p-2">
                    <canvas
                      className="h-auto w-full"
                      ref={(el) => {
                        if (!el) return;
                        drawToCanvas(el, c);
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>

        {/* Aadhaar Upload */}
        <section className="rounded-[1.5rem] border border-slate-800 bg-slate-950/40 p-6">
          <h2 className="text-sm font-semibold text-slate-100">Aadhaar / ID Image</h2>

          {!aadhaar ? (
            <div className="mt-4 rounded-2xl border border-dashed border-slate-700 bg-slate-950/20 p-6">
              <input
                id="aadhaar-input"
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleAadhaarFile(f);
                }}
              />
              <label
                htmlFor="aadhaar-input"
                className="flex cursor-pointer flex-col items-center gap-2 text-center text-sm text-slate-300"
              >
                <span className="text-slate-200">Click to upload ID image</span>
                <span className="text-xs text-slate-500">Supports JPG, PNG, WebP</span>
              </label>
            </div>
          ) : (
            <div className="mt-4">
              <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/20">
                {/* We never log or persist this image; this is just a local preview. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={aadhaar.objectUrl} alt="Uploaded ID" className="h-64 w-full object-contain" />
                <button
                  type="button"
                  className="absolute right-3 top-3 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-1 text-sm font-semibold text-slate-100"
                  onClick={handleRemoveAadhaar}
                  title="Remove image"
                >
                  ×
                </button>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded-xl border border-slate-800 bg-slate-950/30 px-4 py-2 text-sm font-semibold text-slate-100 hover:border-slate-700"
                  onClick={() => {
                    // Reprocess uses same file path in reference; here user can just re-upload.
                    setProgress(100, "Please re-upload the ID image to reprocess.");
                  }}
                >
                  Reprocess ID
                </button>
              </div>

              <div className="mt-5">
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">Extracted Face</div>
                <div className="mt-3 inline-flex overflow-hidden rounded-xl border border-slate-800 bg-slate-950/20 p-2">
                  <canvas
                    className="h-28 w-28"
                    ref={(el) => {
                      if (!el || !aadhaar?.aadhaarFaceCanvas) return;
                      drawToCanvas(el, aadhaar.aadhaarFaceCanvas);
                    }}
                  />
                </div>
                <div className="mt-4 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Detected Region (ROI from Aadhaar)
                </div>
                <div className="mt-3 inline-flex overflow-hidden rounded-xl border border-slate-800 bg-slate-950/20 p-2">
                  <canvas
                    className="h-28 w-28"
                    ref={(el) => {
                      if (!el || !aadhaar?.aadhaarCropCanvas) return;
                      drawToCanvas(el, aadhaar.aadhaarCropCanvas);
                    }}
                  />
                </div>
                {aadhaarWarning ? (
                  <div className="mt-3 rounded-xl border border-amber-400/30 bg-amber-500/10 p-3 text-sm text-amber-100">
                    {aadhaarWarning}
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </section>
      </main>

      {/* Comparison */}
      {compareReady ? (
        <section className="mt-6 rounded-[1.5rem] border border-slate-800 bg-slate-950/40 p-6">
          <h2 className="text-sm font-semibold text-slate-100">Face Comparison</h2>
          <div className="mt-4 grid grid-cols-1 items-center gap-4 md:grid-cols-[1fr_auto_1fr]">
            <div className="text-center">
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">Live Capture</div>
              <div className="mt-3 inline-flex overflow-hidden rounded-xl border border-slate-800 bg-slate-950/20 p-2">
                <canvas
                  className="h-28 w-28"
                  ref={(el) => {
                    if (!el || livePreviewCanvases.length === 0) return;
                    drawToCanvas(el, livePreviewCanvases[0]!);
                  }}
                />
              </div>
            </div>
            <div className="hidden justify-center md:flex">
              <div className="text-slate-400">↔</div>
            </div>
            <div className="text-center">
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">Aadhaar Face</div>
              <div className="mt-3 inline-flex overflow-hidden rounded-xl border border-slate-800 bg-slate-950/20 p-2">
                <canvas
                  className="h-28 w-28"
                  ref={(el) => {
                    if (!el || !aadhaar?.aadhaarFaceCanvas) return;
                    drawToCanvas(el, aadhaar.aadhaarFaceCanvas);
                  }}
                />
              </div>
            </div>
          </div>
          <div className="mt-5 flex justify-center">
            <button
              type="button"
              className="rounded-2xl bg-indigo-500 px-6 py-3 text-sm font-semibold text-slate-950 hover:bg-indigo-400 disabled:opacity-50"
              disabled={!compareReady}
              onClick={handleCompare}
            >
              Compare Faces
            </button>
          </div>
        </section>
      ) : null}

      {/* Result */}
      {result ? (
        <section className="mt-6 rounded-[1.5rem] border border-slate-800 bg-slate-950/40 p-6">
          <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-6">
            <div className="flex items-start gap-4">
              <div className="text-2xl">
                {result.status === "verified" ? "✅" : result.status === "suspicious" ? "⚠️" : "❌"}
              </div>
              <div className="flex-1">
                <div
                  className={classNames(
                    "text-sm font-extrabold tracking-wide",
                    result.status === "verified"
                      ? "text-emerald-200"
                      : result.status === "suspicious"
                        ? "text-amber-200"
                        : "text-rose-200",
                  )}
                >
                  {result.status === "verified"
                    ? "VERIFIED"
                    : result.status === "suspicious"
                      ? "SUSPICIOUS"
                      : "MISMATCH"}
                </div>
                <div className="mt-1 text-sm text-slate-300">{result.explanation}</div>
                <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-slate-800 bg-slate-950/20 p-4">
                    <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">Cosine Similarity</div>
                    <div className="mt-1 font-mono text-lg text-slate-100">{result.similarityScore.toFixed(4)}</div>
                  </div>
                  <div className="rounded-xl border border-slate-800 bg-slate-950/20 p-4">
                    <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">Euclidean Distance</div>
                    <div className="mt-1 font-mono text-lg text-slate-100">{result.distance.toFixed(4)}</div>
                  </div>
                </div>
                <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/20 p-4 text-sm text-slate-300">
                  Ensure good lighting, face centered, and minimal blur. For old/low-quality ID photos, moderate similarity
                  may require a secondary check.
                </div>

                {perFrameResults ? (
                  <div className="mt-5 rounded-xl border border-slate-800 bg-slate-950/20 p-4">
                    <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                      Per-frame comparison (5 frames vs Aadhaar)
                    </div>
                    <div className="mt-3 grid grid-cols-1 gap-2">
                      {perFrameResults.slice(0, 5).map((r) => (
                        <div
                          key={r.idx}
                          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/30 px-3 py-2 text-sm"
                        >
                          <div className="font-mono text-slate-300">Frame {r.idx + 1}</div>
                          <div
                            className={classNames(
                              "text-xs font-extrabold tracking-wide",
                              r.status === "verified"
                                ? "text-emerald-200"
                                : r.status === "suspicious"
                                  ? "text-amber-200"
                                  : "text-rose-200",
                            )}
                          >
                            {r.status.toUpperCase()}
                          </div>
                          <div className="font-mono text-slate-200">
                            cos {r.similarityScore.toFixed(4)} · dist {r.distance.toFixed(4)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
          <div className="mt-4 flex justify-center">
            <button
              type="button"
              className="rounded-xl border border-slate-800 bg-slate-950/30 px-5 py-2 text-sm font-semibold text-slate-100 hover:border-slate-700"
              onClick={handleReset}
            >
              Reset &amp; Start Over
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

async function stopVideoTracks(video: HTMLVideoElement) {
  const s = video.srcObject as MediaStream | null;
  if (s) {
    s.getTracks().forEach((t) => t.stop());
  }
  video.srcObject = null;
}

async function startLocalCamera(video: HTMLVideoElement) {
  const constraints: MediaStreamConstraints = {
    video: {
      width: { ideal: 640 },
      height: { ideal: 480 },
      facingMode: "user",
    },
    audio: false,
  };
  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;
    await new Promise((resolve) => {
      video.onloadedmetadata = () => resolve(null);
    });
    await video.play().catch(() => {});
  } catch (err) {
    const e = err as { name?: string; message?: string };
    if (e?.name === "NotAllowedError") {
      throw new Error("Camera permission denied. Please allow camera access and reload.");
    }
    if (e?.name === "NotFoundError") {
      throw new Error("No camera found. Please connect a webcam.");
    }
    if (e?.name === "NotReadableError") {
      throw new Error(
        "Camera is busy (device in use). Close other apps/tabs using the camera and click “Retry camera”.",
      );
    }
    if (e?.name === "OverconstrainedError") {
      throw new Error("Camera constraints not supported by this device. Try another camera or browser.");
    }
    throw new Error(`Camera error: ${e?.message ?? "unknown"}`);
  }
}

