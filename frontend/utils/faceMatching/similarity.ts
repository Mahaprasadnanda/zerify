export type Strictness = "strict" | "balanced" | "lenient";

export type CompareThresholds = {
  verifiedCos: number;
  verifiedDist: number;
  suspiciousMinCos: number;
  suspiciousMaxCos: number;
};

export type CompareResult = {
  similarityScore: number;
  distance: number;
  status: "verified" | "suspicious" | "mismatch";
  explanation: string;
};

export function l2Normalize(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i]! * vec[i]!;
  norm = Math.sqrt(norm);
  if (!Number.isFinite(norm) || norm === 0) return new Float32Array(vec.length);
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i]! / norm;
  return out;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) dot += a[i]! * b[i]!;
  return dot;
}

export function euclideanDistance(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i++) {
    const d = a[i]! - b[i]!;
    sum += d * d;
  }
  return Math.sqrt(sum);
}

export function averageEmbeddings(embeddings: Float32Array[]): Float32Array {
  if (embeddings.length === 0) throw new Error("No embeddings to average");
  if (embeddings.length === 1) return l2Normalize(embeddings[0]!);
  const dim = embeddings[0]!.length;
  const avg = new Float32Array(dim);
  for (const emb of embeddings) {
    const len = Math.min(dim, emb.length);
    for (let i = 0; i < len; i++) avg[i] += emb[i]!;
  }
  for (let i = 0; i < dim; i++) avg[i] /= embeddings.length;
  return l2Normalize(avg);
}

export function strictnessThresholds(strictness: Strictness): CompareThresholds {
  // Matches face_matching/src/main.js exactly.
  if (strictness === "strict") {
    return { verifiedCos: 0.7, verifiedDist: 0.82, suspiciousMinCos: 0.55, suspiciousMaxCos: 0.7 };
  }
  if (strictness === "lenient") {
    return { verifiedCos: 0.62, verifiedDist: 0.9, suspiciousMinCos: 0.5, suspiciousMaxCos: 0.65 };
  }
  return { verifiedCos: 0.65, verifiedDist: 0.85, suspiciousMinCos: 0.5, suspiciousMaxCos: 0.65 };
}

export function compare(
  embeddingA: Float32Array,
  embeddingB: Float32Array,
  thresholds?: Partial<CompareThresholds>,
): CompareResult {
  const a = l2Normalize(embeddingA);
  const b = l2Normalize(embeddingB);

  const similarityScore = cosineSimilarity(a, b);
  const distance = euclideanDistance(a, b);

  const VERIFIED_COS = thresholds?.verifiedCos ?? 0.65;
  const VERIFIED_DIST = thresholds?.verifiedDist ?? 0.85;
  const SUSPICIOUS_MIN_COS = thresholds?.suspiciousMinCos ?? 0.5;
  const SUSPICIOUS_MAX_COS = thresholds?.suspiciousMaxCos ?? 0.65;

  if (similarityScore > VERIFIED_COS && distance < VERIFIED_DIST) {
    return { similarityScore, distance, status: "verified", explanation: "High confidence match" };
  }
  if (similarityScore >= SUSPICIOUS_MIN_COS && similarityScore <= SUSPICIOUS_MAX_COS) {
    return {
      similarityScore,
      distance,
      status: "suspicious",
      explanation: "Moderate similarity (possible lighting/angle/age variation)",
    };
  }
  return { similarityScore, distance, status: "mismatch", explanation: "Low similarity (likely different identity)" };
}

