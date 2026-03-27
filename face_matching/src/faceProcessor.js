/**
 * Face Processor — face detection via SSD MobileNet, 68-point landmark
 * extraction, 5-point similarity-transform alignment, and 112x112 crop.
 *
 * Uses @vladmandic/face-api (maintained fork of face-api.js) which bundles
 * TF.js internally. Face-api's own 128-D face descriptor is also computed
 * so it can serve as a fallback if the ONNX embedding model is unavailable.
 */
import * as faceapi from '@vladmandic/face-api';

const FACE_SIZE = 112;
const DEFAULT_PADDING = 0.18;

// Standard 5-point reference template for a 112x112 aligned face.
// These coordinates come from the InsightFace alignment specification.
const REFERENCE_POINTS = [
  [38.2946, 51.6963],   // left eye
  [73.5318, 51.5014],   // right eye
  [56.0252, 71.7366],   // nose tip
  [41.5493, 92.3655],   // left mouth corner
  [70.7299, 92.2041],   // right mouth corner
];

let _modelsReady = false;

/* ── Public API ──────────────────────────────────── */

export async function loadFaceApiModels(modelPath) {
  await Promise.all([
    faceapi.nets.ssdMobilenetv1.loadFromUri(modelPath),
    faceapi.nets.faceLandmark68Net.loadFromUri(modelPath),
    faceapi.nets.faceRecognitionNet.loadFromUri(modelPath),
  ]);
  _modelsReady = true;
}

export function isReady() {
  return _modelsReady;
}

/**
 * Detect the most prominent face, align it to a 112x112 canvas,
 * and return the aligned image together with a face-api 128-D descriptor.
 *
 * @param {HTMLCanvasElement|HTMLImageElement} source
 * @param {number} minConfidence  – SSD confidence threshold (lower for poor-quality ID photos)
 * @param {number} paddingRatio  – expand bounding box to include full face + context
 * @returns {Promise<{alignedFace: HTMLCanvasElement, descriptor: Float32Array, box: object, score: number, keypoints: number[][], cropBox: object, eyeAspectRatio: number}|null>}
 */
export async function detectAndExtractFace(source, minConfidence = 0.5, paddingRatio = DEFAULT_PADDING) {
  if (!_modelsReady) throw new Error('Face-api models not loaded');

  const options = new faceapi.SsdMobilenetv1Options({ minConfidence });

  const detection = await faceapi
    .detectSingleFace(source, options)
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (!detection) return null;

  const score = detection.detection.score ?? 0;
  const box = detection.detection.box;

  // Crop to padded bounding box to reduce background influence and stabilise alignment.
  const crop = cropWithPadding(source, box, paddingRatio);
  const landmarks68 = detection.landmarks.positions.map((p) => ({ x: p.x - crop.offsetX, y: p.y - crop.offsetY }));
  const keypoints = extract5Points(landmarks68);
  const eyeAspectRatio = computeAverageEyeAspectRatio(landmarks68);
  const transform = estimateSimilarityTransform(keypoints, REFERENCE_POINTS);
  const alignedFace = applyAlignment(crop.canvas, transform, FACE_SIZE);

  return {
    alignedFace,
    descriptor: new Float32Array(detection.descriptor),
    box,
    score,
    keypoints,
    cropBox: crop.cropBox,
    eyeAspectRatio,
  };
}

/* ── Landmark Extraction ─────────────────────────── */

function extract5Points(lm) {
  const avg = (indices) => {
    let x = 0, y = 0;
    for (const i of indices) { x += lm[i].x; y += lm[i].y; }
    return [x / indices.length, y / indices.length];
  };

  return [
    avg([36, 37, 38, 39, 40, 41]),  // left eye
    avg([42, 43, 44, 45, 46, 47]),  // right eye
    [lm[30].x, lm[30].y],          // nose tip
    [lm[48].x, lm[48].y],          // left mouth corner
    [lm[54].x, lm[54].y],          // right mouth corner
  ];
}

function distance2d(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function eyeAspectRatio(eye) {
  const horizontal = Math.max(1e-6, distance2d(eye[0], eye[3]));
  const vertical = distance2d(eye[1], eye[5]) + distance2d(eye[2], eye[4]);
  return vertical / (2 * horizontal);
}

function computeAverageEyeAspectRatio(lm) {
  const left = [lm[36], lm[37], lm[38], lm[39], lm[40], lm[41]];
  const right = [lm[42], lm[43], lm[44], lm[45], lm[46], lm[47]];
  return (eyeAspectRatio(left) + eyeAspectRatio(right)) / 2;
}

/* ── Similarity Transform ────────────────────────── */

/**
 * Estimate a 2-D similarity transform (rotation + uniform scale + translation)
 * that best maps `src` points onto `dst` points in a least-squares sense.
 *
 * Returns {a, b, tx, ty} where the forward mapping is:
 *   x' = a·x − b·y + tx
 *   y' = b·x + a·y + ty
 */
function estimateSimilarityTransform(src, dst) {
  const n = src.length;

  let srcCx = 0, srcCy = 0, dstCx = 0, dstCy = 0;
  for (let i = 0; i < n; i++) {
    srcCx += src[i][0]; srcCy += src[i][1];
    dstCx += dst[i][0]; dstCy += dst[i][1];
  }
  srcCx /= n; srcCy /= n;
  dstCx /= n; dstCy /= n;

  let srcVar = 0, dotA = 0, dotB = 0;
  for (let i = 0; i < n; i++) {
    const sx = src[i][0] - srcCx;
    const sy = src[i][1] - srcCy;
    const dx = dst[i][0] - dstCx;
    const dy = dst[i][1] - dstCy;

    srcVar += sx * sx + sy * sy;
    dotA += sx * dx + sy * dy;
    dotB += sx * dy - sy * dx;
  }

  const a = dotA / srcVar;
  const b = dotB / srcVar;
  const tx = dstCx - a * srcCx + b * srcCy;
  const ty = dstCy - b * srcCx - a * srcCy;

  return { a, b, tx, ty };
}

/* ── Canvas Alignment ────────────────────────────── */

function applyAlignment(source, { a, b, tx, ty }, size) {
  const out = document.createElement('canvas');
  out.width = size;
  out.height = size;
  const ctx = out.getContext('2d');

  // setTransform(a, b, c, d, e, f) → x' = a·x + c·y + e , y' = b·x + d·y + f
  ctx.setTransform(a, b, -b, a, tx, ty);
  ctx.drawImage(source, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  return out;
}

function cropWithPadding(source, box, paddingRatio) {
  const srcW = source instanceof HTMLCanvasElement ? source.width : source.naturalWidth;
  const srcH = source instanceof HTMLCanvasElement ? source.height : source.naturalHeight;

  const padX = box.width * paddingRatio;
  const padY = box.height * paddingRatio;

  const x0 = Math.max(0, Math.floor(box.x - padX));
  const y0 = Math.max(0, Math.floor(box.y - padY));
  const x1 = Math.min(srcW, Math.ceil(box.x + box.width + padX));
  const y1 = Math.min(srcH, Math.ceil(box.y + box.height + padY));

  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(source, x0, y0, w, h, 0, 0, w, h);

  return {
    canvas,
    offsetX: x0,
    offsetY: y0,
    cropBox: { x: x0, y: y0, width: w, height: h },
  };
}
