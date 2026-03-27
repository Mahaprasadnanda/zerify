/**
 * Embedding Engine — loads a MobileFaceNet (ArcFace-trained) ONNX model
 * via ONNX Runtime Web (WASM backend) and produces face embedding vectors.
 *
 * Preprocessing (matching InsightFace / ArcFace convention):
 *   1. Expect a 112x112 aligned-face canvas
 *   2. Convert to float32, NCHW layout
 *   3. Normalise pixels: (value − 127.5) / 127.5  →  [−1, 1]
 *
 * The module is model-agnostic: input/output tensor names and the embedding
 * dimension are read from the ONNX graph at load time, so any compatible
 * face-embedding model can be dropped in.
 */
import * as ort from 'onnxruntime-web';

ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'warning';

export class EmbeddingEngine {
  #session = null;
  #inputName = null;
  #outputName = null;
  #dim = 0;

  get isLoaded() {
    return this.#session !== null;
  }

  get embeddingDim() {
    return this.#dim;
  }

  async load(modelUrl) {
    // Attempt 1: let the onnxruntime bundle handle WASM resolution internally
    try {
      this.#session = await ort.InferenceSession.create(modelUrl, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
    } catch {
      // Attempt 2: point to local WASM files explicitly
      try {
        ort.env.wasm.wasmPaths = '/wasm/';
        this.#session = await ort.InferenceSession.create(modelUrl, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all',
        });
      } catch {
        this.#session = null;
        return false;
      }
    }

    try {
      this.#inputName = this.#session.inputNames[0];
      this.#outputName = this.#session.outputNames[0];

      const dummy = new ort.Tensor('float32', new Float32Array(1 * 3 * 112 * 112), [1, 3, 112, 112]);
      const out = await this.#session.run({ [this.#inputName]: dummy });
      this.#dim = out[this.#outputName].data.length;

      return true;
    } catch {
      this.#session = null;
      return false;
    }
  }

  /**
   * Run the aligned 112x112 face through the ONNX model.
   * @param {HTMLCanvasElement} alignedCanvas  112x112 aligned face
   * @returns {Promise<Float32Array|null>}  raw embedding (caller should L2-normalise)
   */
  async getEmbedding(alignedCanvas) {
    if (!this.#session) return null;

    const tensor = this.#preprocess(alignedCanvas);
    const results = await this.#session.run({ [this.#inputName]: tensor });
    const raw = results[this.#outputName].data;

    return new Float32Array(raw);
  }

  #preprocess(canvas) {
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, 112, 112);
    const data = img.data;

    // Photometric normalisation to reduce lighting differences between
    // webcam frames and low-quality ID photos.
    // Approach: normalise luminance to a target mean/std, then re-apply to RGB
    // by scaling each pixel (preserving chroma as much as possible).
    photometricNormalizeInPlace(data);

    const pixels = 112 * 112;
    const buf = new Float32Array(3 * pixels);

    for (let i = 0; i < pixels; i++) {
      const off = i * 4;
      buf[i]              = (data[off]     - 127.5) / 127.5;  // R
      buf[pixels + i]     = (data[off + 1] - 127.5) / 127.5;  // G
      buf[2 * pixels + i] = (data[off + 2] - 127.5) / 127.5;  // B
    }

    return new ort.Tensor('float32', buf, [1, 3, 112, 112]);
  }

  dispose() {
    if (this.#session) {
      this.#session.release();
      this.#session = null;
    }
  }
}

function photometricNormalizeInPlace(rgba) {
  // Target stats chosen to avoid over-amplifying noise in dark ID photos.
  const targetMean = 128;
  const targetStd = 52;
  const eps = 1e-6;

  let sumY = 0;
  let sumY2 = 0;
  const n = rgba.length / 4;

  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    sumY += y;
    sumY2 += y * y;
  }

  const mean = sumY / n;
  const varY = sumY2 / n - mean * mean;
  const std = Math.sqrt(Math.max(eps, varY));
  const scale = targetStd / std;

  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const y2 = clamp((y - mean) * scale + targetMean, 0, 255);
    const ratio = y > eps ? (y2 / y) : 1;

    rgba[i]     = clamp(r * ratio, 0, 255);
    rgba[i + 1] = clamp(g * ratio, 0, 255);
    rgba[i + 2] = clamp(b * ratio, 0, 255);
    // alpha unchanged
  }
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
