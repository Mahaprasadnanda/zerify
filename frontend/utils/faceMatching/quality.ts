export type FaceQualityPolicy = {
  minScore?: number;
  minFaceFrac?: number;
  minMeanLuma?: number;
  maxMeanLuma?: number;
  minBlurScore?: number;
};

export type FaceQualityAssessment = {
  ok: boolean;
  issues: string[];
  metrics: { meanLuma: number; blurScore: number };
};

export function assessFaceQuality(params: {
  alignedFace: HTMLCanvasElement;
  score: number;
  box: { width: number; height: number };
  sourceDims: { width: number; height: number };
  policy?: FaceQualityPolicy;
}): FaceQualityAssessment {
  const issues: string[] = [];
  const p: Required<FaceQualityPolicy> = {
    minScore: 0.8,
    minFaceFrac: 0.12,
    minMeanLuma: 70,
    maxMeanLuma: 200,
    minBlurScore: 55,
    ...(params.policy ?? {}),
  };

  const detScore = Number.isFinite(params.score) ? params.score : 0;
  if (detScore < p.minScore) issues.push("Low detection confidence");

  const faceFrac = Math.min(
    params.box.width / params.sourceDims.width,
    params.box.height / params.sourceDims.height,
  );
  if (faceFrac < p.minFaceFrac) issues.push("Face too small in image");

  const metrics = computeImageMetrics(params.alignedFace);
  if (metrics.meanLuma < p.minMeanLuma) issues.push("Image too dark");
  if (metrics.meanLuma > p.maxMeanLuma) issues.push("Image too bright");
  if (metrics.blurScore < p.minBlurScore) issues.push("Image appears blurry");

  return { ok: issues.length === 0, issues, metrics };
}

export function computeImageMetrics(canvas: HTMLCanvasElement): { meanLuma: number; blurScore: number } {
  const ctx = canvas.getContext("2d");
  if (!ctx) return { meanLuma: 0, blurScore: 0 };
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);

  let sumY = 0;
  const y = new Float32Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const Y = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
    y[p] = Y;
    sumY += Y;
  }
  const meanLuma = sumY / Math.max(1, y.length);

  let sumL = 0;
  let sumL2 = 0;
  let count = 0;
  for (let row = 1; row < height - 1; row++) {
    for (let col = 1; col < width - 1; col++) {
      const idx = row * width + col;
      const lap = (y[idx - width]! + y[idx - 1]! + y[idx + 1]! + y[idx + width]!) - 4 * y[idx]!;
      sumL += lap;
      sumL2 += lap * lap;
      count++;
    }
  }
  const meanL = sumL / Math.max(1, count);
  const varL = sumL2 / Math.max(1, count) - meanL * meanL;
  const blurScore = varL;

  return { meanLuma, blurScore };
}

