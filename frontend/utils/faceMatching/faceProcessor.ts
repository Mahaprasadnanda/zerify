import * as faceapi from "face-api.js";

const FACE_SIZE = 112;
const DEFAULT_PADDING = 0.18;

const REFERENCE_POINTS: Array<[number, number]> = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

let modelsReady = false;

export async function loadFaceApiModels(modelPath: string) {
  // Use the models already present in this repo under /public/models/face-api.
  // This matches existing liveness integration and keeps assets local.
  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(modelPath),
    faceapi.nets.faceLandmark68TinyNet.loadFromUri(modelPath),
    faceapi.nets.faceRecognitionNet.loadFromUri(modelPath),
  ]);
  modelsReady = true;
}

export function isReady() {
  return modelsReady;
}

export type ExtractedFace = {
  /** Padded crop region from the source image/video frame (ROI used for alignment). */
  cropCanvas: HTMLCanvasElement;
  alignedFace: HTMLCanvasElement;
  descriptor: Float32Array;
  box: { x: number; y: number; width: number; height: number };
  score: number;
  keypoints: number[][];
  cropBox: { x: number; y: number; width: number; height: number };
};

export async function detectAndExtractFace(
  source: HTMLCanvasElement | HTMLImageElement,
  minConfidence = 0.5,
  paddingRatio = DEFAULT_PADDING,
): Promise<ExtractedFace | null> {
  if (!modelsReady) throw new Error("Face models not loaded");

  // Map reference's SSD minConfidence to TinyFaceDetector scoreThreshold.
  const options = new faceapi.TinyFaceDetectorOptions({
    inputSize: 416,
    scoreThreshold: Math.max(0.05, Math.min(0.95, minConfidence)),
  });

  const detection = await faceapi.detectSingleFace(source, options).withFaceLandmarks(true).withFaceDescriptor();
  if (!detection) return null;

  const score = detection.detection.score ?? 0;
  const box = detection.detection.box;

  const crop = cropWithPadding(source, box, paddingRatio);
  const landmarks68 = detection.landmarks.positions.map((p) => ({
    x: p.x - crop.offsetX,
    y: p.y - crop.offsetY,
  }));
  const keypoints = extract5Points(landmarks68);
  const transform = estimateSimilarityTransform(keypoints, REFERENCE_POINTS);
  const alignedFace = applyAlignment(crop.canvas, transform, FACE_SIZE);

  return {
    cropCanvas: crop.canvas,
    alignedFace,
    descriptor: new Float32Array(detection.descriptor),
    box: { x: box.x, y: box.y, width: box.width, height: box.height },
    score,
    keypoints,
    cropBox: crop.cropBox,
  };
}

type Point = { x: number; y: number };

function extract5Points(lm: Point[]): Array<[number, number]> {
  const avg = (indices: number[]) => {
    let x = 0;
    let y = 0;
    for (const i of indices) {
      x += lm[i]!.x;
      y += lm[i]!.y;
    }
    return [x / indices.length, y / indices.length] as [number, number];
  };

  return [
    avg([36, 37, 38, 39, 40, 41]),
    avg([42, 43, 44, 45, 46, 47]),
    [lm[30]!.x, lm[30]!.y],
    [lm[48]!.x, lm[48]!.y],
    [lm[54]!.x, lm[54]!.y],
  ];
}

function estimateSimilarityTransform(src: Array<[number, number]>, dst: Array<[number, number]>) {
  const n = src.length;
  let srcCx = 0;
  let srcCy = 0;
  let dstCx = 0;
  let dstCy = 0;
  for (let i = 0; i < n; i++) {
    srcCx += src[i]![0];
    srcCy += src[i]![1];
    dstCx += dst[i]![0];
    dstCy += dst[i]![1];
  }
  srcCx /= n;
  srcCy /= n;
  dstCx /= n;
  dstCy /= n;

  let srcVar = 0;
  let dotA = 0;
  let dotB = 0;
  for (let i = 0; i < n; i++) {
    const sx = src[i]![0] - srcCx;
    const sy = src[i]![1] - srcCy;
    const dx = dst[i]![0] - dstCx;
    const dy = dst[i]![1] - dstCy;
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

function applyAlignment(
  source: HTMLCanvasElement,
  { a, b, tx, ty }: { a: number; b: number; tx: number; ty: number },
  size: number,
) {
  const out = document.createElement("canvas");
  out.width = size;
  out.height = size;
  const ctx = out.getContext("2d");
  if (!ctx) return out;
  ctx.setTransform(a, b, -b, a, tx, ty);
  ctx.drawImage(source, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return out;
}

function cropWithPadding(
  source: HTMLCanvasElement | HTMLImageElement,
  box: { x: number; y: number; width: number; height: number },
  paddingRatio: number,
) {
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

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (ctx) ctx.drawImage(source, x0, y0, w, h, 0, 0, w, h);

  return {
    canvas,
    offsetX: x0,
    offsetY: y0,
    cropBox: { x: x0, y: y0, width: w, height: h },
  };
}

