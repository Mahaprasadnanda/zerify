/**
 * Face quality heuristics (browser-only, lightweight).
 *
 * These checks are intentionally simple and fast:
 * - detection confidence threshold
 * - face size threshold
 * - brightness (mean luminance)
 * - blur (variance of Laplacian approximation)
 */

export function assessFaceQuality({ alignedFace, score, box, sourceDims, policy }) {
  const issues = [];
  const p = {
    minScore: 0.8,
    minFaceFrac: 0.12,
    minMeanLuma: 70,
    maxMeanLuma: 200,
    minBlurScore: 55,
    ...(policy ?? {}),
  };

  const detScore = typeof score === 'number' ? score : 0;
  if (detScore < p.minScore) issues.push('Low detection confidence');

  if (box && sourceDims) {
    const faceFrac = Math.min(box.width / sourceDims.width, box.height / sourceDims.height);
    if (faceFrac < p.minFaceFrac) issues.push('Face too small in image');
  }

  const metrics = computeImageMetrics(alignedFace);
  if (metrics.meanLuma < p.minMeanLuma) issues.push('Image too dark');
  if (metrics.meanLuma > p.maxMeanLuma) issues.push('Image too bright');
  if (metrics.blurScore < p.minBlurScore) issues.push('Image appears blurry');

  return { ok: issues.length === 0, issues, metrics };
}

export function computeImageMetrics(canvas) {
  const ctx = canvas.getContext('2d');
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);

  // Mean luminance
  let sumY = 0;
  const y = new Float32Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    // BT.601 luma approximation
    const Y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    y[p] = Y;
    sumY += Y;
  }
  const meanLuma = sumY / y.length;

  // Blur score: variance of Laplacian (approx) on luminance
  // Use a 3x3 Laplacian kernel: [0 1 0; 1 -4 1; 0 1 0]
  let sumL = 0;
  let sumL2 = 0;
  let count = 0;
  for (let row = 1; row < height - 1; row++) {
    for (let col = 1; col < width - 1; col++) {
      const idx = row * width + col;
      const lap =
        (y[idx - width] + y[idx - 1] + y[idx + 1] + y[idx + width]) -
        4 * y[idx];
      sumL += lap;
      sumL2 += lap * lap;
      count++;
    }
  }
  const meanL = sumL / Math.max(1, count);
  const varL = sumL2 / Math.max(1, count) - meanL * meanL;
  const blurScore = varL; // higher = sharper

  return { meanLuma, blurScore };
}

