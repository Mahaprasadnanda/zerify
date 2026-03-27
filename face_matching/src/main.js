/**
 * Main orchestration — wires the Camera, Face Processor, Embedding Engine,
 * Similarity module, and Privacy Guard together with the UI.
 */
import { Camera } from './camera.js';
import { loadFaceApiModels, detectAndExtractFace } from './faceProcessor.js';
import { EmbeddingEngine } from './embeddingEngine.js';
import { compare, averageEmbeddings } from './similarity.js';
import { cleanup, revokeURL } from './privacyGuard.js';
import { assessFaceQuality } from './quality.js';
import './styles.css';

/* ── DOM refs ───────────────────────────────────── */
const $ = (id) => document.getElementById(id);

const statusText    = $('status-text');
const progressFill  = $('progress-fill');
const modelBadge    = $('model-badge');
const btnRetryCamera = $('btn-retry-camera');
const strictnessSelect = $('strictness');

const videoEl       = $('camera-feed');
const cameraOverlay = $('camera-overlay');
const btnLiveness   = $('btn-liveness');
const btnCapture    = $('btn-capture');
const btnRetake     = $('btn-retake');
const btnConfirm    = $('btn-confirm');
const livenessNote  = $('liveness-note');
const framesPreview = $('frames-preview');
const framesGrid    = framesPreview?.querySelector('.frames-grid');

const aadhaarInput       = $('aadhaar-input');
const uploadArea         = $('upload-area');
const aadhaarPreview     = $('aadhaar-preview');
const aadhaarImg         = $('aadhaar-img');
const btnRemoveAadhaar   = $('btn-remove-aadhaar');
const btnReprocessAadhaar = $('btn-reprocess-aadhaar');
const aadhaarFacePreview = $('aadhaar-face-preview');
const aadhaarFaceCanvas  = $('aadhaar-face-canvas');

const comparisonSection = $('comparison');
const compareLive       = $('compare-live');
const compareAadhaar    = $('compare-aadhaar');
const btnCompare        = $('btn-compare');

const resultSection   = $('result');
const resultIcon      = $('result-icon');
const resultStatus    = $('result-status');
const resultExplanation = $('result-explanation');
const metricSimilarity = $('metric-similarity');
const metricDistance   = $('metric-distance');
const btnReset        = $('btn-reset');

/* ── State ──────────────────────────────────────── */
let camera = null;
let embeddingEngine = null;
let modelType = 'arcface';          // 'arcface' or 'faceapi'
let livenessPassed = false;

let capturedFrames   = [];          // raw canvas snapshots
let liveAlignedFaces = [];          // { alignedFace, descriptor, … }
let liveEmbedding    = null;        // Float32Array (averaged + normalised)

let aadhaarAlignedData = null;      // single detection result
let aadhaarEmbedding   = null;      // Float32Array
let aadhaarObjectUrl   = null;
let lastAadhaarFile    = null;
const params = new URLSearchParams(window.location.search);
const returnUrl = params.get('return_url') || '';
const requestId = params.get('request_id') || '';
const handoffPhone = params.get('phone') || '';
const sessionToken = params.get('session_token') || '';
const handoffContext = $('handoff-context');

/* ── Helpers ────────────────────────────────────── */
function setProgress(pct, msg) {
  progressFill.style.width = `${pct}%`;
  if (msg) statusText.textContent = msg;
}

function drawToCanvas(target, source) {
  target.width = source.width;
  target.height = source.height;
  target.getContext('2d').drawImage(source, 0, 0);
}

function checkCompareReady() {
  const ready = liveEmbedding && aadhaarEmbedding;
  comparisonSection.classList.toggle('hidden', !ready);
  btnCompare.disabled = !ready;
}

function clearFramesGrid() {
  if (!framesGrid) return;
  framesGrid.querySelectorAll('.frame').forEach((el) => el.remove());
}

function renderFrameTile(index, alignedFaceCanvas) {
  if (!framesGrid) return;
  const tile = document.createElement('div');
  tile.className = 'frame';

  const label = document.createElement('span');
  label.className = 'frame-label';
  label.textContent = String(index + 1);
  tile.appendChild(label);

  const preview = document.createElement('canvas');
  drawToCanvas(preview, alignedFaceCanvas);
  tile.appendChild(preview);

  framesGrid.appendChild(tile);
}

/* ── Initialisation ─────────────────────────────── */
async function init() {
  try {
    if (handoffContext) {
      const bits = [];
      if (requestId) bits.push(`Request: ${requestId}`);
      if (handoffPhone) bits.push(`User: ${handoffPhone}`);
      handoffContext.textContent = bits.length ? bits.join(' · ') : '';
    }
    if (sessionToken) {
      try {
        localStorage.setItem('face_matching_session_token', sessionToken);
      } catch {
        // ignore storage errors
      }
    }

    btnRetryCamera?.classList.add('hidden');
    setProgress(5, 'Loading face detection models\u2026');
    await loadFaceApiModels('/models/face-api');
    setProgress(40, 'Face detection ready.');

    setProgress(45, 'Loading ONNX embedding model\u2026');
    embeddingEngine = new EmbeddingEngine();
    const onnxOk = await embeddingEngine.load('/models/mobilefacenet.onnx');

    if (onnxOk) {
      modelType = 'arcface';
      modelBadge.textContent = `ONNX MobileFaceNet \u00B7 ${embeddingEngine.embeddingDim}D`;
      modelBadge.classList.remove('hidden');
      setProgress(70, 'ONNX embedding model loaded.');
    } else {
      modelType = 'faceapi';
      modelBadge.textContent = 'face-api.js 128D (fallback)';
      modelBadge.style.borderColor = 'var(--warning)';
      modelBadge.style.color = 'var(--warning)';
      modelBadge.classList.remove('hidden');
      setProgress(70, 'ONNX model not found \u2014 using face-api.js descriptors.');
    }

    setProgress(75, 'Starting camera\u2026');
    camera = new Camera(videoEl);
    await camera.start();

    setProgress(100, 'Ready \u2014 run liveness check, then capture your face and upload an ID image.');
    btnCapture.disabled = true;
  } catch (err) {
    setProgress(0, `Initialisation failed: ${err.message}`);
    // Offer retry for device-in-use / transient camera failures.
    if (btnRetryCamera && String(err?.message || '').toLowerCase().includes('camera')) {
      btnRetryCamera.classList.remove('hidden');
    }
  }
}

btnRetryCamera?.addEventListener('click', async () => {
  try {
    btnRetryCamera.disabled = true;
    setProgress(60, 'Retrying camera\u2026');
    if (!camera) camera = new Camera(videoEl);
    camera.stop();
    await camera.start();
    btnCapture.disabled = !livenessPassed;
    btnRetryCamera.classList.add('hidden');
    setProgress(100, livenessPassed ? 'Camera ready \u2014 capture your face.' : 'Camera ready \u2014 run liveness check first.');
  } catch (err) {
    setProgress(0, `Camera retry failed: ${err.message}`);
  } finally {
    btnRetryCamera.disabled = false;
  }
});

async function runLivenessCheck15s() {
  if (!camera?.isActive) throw new Error('Camera is not active.');

  const durationMs = 15_000;
  const sampleEveryMs = 350;
  const minDetected = 8;
  const captured = [];
  let baseline = null;
  let detected = 0;
  let turnedLeft = false;
  let turnedRight = false;

  const started = performance.now();
  while (performance.now() - started < durationMs) {
    const frame = camera.captureFrame();
    const det = await detectAndExtractFace(frame, 0.45, 0.18);
    if (det?.keypoints) {
      detected += 1;
      const l = det.keypoints[0]?.[0];
      const r = det.keypoints[1]?.[0];
      const n = det.keypoints[2]?.[0];
      if (typeof l === 'number' && typeof r === 'number' && typeof n === 'number') {
        const eyeCenter = (l + r) / 2;
        const eyeDist = Math.max(1e-3, Math.abs(r - l));
        const offset = (n - eyeCenter) / eyeDist;
        baseline = baseline === null ? offset : baseline * 0.92 + offset * 0.08;
        const delta = 0.045;
        if (offset < baseline - delta) turnedLeft = true;
        if (offset > baseline + delta) turnedRight = true;
      }
      // Capture up to 5 live instances DURING liveness, not after.
      if (captured.length < 5) {
        captured.push(frame);
      }
    }
    const pct = Math.min(100, Math.round(((performance.now() - started) / durationMs) * 100));
    setProgress(pct, `Liveness check\u2026 ${pct}% (turn left and right once)`);
    await new Promise((r) => setTimeout(r, sampleEveryMs));
  }

  const pass = detected >= minDetected && turnedLeft && turnedRight && captured.length >= 5;
  if (!pass) {
    const reasons = [];
    if (detected < minDetected) reasons.push('face not detected consistently');
    if (!turnedLeft) reasons.push('left turn not detected');
    if (!turnedRight) reasons.push('right turn not detected');
    if (captured.length < 5) reasons.push('could not capture 5 live frames');
    throw new Error(`Liveness check failed: ${reasons.join(', ')}.`);
  }
  return captured.slice(0, 5);
}

async function processCapturedFrames(frames) {
  capturedFrames = frames;
  liveAlignedFaces = [];
  clearFramesGrid();
  for (let i = 0; i < capturedFrames.length; i++) {
    setProgress(30 + (i + 1) * 15, `Detecting face in frame ${i + 1}\u2026`);
    const det = await detectAndExtractFace(capturedFrames[i], 0.5, 0.18);
    if (!det) {
      throw new Error(`No face detected in frame ${i + 1}. Try again with better lighting.`);
    }
    const q = assessFaceQuality({
      alignedFace: det.alignedFace,
      score: det.score,
      box: det.box,
      sourceDims: { width: capturedFrames[i].width, height: capturedFrames[i].height },
      policy: { minScore: 0.8, minFaceFrac: 0.12, minBlurScore: 55 },
    });
    if (!q.ok) {
      throw new Error(`Face quality is low (${q.issues.join(', ')}). Please retake in better lighting.`);
    }
    liveAlignedFaces.push(det);
    renderFrameTile(i, det.alignedFace);
  }
  framesPreview.classList.remove('hidden');
  btnRetake.classList.remove('hidden');
  btnConfirm.classList.remove('hidden');
  cameraOverlay.classList.remove('hidden');
  videoEl.pause();
}

btnLiveness?.addEventListener('click', async () => {
  try {
    btnLiveness.disabled = true;
    btnCapture.disabled = true;
    setProgress(20, 'Running liveness check (15s)\u2026');
    const frames = await runLivenessCheck15s();
    setProgress(78, 'Liveness passed. Preparing captured frames\u2026');
    await processCapturedFrames(frames);
    livenessPassed = true;
    if (livenessNote) livenessNote.textContent = 'Liveness passed. 5 live frames captured from liveness.';
    btnCapture.disabled = false;
    setProgress(100, 'Liveness passed \u2014 5 live frames captured. Click Confirm.');
  } catch (err) {
    livenessPassed = false;
    if (livenessNote) livenessNote.textContent = 'Liveness not passed. Retry liveness check.';
    setProgress(100, `Liveness failed: ${err.message}`);
    btnCapture.disabled = true;
  } finally {
    btnLiveness.disabled = false;
  }
});

// Release the camera when the tab is closed/reloaded.
window.addEventListener('beforeunload', () => {
  try { camera?.stop(); } catch { /* ignore */ }
});

/* ── Capture ────────────────────────────────────── */
btnCapture.addEventListener('click', async () => {
  try {
    if (!livenessPassed) {
      setProgress(100, 'Run liveness check first.');
      return;
    }
    if (!capturedFrames.length) {
      setProgress(100, 'No liveness-captured frames yet. Run liveness check again.');
      return;
    }
    setProgress(100, 'Liveness-captured frames are already loaded. Click Confirm.');
  } catch (err) {
    setProgress(100, `Capture failed: ${err.message}`);
    btnCapture.disabled = false;
  }
});

/* ── Retake ─────────────────────────────────────── */
btnRetake.addEventListener('click', () => {
  cleanup({ frames: capturedFrames, aligned: liveAlignedFaces });
  capturedFrames = [];
  liveAlignedFaces = [];
  liveEmbedding = null;

  clearFramesGrid();
  framesPreview.classList.add('hidden');
  btnRetake.classList.add('hidden');
  btnConfirm.classList.add('hidden');
  cameraOverlay.classList.add('hidden');
  resultSection.classList.add('hidden');
  videoEl.play();
  btnCapture.disabled = false;

  setProgress(100, 'Ready \u2014 capture your face.');
  checkCompareReady();
});

/* ── Confirm ────────────────────────────────────── */
btnConfirm.addEventListener('click', async () => {
  try {
    btnConfirm.disabled = true;
    btnRetake.disabled = true;
    setProgress(30, 'Generating live-face embeddings\u2026');

    const embeddings = [];
    for (let i = 0; i < liveAlignedFaces.length; i++) {
      setProgress(30 + (i + 1) * 15, `Embedding frame ${i + 1}\u2026`);
      let emb = null;
      if (modelType === 'arcface' && embeddingEngine?.isLoaded) {
        emb = await embeddingEngine.getEmbedding(liveAlignedFaces[i].alignedFace);
      }
      if (!emb) {
        emb = liveAlignedFaces[i].descriptor;
        modelType = 'faceapi';
      }
      embeddings.push(emb);
    }

    liveEmbedding = averageEmbeddings(embeddings);
    drawToCanvas(compareLive, liveAlignedFaces[0].alignedFace);

    setProgress(100, 'Live-face embedding ready.');
    btnRetake.disabled = false;
    checkCompareReady();
  } catch (err) {
    setProgress(100, `Embedding failed: ${err.message}`);
    btnConfirm.disabled = false;
    btnRetake.disabled = false;
  }
});

/* ── Aadhaar Upload ─────────────────────────────── */
aadhaarInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  lastAadhaarFile = file;
  await processAadhaarFile(file);
});

uploadArea.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadArea.style.borderColor = 'var(--accent)';
});
uploadArea.addEventListener('dragleave', () => {
  uploadArea.style.borderColor = '';
});
uploadArea.addEventListener('drop', async (e) => {
  e.preventDefault();
  uploadArea.style.borderColor = '';
  const file = e.dataTransfer?.files?.[0];
  if (file && file.type.startsWith('image/')) {
    lastAadhaarFile = file;
    await processAadhaarFile(file);
  }
});

btnReprocessAadhaar?.addEventListener('click', async () => {
  if (!lastAadhaarFile) {
    setProgress(100, 'Please upload an ID image first.');
    return;
  }
  await processAadhaarFile(lastAadhaarFile);
});

async function processAadhaarFile(file) {
  try {
    setProgress(20, 'Loading ID image\u2026');

    if (aadhaarObjectUrl) revokeURL(aadhaarObjectUrl);
    const img = await loadImage(file);
    aadhaarObjectUrl = img.src;
    aadhaarImg.src = aadhaarObjectUrl;
    aadhaarPreview.classList.remove('hidden');
    uploadArea.classList.add('hidden');

    setProgress(40, 'Detecting face in ID image\u2026');

    // Speed: downscale large ID images for detection (alignment/embedding uses aligned 112x112 anyway).
    const maxDim = 1024;
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const imgCanvas = document.createElement('canvas');
    imgCanvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    imgCanvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    imgCanvas.getContext('2d').drawImage(img, 0, 0, imgCanvas.width, imgCanvas.height);

    const det = await detectAndExtractFace(imgCanvas, 0.35, 0.20);
    if (!det) {
      setProgress(100, 'No face found in the uploaded image. Try a clearer photo.');
      return;
    }
    const q = assessFaceQuality({
      alignedFace: det.alignedFace,
      score: det.score,
      box: det.box,
      sourceDims: { width: imgCanvas.width, height: imgCanvas.height },
      // Aadhaar/ID photos are often low-res/compressed; keep checks, but less strict.
      policy: { minScore: 0.55, minFaceFrac: 0.04, minBlurScore: 25 },
    });
    if (!q.ok) {
      const onlyFaceSmall = q.issues.length === 1 && q.issues[0] === 'Face too small in image';
      if (!onlyFaceSmall) {
        setProgress(100, `Face quality is low (${q.issues.join(', ')}). Please upload a clearer image.`);
        // Ensure user can immediately try again without being stuck.
        aadhaarFacePreview.classList.add('hidden');
        checkCompareReady();
        return;
      }

      // For many Aadhaar photos the face is physically small in the document image.
      // Proceed with a warning rather than blocking the pipeline.
      setProgress(60, 'ID face is small — proceeding (may reduce accuracy).');
    }

    aadhaarAlignedData = det;
    drawToCanvas(aadhaarFaceCanvas, det.alignedFace);
    aadhaarFacePreview.classList.remove('hidden');

    setProgress(70, 'Generating ID-face embedding\u2026');

    let emb = null;
    if (modelType === 'arcface' && embeddingEngine?.isLoaded) {
      emb = await embeddingEngine.getEmbedding(det.alignedFace);
    }
    if (!emb) {
      emb = det.descriptor;
      modelType = 'faceapi';
    }

    aadhaarEmbedding = emb;
    drawToCanvas(compareAadhaar, det.alignedFace);

    setProgress(100, 'ID-face embedding ready.');
    checkCompareReady();
  } catch (err) {
    setProgress(100, `ID processing failed: ${err.message}`);
  }
}

btnRemoveAadhaar.addEventListener('click', () => {
  if (aadhaarObjectUrl) revokeURL(aadhaarObjectUrl);
  aadhaarObjectUrl = null;
  aadhaarEmbedding = null;
  aadhaarAlignedData = null;
  lastAadhaarFile = null;

  aadhaarPreview.classList.add('hidden');
  aadhaarFacePreview.classList.add('hidden');
  uploadArea.classList.remove('hidden');
  aadhaarInput.value = '';
  resultSection.classList.add('hidden');

  setProgress(100, 'Ready \u2014 upload an ID image.');
  checkCompareReady();
});

/* ── Compare ────────────────────────────────────── */
btnCompare.addEventListener('click', () => {
  if (!liveEmbedding || !aadhaarEmbedding) return;

  const strictness = strictnessSelect?.value ?? 'balanced';
  const thresholds =
    strictness === 'strict'
      ? { verifiedCos: 0.70, verifiedDist: 0.82, suspiciousMinCos: 0.55, suspiciousMaxCos: 0.70 }
      : strictness === 'lenient'
        ? { verifiedCos: 0.62, verifiedDist: 0.90, suspiciousMinCos: 0.50, suspiciousMaxCos: 0.65 }
        : { verifiedCos: 0.65, verifiedDist: 0.85, suspiciousMinCos: 0.50, suspiciousMaxCos: 0.65 };

  const res = compare(liveEmbedding, aadhaarEmbedding, thresholds);

  const icons   = { verified: '\u2705', suspicious: '\u26A0\uFE0F', mismatch: '\u274C' };
  const labels  = { verified: 'VERIFIED', suspicious: 'SUSPICIOUS', mismatch: 'MISMATCH' };

  resultIcon.textContent = icons[res.status];
  resultStatus.textContent = labels[res.status];
  resultStatus.className = res.status;
  if (resultExplanation) resultExplanation.textContent = res.explanation ?? '';

  metricSimilarity.textContent = res.similarityScore.toFixed(4);
  metricDistance.textContent = res.distance.toFixed(4);

  resultSection.classList.remove('hidden');
  setProgress(100, `Verification complete \u2014 ${labels[res.status]}`);

  // Callback to main prover page (same browser), then auto-return when verified.
  if (returnUrl) {
    try {
      const cb = new URL(returnUrl);
      cb.searchParams.set('face_match', res.status === 'verified' ? 'passed' : 'failed');
      cb.searchParams.set('sim', res.similarityScore.toFixed(4));
      cb.searchParams.set('dist', res.distance.toFixed(4));
      if (requestId) cb.searchParams.set('request_id', requestId);
      if (handoffPhone) cb.searchParams.set('phone', handoffPhone);
      if (sessionToken) cb.searchParams.set('session_token', sessionToken);
      if (res.status === 'verified') {
        setTimeout(() => {
          window.location.href = cb.toString();
        }, 1200);
      }
    } catch {
      // ignore malformed callback url
    }
  }
});

/* ── Reset ──────────────────────────────────────── */
btnReset.addEventListener('click', () => {
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

  clearFramesGrid();

  framesPreview.classList.add('hidden');
  btnRetake.classList.add('hidden');
  btnConfirm.classList.add('hidden');
  cameraOverlay.classList.add('hidden');
  aadhaarPreview.classList.add('hidden');
  aadhaarFacePreview.classList.add('hidden');
  uploadArea.classList.remove('hidden');
  comparisonSection.classList.add('hidden');
  resultSection.classList.add('hidden');

  aadhaarInput.value = '';
  livenessPassed = false;
  if (livenessNote) livenessNote.textContent = 'Complete liveness check before capture.';
  btnCapture.disabled = true;
  videoEl.play();

  setProgress(100, 'Ready \u2014 run liveness check, then capture your face and upload an ID image.');
});

/* ── Utility ────────────────────────────────────── */
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      URL.revokeObjectURL(img.src);
      reject(new Error('Failed to load image'));
    };
    img.src = URL.createObjectURL(file);
  });
}

/* ── Boot ───────────────────────────────────────── */
init();
