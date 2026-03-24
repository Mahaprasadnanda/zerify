"use client";

import type { ChangeEvent } from "react";
import { useId, useState } from "react";

import { verifyProof } from "@/lib/api";
import {
  type AadhaarVerificationResult,
  verifyAadhaarSecureQr,
} from "@/utils/aadhaarVerifier";
import {
  type AgeProofGenerationResult,
  DEMO_AGE_MIN,
  generateAgeProofFromDob,
} from "@/utils/ageProof";
import { decodeQrFromFile } from "@/utils/qrDecoder";

const acceptedFileTypes = "image/png,image/jpeg,image/jpg";

type StepStatus = "idle" | "running" | "success" | "error";

function Badge({ status, label }: { status: StepStatus; label: string }) {
  const styles =
    status === "success"
      ? "border-emerald-400/35 bg-emerald-500/10 text-emerald-100"
      : status === "running"
        ? "border-sky-400/35 bg-sky-400/10 text-sky-100"
        : status === "error"
          ? "border-rose-400/30 bg-rose-500/10 text-rose-100"
          : "border-slate-800 bg-slate-950/40 text-slate-300";

  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${styles}`}>
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          status === "success"
            ? "bg-sky-300"
            : status === "running"
              ? "bg-blue-300"
              : status === "error"
                ? "bg-rose-300"
                : "bg-slate-500"
        }`}
      />
      {label}
    </span>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950/40 px-4 py-4">
      <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
        {label}
      </div>
      <div className="mt-2 text-lg font-semibold text-slate-100">{value}</div>
    </div>
  );
}

function Spinner() {
  return (
    <span
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white/90"
      aria-hidden="true"
    />
  );
}

export function QRScanner() {
  const inputId = useId();

  const [decodedPayload, setDecodedPayload] = useState<string | null>(null);
  const [verificationResult, setVerificationResult] =
    useState<AadhaarVerificationResult | null>(null);
  const [ageProofResult, setAgeProofResult] =
    useState<AgeProofGenerationResult | null>(null);
  const [backendAgeProofVerified, setBackendAgeProofVerified] =
    useState<boolean | null>(null);
  const [addressProofStatus, setAddressProofStatus] = useState<
    "idle" | "generating" | "not-implemented"
  >("idle");
  const [selectedFileName, setSelectedFileName] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [ageProofError, setAgeProofError] = useState<string | null>(null);
  const [addressProofError, setAddressProofError] = useState<string | null>(null);
  const [isDecoding, setIsDecoding] = useState(false);
  const [isGeneratingAgeProof, setIsGeneratingAgeProof] = useState(false);

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    setDecodedPayload(null);
    setVerificationResult(null);
    setAgeProofResult(null);
    setBackendAgeProofVerified(null);
    setError(null);
    setAgeProofError(null);
    setAddressProofError(null);
    setAddressProofStatus("idle");
    setSelectedFileName(file?.name ?? "");

    if (!file) return;

    setIsDecoding(true);

    try {
      const payload = await decodeQrFromFile(file);

      if (!payload) {
        throw new Error("No readable QR code was found in the selected image.");
      }

      setDecodedPayload(payload);
      setVerificationResult(await verifyAadhaarSecureQr(payload));
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to decode QR code from the image.",
      );
    } finally {
      setIsDecoding(false);

      if (event.target) {
        event.target.value = "";
      }
    }
  };

  const handleGenerateAgeProof = async () => {
    if (!verificationResult?.isValid || !verificationResult.data.dob) {
      setAgeProofError("Verify a signed Aadhaar QR with a DOB before generating an age proof.");
      return;
    }

    setIsGeneratingAgeProof(true);
    setAgeProofResult(null);
    setBackendAgeProofVerified(null);
    setAgeProofError(null);

    try {
      const proofResult = await generateAgeProofFromDob(verificationResult.data.dob);
      setAgeProofResult(proofResult);

      // Only the proof and public signals (+ request binding) are sent to the backend.
      // The verified Aadhaar DOB itself never leaves the browser.
      const backendResult = await verifyProof({
        proof: proofResult.proof,
        publicSignals: proofResult.publicSignals,
        requestContext: {
          createdAt: proofResult.proofCreatedAtMs,
          checks: ["age"],
          constraints: {
            minAge: DEMO_AGE_MIN,
            requiredGender: "",
            pincodes: [],
          },
        },
      });

      setBackendAgeProofVerified(backendResult.verified);

      if (!backendResult.verified) {
        throw new Error(backendResult.message);
      }
    } catch (err) {
      setAgeProofError(
        err instanceof Error
          ? err.message
          : "Failed to generate or verify the age proof.",
      );
    } finally {
      setIsGeneratingAgeProof(false);
    }
  };

  const handleGenerateAddressProof = async () => {
    if (!verificationResult?.isValid || !verificationResult.data.address) {
      setAddressProofError("Verify a signed Aadhaar QR with an address before generating an address proof.");
      return;
    }

    setAddressProofError(null);
    setAddressProofStatus("generating");

    try {
      // Placeholder for the next circuit (state/city/pincode membership etc.)
      // We keep the button and UX now; we’ll wire artifacts in the next step.
      throw new Error("Address proof is not implemented yet.");
    } catch (err) {
      setAddressProofStatus("not-implemented");
      setAddressProofError(err instanceof Error ? err.message : "Address proof failed.");
    }
  };

  const isVerified = verificationResult?.isValid ?? false;
  const verifiedData = verificationResult?.data;

  const scanStatus: StepStatus =
    error ? "error" : isDecoding ? "running" : decodedPayload ? "success" : "idle";

  const signatureStatus: StepStatus = verificationResult
    ? isVerified
      ? "success"
      : "error"
    : "idle";

  const proofStatus: StepStatus = ageProofError
    ? "error"
    : isGeneratingAgeProof
      ? "running"
      : ageProofResult
        ? "success"
        : "idle";

  const backendStatus: StepStatus =
    backendAgeProofVerified === true
      ? "success"
      : backendAgeProofVerified === false
        ? "error"
        : "idle";

  const canGenerateProof =
    isVerified && Boolean(verificationResult?.data.dob) && !isGeneratingAgeProof;

  return (
    <div className="gradient-border">
      <section className="card-glass rounded-[2rem] border border-slate-800/70 p-7 shadow-soft md:p-10">
        <div className="flex items-start justify-between gap-6">
          <div className="space-y-1">
            <h2 className="text-2xl font-semibold tracking-tight text-slate-50">
              KYC verification
            </h2>
            <p className="text-base leading-7 text-slate-300">
              Simple flow. One primary action at a time.
            </p>
          </div>
          <div className="hidden flex-wrap gap-2 md:flex">
            <Badge status={scanStatus} label="Scan" />
            <Badge status={signatureStatus} label="Signature" />
            <Badge status={proofStatus} label="Age proof" />
            <Badge status={backendStatus} label="Backend" />
          </div>
        </div>

        <div className="mt-7 grid gap-4 lg:grid-cols-[1fr_240px]">
          <div className="rounded-2xl border border-slate-800/80 bg-slate-950/30 p-5">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <div className="text-sm font-semibold text-slate-100">Step 1 — Upload</div>
                <div className="text-sm text-slate-400">
                  {selectedFileName
                    ? `Selected: ${selectedFileName}`
                    : "Choose a PNG/JPG Aadhaar QR image."}
                </div>
              </div>
              {isDecoding ? (
                <div className="inline-flex items-center gap-2 rounded-full border border-blue-400/35 bg-blue-400/10 px-4 py-2 text-sm font-semibold text-blue-100">
                  <Spinner />
                  Scanning…
                </div>
              ) : null}
            </div>

            <div className="mt-4">
              <label htmlFor={inputId} className="inline-flex cursor-pointer">
                <span className="btn-primary shimmer rounded-2xl px-5 py-3 text-sm font-semibold text-slate-950">
                  Choose file
                </span>
              </label>
              <input
                id={inputId}
                type="file"
                accept={acceptedFileTypes}
                capture="environment"
                className="sr-only"
                onChange={handleFileChange}
              />
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800/80 bg-slate-950/30 p-5">
            <div className="text-sm font-semibold text-slate-100">Status</div>
            <div className="mt-3 grid gap-2 text-sm text-slate-300">
              <div className="flex items-center justify-between">
                <span>Signature</span>
                <span
                  className={
                    isVerified
                      ? "text-emerald-200"
                      : verificationResult
                        ? "text-rose-200"
                        : "text-slate-400"
                  }
                >
                  {verificationResult ? (isVerified ? "Verified" : "Invalid") : "—"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span>Age proof</span>
                <span className={ageProofResult ? "text-sky-200" : "text-slate-400"}>
                  {ageProofResult ? "Ready" : "—"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span>Backend</span>
                <span
                  className={
                    backendAgeProofVerified === true
                      ? "text-emerald-200"
                      : backendAgeProofVerified === false
                        ? "text-rose-200"
                        : "text-slate-400"
                  }
                >
                  {backendAgeProofVerified === null
                    ? "—"
                    : backendAgeProofVerified
                      ? "Verified"
                      : "Rejected"}
                </span>
              </div>
            </div>
          </div>
        </div>

      {verificationResult ? (
        <div
          className={`mt-6 rounded-2xl border px-5 py-4 text-base font-semibold ${
            isVerified
              ? "border-emerald-400/35 bg-emerald-500/10 text-emerald-100"
              : "border-rose-400/30 bg-rose-500/10 text-rose-100"
          }`}
        >
          {isVerified ? "UIDAI signature verified" : "Signature invalid / QR tampered"}
        </div>
      ) : null}

      {isVerified ? (
        <div className="mt-7 grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" value={verifiedData?.name ?? "—"} />
            <Field label="Date of birth" value={verifiedData?.dob ?? "—"} />
            <Field label="Gender" value={verifiedData?.gender ?? "—"} />
            <div className="sm:col-span-2">
              <div className="rounded-2xl border border-slate-800 bg-slate-950/40 px-4 py-4">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                  Address
                </div>
                <div className="mt-2 text-base leading-7 text-slate-100">
                  {verifiedData?.address ?? "—"}
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-5">
            <div className="text-sm font-semibold text-slate-100">Step 2 — Prove</div>
            <div className="mt-4 grid gap-3">
              <button
                type="button"
                onClick={handleGenerateAgeProof}
                disabled={!canGenerateProof}
                className="btn-primary shimmer rounded-2xl px-5 py-3 text-base font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isGeneratingAgeProof ? (
                  <span className="inline-flex items-center gap-2">
                    <Spinner /> Generating age proof…
                  </span>
                ) : (
                  "Generate age ≥ 18 proof"
                )}
              </button>

              <button
                type="button"
                onClick={handleGenerateAddressProof}
                disabled={!verifiedData?.address || addressProofStatus === "generating"}
                className="btn-success shimmer rounded-2xl px-5 py-3 text-base font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {addressProofStatus === "generating" ? (
                  <span className="inline-flex items-center gap-2">
                    <Spinner /> Generating address proof…
                  </span>
                ) : (
                  "Generate address proof"
                )}
              </button>
            </div>

            {ageProofResult ? (
              <div className="mt-5 rounded-2xl border border-slate-800 bg-slate-950/40 p-4 text-sm text-slate-200">
                <div className="flex items-center justify-between gap-4">
                  <span className="font-semibold">Age proof</span>
                  <span className="text-slate-400">{ageProofResult.currentYear}</span>
                </div>
                <div className="mt-2 text-sm text-slate-300">
                  Backend:{" "}
                  <span className="font-semibold text-slate-100">
                    {backendAgeProofVerified === null
                      ? "pending"
                      : backendAgeProofVerified
                        ? "verified"
                        : "rejected"}
                  </span>
                </div>
              </div>
            ) : null}

            {ageProofError ? (
              <div className="mt-5 rounded-2xl border border-rose-400/30 bg-rose-500/10 p-4 text-sm text-rose-100">
                {ageProofError}
              </div>
            ) : null}

            {addressProofError ? (
              <div className="mt-5 rounded-2xl border border-rose-400/30 bg-rose-500/10 p-4 text-sm text-rose-100">
                {addressProofError}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="mt-6 rounded-2xl border border-rose-400/30 bg-rose-500/10 p-4 text-sm text-rose-100">
          {error}
        </div>
      ) : null}
      </section>
    </div>
  );
}
