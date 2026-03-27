type FaceApiModule = typeof import("face-api.js");
let faceapiMod: FaceApiModule | null = null;

async function faceapi(): Promise<FaceApiModule> {
  if (faceapiMod) return faceapiMod;
  if (typeof window === "undefined") {
    throw new Error("face-api.js can only run in the browser.");
  }
  faceapiMod = (await import("face-api.js")) as FaceApiModule;
  return faceapiMod;
}

export type LivenessEventState = {
  blink: boolean;
  headLeft: boolean;
  headRight: boolean;
};

export type LivenessResult = {
  status: "pass" | "fail";
  events: LivenessEventState;
  method: "face-api.js";
  /**
   * Euclidean distance between live face and Aadhaar portrait (face-api convention).
   * Lower = more similar; same person is typically below ~0.65 under varied lighting.
   */
  aadhaarMatchDistance?: number;
  /** Cosine similarity vs Aadhaar portrait (diagnostic only; TF.js buffers made this misleading before copies). */
  aadhaarMatchSimilarity?: number;
  /** Back-compat / generic display: often session stability when no Aadhaar ref. */
  cosineSimilarity?: number;
  /** How stable the face was across the camera session (not identity vs document). */
  sessionStabilitySimilarity?: number;
  faceHash?: string;
  message?: string;
};

/**
 * Max L2 distance between 128-d face descriptors for “same person”.
 * 0.55 was too strict for real scans vs live camera; 0.65 keeps clear gap vs typical impostors (~0.72+).
 */
export const AADHAAR_LIVE_FACE_MAX_DISTANCE = 0.65;

let modelsLoaded = false;
let modelsLoading: Promise<void> | null = null;

export async function ensureFaceApiModels(modelBaseUrl = "/models/face-api"): Promise<void> {
  if (modelsLoaded) return;
  if (modelsLoading) return await modelsLoading;
  modelsLoading = (async () => {
    const api = await faceapi();
    await api.nets.tinyFaceDetector.loadFromUri(modelBaseUrl);
    await api.nets.faceLandmark68TinyNet.loadFromUri(modelBaseUrl);
    await api.nets.faceRecognitionNet.loadFromUri(modelBaseUrl);
    modelsLoaded = true;
  })();
  return await modelsLoading;
}

type FacePoint = { x: number; y: number };

function dist(a: FacePoint, b: FacePoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function eyeAspectRatio(eye: FacePoint[]): number {
  // EAR = (||p2-p6|| + ||p3-p5||) / (2*||p1-p4||)
  const p1 = eye[0]!;
  const p2 = eye[1]!;
  const p3 = eye[2]!;
  const p4 = eye[3]!;
  const p5 = eye[4]!;
  const p6 = eye[5]!;
  const v1 = dist(p2, p6);
  const v2 = dist(p3, p5);
  const h = dist(p1, p4);
  return (v1 + v2) / (2 * Math.max(h, 1e-6));
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

/** face-api.js / TF.js reuse descriptor buffers; always copy before retaining across frames or pipelines. */
export function copyFaceDescriptor(d: Float32Array): Float32Array {
  return new Float32Array(d);
}

/** Same metric as face-api `euclideanDistance` for 128-d descriptors. */
export function faceDescriptorEuclideanDistance(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i]! - b[i]!;
    s += d * d;
  }
  return Math.sqrt(s);
}

/** Average several live descriptors and L2-renormalize (reduces single-frame noise at gesture completion). */
export function averageNormalizedDescriptors(descriptors: Float32Array[]): Float32Array | null {
  if (!descriptors.length) return null;
  const len = descriptors[0]!.length;
  const out = new Float32Array(len);
  for (const d of descriptors) {
    const n = Math.min(len, d.length);
    for (let i = 0; i < n; i++) out[i] += d[i]!;
  }
  const k = descriptors.length;
  for (let i = 0; i < len; i++) out[i] /= k;
  let normSq = 0;
  for (let i = 0; i < len; i++) normSq += out[i] * out[i];
  const norm = Math.sqrt(normSq);
  if (norm < 1e-12) return out;
  for (let i = 0; i < len; i++) out[i] /= norm;
  return out;
}

/** Reuse last successful preset so we do not run 5 heavy detections every frame. */
let cachedDetectorPresetIndex: number | null = null;

const DETECTOR_PRESETS: { inputSize: number; scoreThreshold: number }[] = [
  { inputSize: 416, scoreThreshold: 0.45 },
  { inputSize: 512, scoreThreshold: 0.35 },
  { inputSize: 608, scoreThreshold: 0.28 },
  { inputSize: 320, scoreThreshold: 0.22 },
  { inputSize: 224, scoreThreshold: 0.18 },
];

function mediaWidthHeight(media: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement): { w: number; h: number } {
  if (media instanceof HTMLVideoElement) {
    return { w: media.videoWidth, h: media.videoHeight };
  }
  if (media instanceof HTMLCanvasElement) {
    return { w: media.width, h: media.height };
  }
  return { w: media.naturalWidth, h: media.naturalHeight };
}

/** Try several TinyFaceDetector settings — video often has 0×0 until metadata loads, or needs a lower threshold. */
async function detectFaceWithLandmarks(
  media: HTMLVideoElement | HTMLImageElement,
  api: FaceApiModule,
): Promise<{
  landmarks: import("face-api.js").FaceLandmarks68;
  descriptor: Float32Array;
  detection: import("face-api.js").FaceDetection;
} | null> {
  const { w, h } = mediaWidthHeight(media);
  if (w < 2 || h < 2) {
    return null;
  }

  const runPreset = async (idx: number) => {
    const p = DETECTOR_PRESETS[idx];
    if (!p) return null;
    const opts = new api.TinyFaceDetectorOptions(p);
    const dets = await api.detectAllFaces(media, opts).withFaceLandmarks(true).withFaceDescriptors();
    if (!dets.length) return null;
    const best = dets.reduce((a, b) => (a.detection.score >= b.detection.score ? a : b));
    if (!best.landmarks || !best.descriptor) return null;
    return {
      landmarks: best.landmarks,
      descriptor: copyFaceDescriptor(best.descriptor),
      detection: best.detection,
    };
  };

  if (cachedDetectorPresetIndex !== null) {
    try {
      const fast = await runPreset(cachedDetectorPresetIndex);
      if (fast) return fast;
    } catch {
      cachedDetectorPresetIndex = null;
    }
    cachedDetectorPresetIndex = null;
  }

  for (let i = 0; i < DETECTOR_PRESETS.length; i++) {
    try {
      const found = await runPreset(i);
      if (found) {
        cachedDetectorPresetIndex = i;
        return found;
      }
    } catch {
      // next preset
    }
  }
  cachedDetectorPresetIndex = null;
  return null;
}

export async function detectLivenessFromVideoFrame(params: {
  video: HTMLVideoElement;
  prev: {
    blinkArmed: boolean;
    noseCenterX: number | null;
    /** Previous frame mean EAR — used for fast blink (open→closed drop). */
    prevEar: number | null;
    events: LivenessEventState;
  };
}): Promise<{
  next: {
    blinkArmed: boolean;
    noseCenterX: number | null;
    prevEar: number | null;
    events: LivenessEventState;
  };
  faceDetected: boolean;
  descriptor: Float32Array | null;
}> {
  const { video, prev } = params;
  const api = await faceapi();
  const found = await detectFaceWithLandmarks(video, api);

  if (!found) {
    return {
      next: {
        blinkArmed: prev.blinkArmed,
        noseCenterX: prev.noseCenterX,
        prevEar: prev.prevEar,
        events: prev.events,
      },
      faceDetected: false,
      descriptor: null,
    };
  }

  const detection = {
    landmarks: found.landmarks,
    descriptor: found.descriptor,
    detection: found.detection,
  };

  const leftEye = detection.landmarks.getLeftEye();
  const rightEye = detection.landmarks.getRightEye();
  const nose = detection.landmarks.getNose();
  const box = found.detection.box;

  const ear = (eyeAspectRatio(leftEye) + eyeAspectRatio(rightEye)) / 2;

  let blinkArmed = prev.blinkArmed;
  let blink = prev.events.blink;
  const prevEar = prev.prevEar;

  // Fast blink: one frame “open → shut” drop (tiny landmarks miss many closed frames at low FPS).
  const OPEN = 0.26;
  const CLOSED = 0.24;
  if (blinkArmed && !blink && prevEar !== null) {
    const sharpDrop = prevEar - ear > 0.06;
    const wasOpen = prevEar >= OPEN;
    const looksClosed = ear < CLOSED;
    if (wasOpen && (looksClosed || (sharpDrop && ear < 0.27))) {
      blink = true;
      blinkArmed = false;
    }
  }

  const noseTip = nose[3] ?? nose[0];
  const faceCenterX = box.x + box.width / 2;
  const noseOffset = noseTip ? (noseTip.x - faceCenterX) / Math.max(box.width, 1) : 0;

  // Head-turn detection: we want this to trigger quickly (like blink) without requiring extreme turns.
  // Use a slightly-smoothed baseline so minor drift doesn't block detection.
  const baseRaw = prev.noseCenterX ?? noseOffset;
  const base = prev.noseCenterX === null ? baseRaw : baseRaw * 0.92 + noseOffset * 0.08;
  const HEAD_DELTA = 0.075;
  const headLeft = prev.events.headLeft || noseOffset < base - HEAD_DELTA;
  const headRight = prev.events.headRight || noseOffset > base + HEAD_DELTA;

  return {
    faceDetected: true,
    next: {
      blinkArmed,
      noseCenterX: base,
      prevEar: ear,
      events: {
        blink,
        headLeft,
        headRight,
      },
    },
    descriptor: found.descriptor,
  };
}

/** Wide composite scans: portrait is usually on the left panel — crop before detection to avoid wrong face. */
function cropPortraitPanelIfWide(img: HTMLImageElement): HTMLImageElement | HTMLCanvasElement {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (w < 2 || h < 2) return img;
  if (w <= h * 1.15) return img;
  const canvas = document.createElement("canvas");
  const lw = Math.floor(w * 0.52);
  canvas.width = lw;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return img;
  ctx.drawImage(img, 0, 0, lw, h, 0, 0, lw, h);
  return canvas;
}

const AADHAAR_IMAGE_MIN_DET_SCORE = 0.45;

/**
 * Best face on an uploaded image (e.g. Aadhaar scan). Uses **largest** face box so the portrait on the front
 * wins over tiny artifacts; composite front+back images are supported.
 */
export async function extractFaceDescriptorFromImage(
  image: HTMLImageElement,
  modelBaseUrl = "/models/face-api",
): Promise<Float32Array | null> {
  await ensureFaceApiModels(modelBaseUrl);
  const api = await faceapi();
  const target = cropPortraitPanelIfWide(image);
  const { w, h } = mediaWidthHeight(target);
  if (w < 2 || h < 2) return null;

  const runPreset = async (idx: number) => {
    const p = DETECTOR_PRESETS[idx];
    if (!p) return null;
    const opts = new api.TinyFaceDetectorOptions(p);
    const dets = await api.detectAllFaces(target, opts).withFaceLandmarks(true).withFaceDescriptors();
    if (!dets.length) return null;
    const confident = dets.filter((d) => d.detection.score >= AADHAAR_IMAGE_MIN_DET_SCORE);
    const pool = confident.length ? confident : dets;
    const best = pool.reduce((a, b) => {
      const areaA = a.detection.box.width * a.detection.box.height;
      const areaB = b.detection.box.width * b.detection.box.height;
      return areaA >= areaB ? a : b;
    });
    const d = best.descriptor;
    return d ? copyFaceDescriptor(d) : null;
  };

  for (let i = 0; i < DETECTOR_PRESETS.length; i++) {
    try {
      const d = await runPreset(i);
      if (d) return d;
    } catch {
      // try next preset
    }
  }
  return null;
}

