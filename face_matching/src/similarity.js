/**
 * Similarity computation — cosine similarity, Euclidean distance,
 * multi-frame averaging, and verification decision logic.
 */

export function l2Normalize(vec) {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return new Float32Array(vec.length);
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

export function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

export function averageEmbeddings(embeddings) {
  if (embeddings.length === 0) throw new Error('No embeddings to average');
  if (embeddings.length === 1) return l2Normalize(embeddings[0]);

  const dim = embeddings[0].length;
  const avg = new Float32Array(dim);
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) avg[i] += emb[i];
  }
  for (let i = 0; i < dim; i++) avg[i] /= embeddings.length;
  return l2Normalize(avg);
}

/**
 * Compare two L2-normalised embeddings and return a verification decision.
 *
 * Thresholds calibrated for ArcFace-trained MobileFaceNet (128-D / 512-D).
 * For the face-api.js fallback (128-D ResNet) the cosine distribution is
 * broadly similar after L2 normalisation so the same cut-offs work
 * as a reasonable default.
 */
export function compare(embeddingA, embeddingB, thresholds = undefined) {
  const a = l2Normalize(embeddingA);
  const b = l2Normalize(embeddingB);

  const similarityScore = cosineSimilarity(a, b);
  const distance = euclideanDistance(a, b);

  // Calibrated defaults based on observed browser behavior for old/low-quality ID
  // images + live webcam frames. Uses both cosine and Euclidean distance.
  const VERIFIED_COS = thresholds?.verifiedCos ?? 0.65;
  const VERIFIED_DIST = thresholds?.verifiedDist ?? 0.85;
  const SUSPICIOUS_MIN_COS = thresholds?.suspiciousMinCos ?? 0.50;
  const SUSPICIOUS_MAX_COS = thresholds?.suspiciousMaxCos ?? 0.65;

  let status;
  let explanation;

  if (similarityScore > VERIFIED_COS && distance < VERIFIED_DIST) {
    status = 'verified';
    explanation = 'High confidence match';
  } else if (similarityScore >= SUSPICIOUS_MIN_COS && similarityScore <= SUSPICIOUS_MAX_COS) {
    status = 'suspicious';
    explanation = 'Moderate similarity (possible lighting/angle/age variation)';
  } else {
    status = 'mismatch';
    explanation = 'Low similarity (likely different identity)';
  }

  return { similarityScore, distance, status, explanation };
}
