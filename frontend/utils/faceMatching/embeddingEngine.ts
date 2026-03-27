import { loadOrt } from "./ortLoader";

// UMD `onnxruntime-web` attaches `ort` to globalThis.
type OrtUMD = {
  env: {
    wasm: { numThreads: number; wasmPaths?: string | Record<string, unknown> };
    logLevel: "verbose" | "info" | "warning" | "error" | "fatal";
  };
  InferenceSession: {
    create: (
      url: string,
      opts: { executionProviders: Array<"wasm">; graphOptimizationLevel: string },
    ) => Promise<{
      inputNames: string[];
      outputNames: string[];
      run: (feeds: Record<string, unknown>) => Promise<Record<string, { data: unknown }>>;
      release: () => void;
    }>;
  };
  Tensor: new (type: "float32", data: Float32Array, dims: number[]) => unknown;
};

let ortPromise: Promise<OrtUMD> | null = null;

async function ort(): Promise<OrtUMD> {
  if (!ortPromise) {
    ortPromise = loadOrt().then((g) => g as OrtUMD);
  }
  const o = await ortPromise;
  // Match reference behavior: WASM backend, 1 thread, warning-level logs (no sensitive output).
  o.env.wasm.numThreads = 1;
  o.env.logLevel = "warning";
  return o;
}

export class EmbeddingEngine {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #session: any | null = null;
  #inputName: string | null = null;
  #outputName: string | null = null;
  #dim = 0;

  get isLoaded() {
    return this.#session !== null;
  }

  get embeddingDim() {
    return this.#dim;
  }

  async load(modelUrl: string): Promise<boolean> {
    const o = await ort();
    // Force runtime assets to local static path to avoid `/vendor/ort-wasm-simd-threaded.mjs` resolution.
    o.env.wasm.wasmPaths = "/wasm/";
    try {
      this.#session = await o.InferenceSession.create(modelUrl, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
    } catch {
      try {
        this.#session = await o.InferenceSession.create(modelUrl, {
          executionProviders: ["wasm"],
          graphOptimizationLevel: "all",
        });
      } catch {
        this.#session = null;
        return false;
      }
    }

    try {
      this.#inputName = this.#session.inputNames[0] ?? null;
      this.#outputName = this.#session.outputNames[0] ?? null;
      if (!this.#inputName || !this.#outputName) throw new Error("Invalid ONNX graph IO");

      const dummy = new o.Tensor("float32", new Float32Array(1 * 3 * 112 * 112), [1, 3, 112, 112]);
      const out = await this.#session.run({ [this.#inputName]: dummy });
      const t = out[this.#outputName];
      const dim = typeof t?.data?.length === "number" ? t.data.length : 0;
      if (dim <= 0) throw new Error("Invalid embedding dim");
      this.#dim = dim;
      return true;
    } catch {
      this.#session = null;
      this.#inputName = null;
      this.#outputName = null;
      this.#dim = 0;
      return false;
    }
  }

  async getEmbedding(alignedCanvas: HTMLCanvasElement): Promise<Float32Array | null> {
    if (!this.#session || !this.#inputName || !this.#outputName) return null;
    const o = await ort();
    const tensor = this.#preprocess(alignedCanvas, o);
    const results = await this.#session.run({ [this.#inputName]: tensor });
    const raw = results[this.#outputName]?.data;
    if (!raw) return null;
    return new Float32Array(raw as Float32Array);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #preprocess(canvas: HTMLCanvasElement, o: OrtUMD): any {
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return new o.Tensor("float32", new Float32Array(1 * 3 * 112 * 112), [1, 3, 112, 112]);
    }
    const img = ctx.getImageData(0, 0, 112, 112);
    const data = img.data;

    photometricNormalizeInPlace(data);

    const pixels = 112 * 112;
    const buf = new Float32Array(3 * pixels);
    for (let i = 0; i < pixels; i++) {
      const off = i * 4;
      buf[i] = (data[off]! - 127.5) / 127.5;
      buf[pixels + i] = (data[off + 1]! - 127.5) / 127.5;
      buf[2 * pixels + i] = (data[off + 2]! - 127.5) / 127.5;
    }
    return new o.Tensor("float32", buf, [1, 3, 112, 112]);
  }

  dispose() {
    if (this.#session) {
      this.#session.release();
      this.#session = null;
    }
    this.#inputName = null;
    this.#outputName = null;
    this.#dim = 0;
  }
}

function photometricNormalizeInPlace(rgba: Uint8ClampedArray) {
  const targetMean = 128;
  const targetStd = 52;
  const eps = 1e-6;

  let sumY = 0;
  let sumY2 = 0;
  const n = rgba.length / 4;

  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i]!;
    const g = rgba[i + 1]!;
    const b = rgba[i + 2]!;
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    sumY += y;
    sumY2 += y * y;
  }

  const mean = sumY / Math.max(1, n);
  const varY = sumY2 / Math.max(1, n) - mean * mean;
  const std = Math.sqrt(Math.max(eps, varY));
  const scale = targetStd / std;

  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i]!;
    const g = rgba[i + 1]!;
    const b = rgba[i + 2]!;
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const y2 = clamp((y - mean) * scale + targetMean, 0, 255);
    const ratio = y > eps ? y2 / y : 1;
    rgba[i] = clamp(r * ratio, 0, 255);
    rgba[i + 1] = clamp(g * ratio, 0, 255);
    rgba[i + 2] = clamp(b * ratio, 0, 255);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

