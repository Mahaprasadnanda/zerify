import { get, onValue, ref, update } from "firebase/database";
import { Buffer } from "buffer";
import { Camera } from "./camera.js";
import { loadFaceApiModels, detectAndExtractFace } from "./faceProcessor.js";
import { EmbeddingEngine } from "./embeddingEngine.js";
import { compare, averageEmbeddings } from "./similarity.js";
import { cleanup, revokeURL } from "./privacyGuard.js";
import { assessFaceQuality } from "./quality.js";
import { firebaseDb } from "./firebaseClient.js";
import { decodeQrFromFile } from "./qrDecoder.js";
import { normalizeSecureQrPayload, verifyAadhaarSecureQr } from "./aadhaarVerifier.js";
import { aadhaarGenderToCircuitCode, gendersMatch } from "./gender.js";
import {
  buildCommitmentFromFields,
  extractBirthYearFromDob,
  generateFlexibleKycCommitmentProof,
  generateFlexibleKycProof,
  kycAnchorYearUtc,
  pickWitnessPincodeForCommitment,
  poseidonHashEmbedding,
} from "./zkp.js";
import "./styles.css";

const $ = (id) => document.getElementById(id);

// circomlibjs poseidon code paths may expect the Node `buffer` global.
globalThis.Buffer = Buffer;
// Some deps also look for a `process` global.
if (!globalThis.process) globalThis.process = { env: {} };
const statusText = $("status-text");
const progressFill = $("progress-fill");
const modelBadge = $("model-badge");
const strictnessSelect = $("strictness");
const videoEl = $("camera-feed");
const cameraOverlay = $("camera-overlay");
const btnLiveness = $("btn-liveness");
const btnRetake = $("btn-retake");
const btnConfirm = $("btn-confirm");
const livenessNote = $("liveness-note");
const livenessInstruction = $("liveness-instruction");
const framesPreview = $("frames-preview");
const framesGrid = framesPreview?.querySelector(".frames-grid");
const aadhaarInput = $("aadhaar-input");
const uploadArea = $("upload-area");
const aadhaarPreview = $("aadhaar-preview");
const aadhaarImg = $("aadhaar-img");
const btnRemoveAadhaar = $("btn-remove-aadhaar");
const btnReprocessAadhaar = $("btn-reprocess-aadhaar");
const aadhaarFacePreview = $("aadhaar-face-preview");
const aadhaarFaceCanvas = $("aadhaar-face-canvas");
const comparisonSection = $("comparison");
const compareLive = $("compare-live");
const compareAadhaar = $("compare-aadhaar");
const btnCompare = $("btn-compare");
const resultSection = $("result");
const resultIcon = $("result-icon");
const resultStatus = $("result-status");
const resultExplanation = $("result-explanation");
const metricSimilarity = $("metric-similarity");
const metricDistance = $("metric-distance");
const btnReset = $("btn-reset");
const btnProof = $("btn-proof");
const proofNote = $("proof-note");
const handoffContext = $("handoff-context");
const requestMeta = $("request-meta");
const constraintPills = $("constraint-pills");
const purposeLine = $("purpose-line");
const qrGateNote = $("qr-gate-note");
const verifierProofStatusRows = $("verifier-proof-status-rows");
const qrChecks = $("qr-checks");
const qrUidaiStatus = $("qr-uidai-status");
const qrAgeStatus = $("qr-age-status");
const qrGenderStatus = $("qr-gender-status");
const qrAddressStatus = $("qr-address-status");
const qrAgeRow = $("qr-age-row");
const qrGenderRow = $("qr-gender-row");
const qrAddressRow = $("qr-address-row");
const qrExtractedLine = $("qr-extracted-line");
const qrChecksStatusNote = $("qr-checks-status-note");
const btnLogout = $("btn-logout");

const STORAGE_KEY = "zerify.user.session";
const params = new URLSearchParams(window.location.search);
const requestId = params.get("request_id") || "";
const sessionToken = params.get("session_token") || "";
const handoffPhone = params.get("phone") || "";
const returnUrlParam = params.get("return_url") || "";
const RETURN_URL_KEY = "zerify.faceMatching.returnUrl";

let camera = null;
let embeddingEngine = null;
let modelType = "arcface";
let livenessPassed = false;
let qrAndConstraintsPassed = false;
let faceMatchStatus = null;
let faceMatchComparisonStatus = null; // verified | suspicious | mismatch (from compare)
let requestCtx = null;
let sessionPhone = null;
let capturedFrames = [];
let liveAlignedFaces = [];
let liveEmbedding = null;
let aadhaarAlignedData = null;
let aadhaarEmbedding = null;
let aadhaarObjectUrl = null;
let lastAadhaarFile = null;
let extractedFields = null;
let verificationUnsub = null;

function setProofNote(kind, text) {
  if (!proofNote) return;
  proofNote.textContent = text ?? "";
  proofNote.classList.remove("proof-note-success", "proof-note-error", "proof-note-info");
  if (kind === "success") proofNote.classList.add("proof-note-success");
  else if (kind === "error") proofNote.classList.add("proof-note-error");
  else if (kind === "info") proofNote.classList.add("proof-note-info");
}

function setProgress(pct, msg) {
  progressFill.style.width = `${pct}%`;
  if (msg) statusText.textContent = msg;
}
function drawToCanvas(target, source) {
  target.width = source.width;
  target.height = source.height;
  target.getContext("2d").drawImage(source, 0, 0);
}
function decodeSessionToken(token) {
  const padded = token.replace(/-/g, "+").replace(/_/g, "/");
  const normalized = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  return decodeURIComponent(escape(atob(normalized)));
}
function computeAgeFromDob(dob) {
  return new Date().getFullYear() - Number(String(dob).slice(-4));
}
function addressMatchesAnyAllowedPincode(address, allowedPincodes) {
  const allowed = new Set((allowedPincodes || []).map((p) => String(p).replace(/\D/g, "")).filter((d) => d.length === 6));
  const found = String(address || "").match(/\b\d{6}\b/g) ?? [];
  return found.some((pc) => allowed.has(pc));
}
function clearFramesGrid() {
  if (!framesGrid) return;
  framesGrid.querySelectorAll(".frame").forEach((el) => el.remove());
}
function renderFrameTile(index, alignedFaceCanvas) {
  if (!framesGrid) return;
  const tile = document.createElement("div");
  tile.className = "frame";
  const label = document.createElement("span");
  label.className = "frame-label";
  label.textContent = String(index + 1);
  tile.appendChild(label);
  const preview = document.createElement("canvas");
  drawToCanvas(preview, alignedFaceCanvas);
  tile.appendChild(preview);
  framesGrid.appendChild(tile);
}
function checkCompareReady() {
  const ready = liveEmbedding && aadhaarEmbedding;
  comparisonSection.classList.toggle("hidden", !ready);
  btnCompare.disabled = !ready;
}
function updateLivenessEnablement() {
  btnLiveness.disabled = !qrAndConstraintsPassed;
  livenessNote.textContent = qrAndConstraintsPassed
    ? "Liveness unlocked. Run liveness check until criteria are met."
    : "Complete QR+constraints checks first.";
  if (livenessInstruction) {
    livenessInstruction.classList.remove("success", "warn");
    livenessInstruction.textContent = qrAndConstraintsPassed
      ? "Ready: Look straight, then turn LEFT, RIGHT, and BLINK."
      : "Complete QR checks to unlock liveness.";
  }
}

function setLivenessInstruction(text, tone = "normal") {
  if (!livenessInstruction) return;
  livenessInstruction.classList.remove("success", "warn");
  if (tone === "success") livenessInstruction.classList.add("success");
  if (tone === "warn") livenessInstruction.classList.add("warn");
  livenessInstruction.textContent = text;
}

function setQrStatus(el, ok) {
  if (!el) return;
  if (ok === null || ok === undefined) {
    el.textContent = "—";
    el.classList.remove("pass", "fail");
    el.classList.add("pending");
    return;
  }
  el.textContent = ok ? "PASS" : "FAIL";
  el.classList.remove("pass", "fail", "pending");
  el.classList.add(ok ? "pass" : "fail");
}

function setConstraintRowsVisibility() {
  const checks = requestCtx?.checks ?? [];
  const showAge = checks.includes("age");
  const showGender = checks.includes("gender");
  const showAddress = checks.includes("address");
  if (qrAgeRow) qrAgeRow.classList.toggle("hidden", !showAge);
  if (qrGenderRow) qrGenderRow.classList.toggle("hidden", !showGender);
  if (qrAddressRow) qrAddressRow.classList.toggle("hidden", !showAddress);
}

function createVerifierStatusRow(label, value) {
  const row = document.createElement("div");
  row.className = "verifier-proof-status-row";
  const left = document.createElement("span");
  left.className = "label";
  left.textContent = label;
  const right = document.createElement("span");
  right.className = "value";
  if (value === true) {
    right.textContent = "PASSED";
    right.classList.add("passed");
  } else if (value === false) {
    right.textContent = "FAILED";
    right.classList.add("failed");
  } else {
    right.textContent = "PENDING";
    right.classList.add("pending");
  }
  row.appendChild(left);
  row.appendChild(right);
  return row;
}

function renderVerifierStatus(verification) {
  if (!verifierProofStatusRows) return;
  verifierProofStatusRows.innerHTML = "";
  const checks = requestCtx?.checks ?? [];
  const byCheck = {
    age: verification?.ageVerified ?? null,
    gender: verification?.genderVerified ?? null,
    address: verification?.addressVerified ?? null,
  };
  const labels = {
    age: "Age",
    gender: "Gender",
    address: "Address",
  };
  for (const check of checks) {
    verifierProofStatusRows.appendChild(
      createVerifierStatusRow(labels[check] ?? check, byCheck[check]),
    );
  }
  if (checks.length === 0) {
    verifierProofStatusRows.appendChild(createVerifierStatusRow("Verification", null));
  }
}

function subscribeVerificationStatus() {
  if (verificationUnsub) {
    verificationUnsub();
    verificationUnsub = null;
  }
  if (!requestCtx?.requestId || !sessionPhone) return;
  const vRef = ref(firebaseDb, `kycRequests/${requestCtx.requestId}/users/${sessionPhone}/verification`);
  verificationUnsub = onValue(vRef, (snap) => {
    renderVerifierStatus(snap.exists() ? snap.val() : null);
  });
}

async function loadRequestContext() {
  if (!requestId || !sessionPhone) {
    requestMeta.textContent = "Missing request_id or session; open from KYC request page.";
    return;
  }
  const idxSnap = await get(ref(firebaseDb, `indices/userRequests/${sessionPhone}/${requestId}`));
  if (!idxSnap.exists()) {
    requestMeta.textContent = "Request not found for this user.";
    return;
  }
  const idx = idxSnap.val();
  const rSnap = await get(ref(firebaseDb, `kycRequests/${requestId}`));
  const full = rSnap.exists() ? rSnap.val() : null;
  requestCtx = {
    requestId,
    createdAt: full?.createdAt ?? idx.createdAt ?? Date.now(),
    checks: idx.checks ?? full?.checks ?? [],
    constraints: idx.constraints ?? full?.constraints ?? { minAge: 18, requiredGender: "", pincodes: [] },
    purpose: idx.purpose ?? full?.purpose ?? "",
    nonce: full?.nonce ?? idx?.nonce ?? full?.security?.nonce ?? idx?.security?.nonce ?? null,
    security: full?.security ?? idx?.security ?? {},
  };
  requestMeta.textContent = `Verifier checks loaded for request ${requestId}`;
  const pills = [];
  if (requestCtx.checks.includes("age")) pills.push(`Age >= ${requestCtx.constraints.minAge}`);
  if (requestCtx.checks.includes("gender") && requestCtx.constraints.requiredGender) pills.push(`Gender = ${requestCtx.constraints.requiredGender}`);
  if (requestCtx.checks.includes("address") && requestCtx.constraints.pincodes?.length) pills.push(`Pincode in {${requestCtx.constraints.pincodes.join(", ")}}`);
  constraintPills.textContent = pills.join(" | ") || "No verifier constraints";
  setConstraintRowsVisibility();
  if (purposeLine) {
    purposeLine.textContent = requestCtx.purpose ? `Purpose: ${requestCtx.purpose}` : "";
    purposeLine.classList.toggle("hidden", !requestCtx.purpose);
  }
  renderVerifierStatus(null);
  subscribeVerificationStatus();
}

async function init() {
  try {
    if (returnUrlParam) sessionStorage.setItem(RETURN_URL_KEY, returnUrlParam);
    if (sessionToken) {
      const decoded = decodeSessionToken(sessionToken);
      sessionStorage.setItem(STORAGE_KEY, decoded);
      localStorage.removeItem(STORAGE_KEY);
    }
    const raw = sessionStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(STORAGE_KEY);
    if (raw) {
      // Migrate legacy persistent session into tab-scoped session.
      sessionStorage.setItem(STORAGE_KEY, raw);
      localStorage.removeItem(STORAGE_KEY);
    }
    sessionPhone = raw ? JSON.parse(raw).phone ?? null : null;
    if (!sessionPhone) {
      // Block access when no active authenticated prover session exists.
      const target = resolveReturnUrl();
      window.location.replace(target);
      return;
    }
    handoffContext.textContent = `Request: ${requestId || "-"} · User: ${handoffPhone || sessionPhone || "-"}`;
    await loadRequestContext();
    updateLivenessEnablement();
    const base = import.meta.env.BASE_URL || "/";
    await loadFaceApiModels(`${base}models/face-api`);
    embeddingEngine = new EmbeddingEngine();
    const onnxOk = await embeddingEngine.load(`${base}models/mobilefacenet.onnx`);
    modelType = onnxOk ? "arcface" : "faceapi";
    // Model badge intentionally hidden for cleaner UX.
    if (modelBadge) {
      modelBadge.textContent = onnxOk ? `ONNX MobileFaceNet · ${embeddingEngine.embeddingDim}D` : "face-api.js 128D (fallback)";
    }
    camera = new Camera(videoEl);
    await camera.start();
    setProgress(100, "Ready — upload Aadhaar to run QR checks.");
  } catch (err) {
    setProgress(100, `Init failed: ${err.message}`);
  }
}

function resolveReturnUrl() {
  const stored = sessionStorage.getItem(RETURN_URL_KEY) || "";
  if (stored) return stored;

  // Optional explicit verifier URL (production-safe, no localhost defaults)
  // Example: VITE_VERIFIER_URL=https://app.zerify.tech
  try {
    const envUrl = import.meta?.env?.VITE_VERIFIER_URL;
    if (typeof envUrl === "string" && envUrl.trim()) return envUrl.trim();
  } catch {
    // ignore
  }

  const ref = document.referrer || "";
  // If user came from another site/port, referrer is a good fallback.
  if (ref) return ref;

  // Final fallback: same origin (no hardcoded port/path).
  return window.location.origin;
}

btnLogout?.addEventListener("click", () => {
  const target = resolveReturnUrl();
  try {
    sessionStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
  try {
    sessionStorage.removeItem(RETURN_URL_KEY);
  } catch {}
  // `replace` prevents navigating back into KYC Verification after logout.
  window.location.replace(target);
});

async function runLivenessCheckUntilCriteriaPassed() {
  // No hard 15-second rule.
  // Keep sampling until left + right + blink are detected,
  // with a safety timeout to avoid infinite loops.
  const maxMs = 45_000;
  const sampleEveryMs = 220;
  const capturedTarget = 5;

  const baselineSamples = 4;
  let baselineOffsets = [];
  let baseline = null;

  let turnedLeft = false;
  let turnedRight = false;
  let blinkDetected = false;
  let blinkStreak = 0;

  const blinkThreshold = 0.26;
  const leftRightDelta = 0.035;

  let captured = [];

  const started = performance.now();
  while (performance.now() - started < maxMs) {
    const frame = camera.captureFrame();
    const det = await detectAndExtractFace(frame, 0.4, 0.18);

    if (det?.keypoints && det?.keypoints?.length >= 3) {
      const l = det.keypoints[0]?.[0];
      const r = det.keypoints[1]?.[0];
      const n = det.keypoints[2]?.[0];

      if (typeof l === "number" && typeof r === "number" && typeof n === "number") {
        const eyeCenter = (l + r) / 2;
        const eyeDist = Math.max(1e-3, Math.abs(r - l));
        const offset = (n - eyeCenter) / eyeDist;

        if (baseline === null) {
          baselineOffsets.push(offset);
          if (baselineOffsets.length >= baselineSamples) {
            baseline = baselineOffsets.reduce((a, b) => a + b, 0) / baselineOffsets.length;
          }
        } else {
          if (offset < baseline - leftRightDelta) turnedLeft = true;
          if (offset > baseline + leftRightDelta) turnedRight = true;
        }
      }

      // Blink: consecutive frames with low eye aspect ratio
      if (typeof det.eyeAspectRatio === "number") {
        if (det.eyeAspectRatio < blinkThreshold) {
          blinkStreak += 1;
          if (blinkStreak >= 2) blinkDetected = true;
        } else {
          blinkStreak = 0;
        }
      }

      // Capture up to 5 frames during liveness.
      if (captured.length < capturedTarget) captured.push(frame);
    }

    const elapsed = performance.now() - started;
    const pct = Math.min(99, Math.round((elapsed / maxMs) * 100));

    let msg = "Liveness: keep going…";
    if (baseline === null) msg = "Liveness: look straight";
    else if (!turnedLeft) msg = "Liveness: turn LEFT";
    else if (!turnedRight) msg = "Liveness: turn RIGHT";
    else if (!blinkDetected) msg = "Liveness: blink";
    else msg = "Liveness: criteria met";
    setProgress(pct, msg);
    if (baseline === null) setLivenessInstruction("LOOK STRAIGHT", "warn");
    else if (!turnedLeft) setLivenessInstruction("TURN LEFT", "warn");
    else if (!turnedRight) setLivenessInstruction("TURN RIGHT", "warn");
    else if (!blinkDetected) setLivenessInstruction("BLINK", "warn");
    else setLivenessInstruction("CRITERIA MET", "success");

    if (baseline !== null && turnedLeft && turnedRight && blinkDetected && captured.length >= capturedTarget) {
      break;
    }

    await new Promise((r) => setTimeout(r, sampleEveryMs));
  }

  if (!(turnedLeft && turnedRight && blinkDetected && captured.length >= capturedTarget)) {
    const reasons = [];
    if (!turnedLeft) reasons.push("left turn");
    if (!turnedRight) reasons.push("right turn");
    if (!blinkDetected) reasons.push("blink");
    throw new Error(`Liveness failed — missing: ${reasons.join(", ")}. Please retry.`);
  }

  return captured.slice(0, capturedTarget);
}

async function processCapturedFrames(frames) {
  capturedFrames = frames;
  liveAlignedFaces = [];
  clearFramesGrid();
  for (let i = 0; i < capturedFrames.length; i++) {
    const det = await detectAndExtractFace(capturedFrames[i], 0.5, 0.18);
    if (!det) throw new Error(`No face in frame ${i + 1}`);
    const q = assessFaceQuality({
      alignedFace: det.alignedFace,
      score: det.score,
      box: det.box,
      sourceDims: { width: capturedFrames[i].width, height: capturedFrames[i].height },
      policy: { minScore: 0.8, minFaceFrac: 0.12, minBlurScore: 55 },
    });
    if (!q.ok) throw new Error(`Low quality frame ${i + 1}`);
    liveAlignedFaces.push(det);
    renderFrameTile(i, det.alignedFace);
  }
  framesPreview.classList.remove("hidden");
  btnRetake.classList.remove("hidden");
  btnConfirm.classList.remove("hidden");
  cameraOverlay.classList.remove("hidden");
  videoEl.pause();
}

btnLiveness.addEventListener("click", async () => {
  try {
    if (!qrAndConstraintsPassed) throw new Error("Complete QR checks first.");
    const frames = await runLivenessCheckUntilCriteriaPassed();
    await processCapturedFrames(frames);
    livenessPassed = true;
    setLivenessInstruction("LIVENESS PASSED", "success");
    setProgress(100, "Liveness passed. Click Confirm or Retake.");
  } catch (err) {
    setLivenessInstruction("Retry liveness. Follow prompts exactly.", "warn");
    setProgress(100, err.message);
  }
});

btnRetake.addEventListener("click", () => {
  cleanup({ frames: capturedFrames, aligned: liveAlignedFaces });
  capturedFrames = [];
  liveAlignedFaces = [];
  liveEmbedding = null;
  clearFramesGrid();
  framesPreview.classList.add("hidden");
  btnRetake.classList.add("hidden");
  btnConfirm.classList.add("hidden");
  cameraOverlay.classList.add("hidden");
  resultSection.classList.add("hidden");
  videoEl.play();
  setLivenessInstruction("Ready: Look straight, then turn LEFT, RIGHT, and BLINK.");
  checkCompareReady();
});

btnConfirm.addEventListener("click", async () => {
  try {
    const embeddings = [];
    for (const face of liveAlignedFaces) {
      let emb = null;
      if (modelType === "arcface" && embeddingEngine?.isLoaded) emb = await embeddingEngine.getEmbedding(face.alignedFace);
      embeddings.push(emb ?? face.descriptor);
    }
    liveEmbedding = averageEmbeddings(embeddings);
    drawToCanvas(compareLive, liveAlignedFaces[0].alignedFace);
    checkCompareReady();
    setProgress(100, "Live-face embedding ready.");
  } catch (err) {
    setProgress(100, `Embedding failed: ${err.message}`);
  }
});

async function processAadhaarFile(file) {
  try {
    qrAndConstraintsPassed = false;
    updateLivenessEnablement();
    if (aadhaarObjectUrl) revokeURL(aadhaarObjectUrl);
    const img = await loadImage(file);
    aadhaarObjectUrl = img.src;
    aadhaarImg.src = aadhaarObjectUrl;
    aadhaarPreview.classList.remove("hidden");
    uploadArea.classList.add("hidden");
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext("2d").drawImage(img, 0, 0);
    const det = await detectAndExtractFace(c, 0.35, 0.2);
    if (!det) throw new Error("No face in Aadhaar image");
    aadhaarAlignedData = det;
    drawToCanvas(aadhaarFaceCanvas, det.alignedFace);
    aadhaarFacePreview.classList.remove("hidden");
    aadhaarEmbedding = modelType === "arcface" && embeddingEngine?.isLoaded
      ? await embeddingEngine.getEmbedding(det.alignedFace)
      : det.descriptor;
    drawToCanvas(compareAadhaar, det.alignedFace);

    const qrRaw = await decodeQrFromFile(file);
    const verification = await verifyAadhaarSecureQr(normalizeSecureQrPayload(qrRaw));
    if (!verification.isValid) throw new Error("UIDAI signature verification failed.");
    const { dob, gender, address, name } = verification.data;
    if (!dob || !gender || !address) throw new Error("Missing DOB/Gender/Address in QR.");
    extractedFields = { name: name ?? "—", dob, gender, address };
    const checks = requestCtx?.checks ?? [];
    const constraints = requestCtx?.constraints ?? { minAge: 18, requiredGender: "", pincodes: [] };
    const ageEnabled = checks.includes("age");
    const genderEnabled = checks.includes("gender");
    const addressEnabled = checks.includes("address");
    const agePass = ageEnabled ? computeAgeFromDob(dob) >= constraints.minAge : null;
    const genderPass = genderEnabled ? gendersMatch(gender, constraints.requiredGender) : null;
    const addressPass = addressEnabled
      ? addressMatchesAnyAllowedPincode(address, constraints.pincodes)
      : null;
    qrAndConstraintsPassed =
      (!ageEnabled || agePass === true) &&
      (!genderEnabled || genderPass === true) &&
      (!addressEnabled || addressPass === true);
    qrChecks.classList.remove("hidden");

    setQrStatus(qrUidaiStatus, true); // UIDAI signature already verified by `verification.isValid`
    setQrStatus(qrAgeStatus, agePass);
    setQrStatus(qrGenderStatus, genderPass);
    setQrStatus(qrAddressStatus, addressPass);

    if (qrExtractedLine) {
      qrExtractedLine.textContent = `Name: ${extractedFields.name} | DOB: ${extractedFields.dob} | Gender: ${extractedFields.gender}`;
    }

    const summary = qrAndConstraintsPassed ? "QR + constraints passed. Liveness enabled." : "QR extracted but constraints not satisfied.";
    qrGateNote.textContent = summary;
    if (qrChecksStatusNote) qrChecksStatusNote.textContent = summary;

    updateLivenessEnablement();
    checkCompareReady();
    setProgress(100, "Aadhaar and QR processed.");
  } catch (err) {
    qrAndConstraintsPassed = false;
    updateLivenessEnablement();
    setProgress(100, `Aadhaar processing failed: ${err.message}`);
  }
}

aadhaarInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  lastAadhaarFile = file;
  await processAadhaarFile(file);
});
uploadArea.addEventListener("dragover", (e) => { e.preventDefault(); uploadArea.style.borderColor = "var(--accent)"; });
uploadArea.addEventListener("dragleave", () => { uploadArea.style.borderColor = ""; });
uploadArea.addEventListener("drop", async (e) => {
  e.preventDefault();
  uploadArea.style.borderColor = "";
  const file = e.dataTransfer?.files?.[0];
  if (file && file.type.startsWith("image/")) { lastAadhaarFile = file; await processAadhaarFile(file); }
});
btnReprocessAadhaar?.addEventListener("click", async () => { if (lastAadhaarFile) await processAadhaarFile(lastAadhaarFile); });

btnRemoveAadhaar.addEventListener("click", () => {
  if (aadhaarObjectUrl) revokeURL(aadhaarObjectUrl);
  aadhaarObjectUrl = null;
  aadhaarEmbedding = null;
  aadhaarAlignedData = null;
  lastAadhaarFile = null;
  extractedFields = null;
  qrAndConstraintsPassed = false;

  setQrStatus(qrUidaiStatus, null);
  setQrStatus(qrAgeStatus, null);
  setQrStatus(qrGenderStatus, null);
  setQrStatus(qrAddressStatus, null);
  if (qrExtractedLine) qrExtractedLine.textContent = "";
  if (qrChecksStatusNote) qrChecksStatusNote.textContent = "Upload Aadhaar image to start.";

  aadhaarPreview.classList.add("hidden");
  aadhaarFacePreview.classList.add("hidden");
  qrChecks.classList.add("hidden");
  uploadArea.classList.remove("hidden");
  aadhaarInput.value = "";
  resultSection.classList.add("hidden");
  updateLivenessEnablement();
  checkCompareReady();
});

btnCompare.addEventListener("click", () => {
  if (!liveEmbedding || !aadhaarEmbedding) return;
  const strictness = strictnessSelect?.value ?? "balanced";
  const thresholds =
    strictness === "strict"
      ? { verifiedCos: 0.7, verifiedDist: 0.82, suspiciousMinCos: 0.55, suspiciousMaxCos: 0.7 }
      : strictness === "lenient"
        ? { verifiedCos: 0.62, verifiedDist: 0.9, suspiciousMinCos: 0.5, suspiciousMaxCos: 0.65 }
        : { verifiedCos: 0.65, verifiedDist: 0.85, suspiciousMinCos: 0.5, suspiciousMaxCos: 0.65 };
  const res = compare(liveEmbedding, aadhaarEmbedding, thresholds);
  faceMatchComparisonStatus = res.status; // verified | suspicious | mismatch
  // Display-only status for the verifier UI:
  // matched / suspicious / mismatch
  faceMatchStatus = res.status === "verified" ? "matched" : res.status;
  resultIcon.textContent = { verified: "✅", suspicious: "⚠️", mismatch: "❌" }[res.status];
  resultStatus.textContent = { verified: "MATCHED", suspicious: "SUSPICIOUS", mismatch: "MISMATCH" }[res.status];
  resultStatus.className = res.status;
  resultExplanation.textContent = res.explanation ?? "";
  metricSimilarity.textContent = res.similarityScore.toFixed(4);
  metricDistance.textContent = res.distance.toFixed(4);
  resultSection.classList.remove("hidden");
  btnProof.disabled = false;
  setProofNote("info", "Proof enabled. It will include face status.");
});

btnProof.addEventListener("click", async () => {
  try {
    if (!requestCtx || !sessionPhone || !extractedFields) throw new Error("Missing context.");
    if (!faceMatchStatus || !faceMatchComparisonStatus) throw new Error("Run comparison first.");
    btnProof.disabled = true;
    setProofNote("info", "Generating proof…");

    // RTDB rules for `users/$phone/proof` allow write only once (`.write: !data.exists()`).
    // If a proof is already present (e.g. user retries after a previous run), treat as success and avoid PERMISSION_DENIED.
    const existingProofSnap = await get(
      ref(firebaseDb, `kycRequests/${requestCtx.requestId}/users/${sessionPhone}/proof`),
    );
    if (existingProofSnap.exists()) {
      setProofNote("success", "Success — proof was already sent to verifier for this request.");
      return;
    }
    const anchorYear = kycAnchorYearUtc(requestCtx.createdAt);
    let scheme = "groth16-flexible-kyc";
    let version = 1;
    let proof;
    let publicSignals;
    if (requestCtx.security?.requireCommitment) {
      if (!liveEmbedding) throw new Error("Live embedding missing. Complete liveness and confirm.");
      const faceHash = await poseidonHashEmbedding(liveEmbedding);
      const dobYear = extractBirthYearFromDob(extractedFields.dob);
      const genderCode = aadhaarGenderToCircuitCode(extractedFields.gender);
      const pincode = requestCtx.checks.includes("address")
        ? pickWitnessPincodeForCommitment(extractedFields.address, requestCtx.constraints.pincodes ?? [])
        : 0;
      const commitment = await buildCommitmentFromFields({
        dob: dobYear,
        genderCode,
        pincode,
        faceHash,
      });
      const res = await generateFlexibleKycCommitmentProof({
        dob: extractedFields.dob,
        genderRaw: extractedFields.gender,
        address: extractedFields.address,
        checks: requestCtx.checks,
        constraints: requestCtx.constraints,
        currentYear: anchorYear,
        faceHash,
        commitment,
        nonce: requestCtx.nonce ?? null,
      });
      proof = res.proof;
      publicSignals = res.publicSignals;
      scheme = "groth16-flexible-kyc-commitment";
      version = 2;
    } else {
      const res = await generateFlexibleKycProof({
        dob: extractedFields.dob,
        genderRaw: extractedFields.gender,
        address: extractedFields.address,
        checks: requestCtx.checks,
        constraints: requestCtx.constraints,
        currentYear: anchorYear,
        nonce: requestCtx.nonce ?? null,
      });
      proof = res.proof;
      publicSignals = res.publicSignals;
    }
    const proofHash = await sha256Hex(JSON.stringify(proof));
    try {
      await update(ref(firebaseDb, `kycRequests/${requestCtx.requestId}/users/${sessionPhone}/proof`), {
        version,
        scheme,
        createdAt: Date.now(),
        nonce: requestCtx.nonce ?? undefined,
        proof,
        publicSignals,
        faceMatchStatus, // matched | suspicious | mismatch
        proofHash,
      });
    } catch (e) {
      // If rules reject due to existing proof, show a friendly success message.
      const msg = e instanceof Error ? e.message : String(e);
      if (/PERMISSION_DENIED/i.test(msg)) {
        const snap = await get(
          ref(firebaseDb, `kycRequests/${requestCtx.requestId}/users/${sessionPhone}/proof`),
        );
        if (snap.exists()) {
          setProofNote("success", "Success — proof was already sent to verifier for this request.");
          return;
        }
      }
      throw e;
    }
    // RTDB rules validate `risk.status` must be either `verified` or `suspicious`.
    // So we store:
    // - risk.status: verified/suspicious (rule-safe)
    // - risk.faceMatchStatus: matched/suspicious/mismatch (UI display)
    const riskStatusForRules = faceMatchComparisonStatus === "verified" ? "verified" : "suspicious";
    try {
      await update(ref(firebaseDb, `kycRequests/${requestCtx.requestId}/users/${sessionPhone}/risk`), {
        status: riskStatusForRules,
        faceMatchStatus,
        updatedAt: Date.now(),
      });
    } catch {
      // Proof is already saved; risk is display-only. If rules reject this write, keep UX unblocked.
    }
    setProofNote("success", "Success — proof generated and sent to verifier.");
  } catch (err) {
    setProofNote("error", err.message || "Proof failed.");
    btnProof.disabled = false;
  }
});

btnReset.addEventListener("click", () => {
  cleanup({
    frames: capturedFrames,
    aligned: [...liveAlignedFaces, aadhaarAlignedData].filter(Boolean),
    embeddings: [liveEmbedding, aadhaarEmbedding].filter(Boolean),
    urls: [aadhaarObjectUrl].filter(Boolean),
  });
  capturedFrames = [];
  liveAlignedFaces = [];
  liveEmbedding = null;
  aadhaarAlignedData = null;
  aadhaarEmbedding = null;
  aadhaarObjectUrl = null;
  extractedFields = null;
  faceMatchStatus = null;
  faceMatchComparisonStatus = null;
  faceMatchComparisonStatus = null;
  livenessPassed = false;
  qrAndConstraintsPassed = false;
  clearFramesGrid();
  framesPreview.classList.add("hidden");
  btnRetake.classList.add("hidden");
  btnConfirm.classList.add("hidden");
  cameraOverlay.classList.add("hidden");
  aadhaarPreview.classList.add("hidden");
  aadhaarFacePreview.classList.add("hidden");
  qrChecks.classList.add("hidden");
  uploadArea.classList.remove("hidden");
  comparisonSection.classList.add("hidden");
  resultSection.classList.add("hidden");
  aadhaarInput.value = "";
  btnProof.disabled = true;
  proofNote.textContent = "";
  videoEl.play();
  updateLivenessEnablement();
});

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = URL.createObjectURL(file);
  });
}

async function sha256Hex(value) {
  const enc = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

window.addEventListener("beforeunload", () => {
  try { camera?.stop(); } catch {}
  try { verificationUnsub?.(); } catch {}
});

init();
