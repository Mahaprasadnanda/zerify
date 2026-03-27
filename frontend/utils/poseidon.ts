let poseidonPromise: Promise<{
  poseidon: (inputs: bigint[]) => unknown;
  F: { toString: (x: unknown) => string };
}> | null = null;

async function getPoseidon() {
  if (poseidonPromise) return poseidonPromise;
  poseidonPromise = (async () => {
    const lib = (await import("circomlibjs")) as unknown as {
      buildPoseidon: () => Promise<(inputs: bigint[]) => unknown>;
    };
    const poseidon = await lib.buildPoseidon();
    const F = (poseidon as any).F as { toString: (x: unknown) => string };
    return { poseidon, F };
  })();
  return poseidonPromise;
}

export function quantizeEmbeddingToFieldInputs(
  embedding: Float32Array,
  opts?: { scale?: number; clampAbs?: number },
): bigint[] {
  const scale = opts?.scale ?? 1000;
  const clampAbs = opts?.clampAbs ?? 1_000_000;
  const SHIFT = 2n ** 32n;
  const out: bigint[] = new Array(embedding.length);
  for (let i = 0; i < embedding.length; i++) {
    const v = embedding[i] ?? 0;
    let q = Math.round(v * scale);
    if (q > clampAbs) q = clampAbs;
    if (q < -clampAbs) q = -clampAbs;
    const bi = BigInt(q);
    out[i] = bi < 0n ? bi + SHIFT : bi;
  }
  return out;
}

export async function poseidonHash(inputs: bigint[]): Promise<string> {
  const { poseidon, F } = await getPoseidon();
  if (inputs.length > 16) {
    return poseidonHashMerkle(inputs);
  }
  const h = poseidon(inputs);
  return F.toString(h);
}

/** circomlibjs Poseidon allows at most 16 inputs; tree-reduce longer vectors (e.g. 128-d face embedding). */
export async function poseidonHashMerkle(elements: bigint[]): Promise<string> {
  const { poseidon, F } = await getPoseidon();
  let level = [...elements];
  while (level.length > 1) {
    const next: bigint[] = [];
    for (let i = 0; i < level.length; i += 16) {
      const chunk = level.slice(i, i + 16);
      const padded = [...chunk];
      while (padded.length < 16) padded.push(0n);
      const h = poseidon(padded.slice(0, 16));
      next.push(BigInt(F.toString(h)));
    }
    level = next;
  }
  return level[0]!.toString();
}

/** Single field element binding the face-api descriptor for commitment proofs. */
export async function poseidonHashEmbedding(embedding: Float32Array): Promise<string> {
  const inputs = quantizeEmbeddingToFieldInputs(embedding);
  return poseidonHashMerkle(inputs);
}

