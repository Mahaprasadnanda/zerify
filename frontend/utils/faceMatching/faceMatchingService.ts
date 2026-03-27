import { EmbeddingEngine } from "./embeddingEngine";
import { assessFaceQuality } from "./quality";
import { cleanup, revokeURL, zeroOut } from "./privacyGuard";
import { compare, strictnessThresholds, type CompareResult, type Strictness } from "./similarity";
import { detectAndExtractFace, loadFaceApiModels, type ExtractedFace } from "./faceProcessor";

type ModelInitParams = {
  modelBaseUrl?: string;
  onnxModelUrl?: string;
  wasmBaseUrl?: string;
};

export type LiveProcessResult = {
  liveAlignedFaces: ExtractedFace[];
  livePreviewCanvases: HTMLCanvasElement[];
};

export type AadhaarProcessResult = {
  aadhaarEmbedding: Float32Array;
  aadhaarFaceCanvas: HTMLCanvasElement;
  /** ROI/padded crop region from the Aadhaar image that was used for alignment (for UI transparency). */
  aadhaarCropCanvas: HTMLCanvasElement;
  cropBox: { x: number; y: number; width: number; height: number };
  modelType: "arcface" | "faceapi";
  embeddingDim: number;
  objectUrl: string;
};

export class FaceMatchingService {
  #video: HTMLVideoElement | null = null;
  #embeddingEngine: EmbeddingEngine | null = null;
  #modelType: "arcface" | "faceapi" = "faceapi";
  #embeddingDim = 128;
  #aadhaarObjectUrl: string | null = null;

  async initModels(params: ModelInitParams = {}) {
    const modelBaseUrl = params.modelBaseUrl ?? "/models/face-api";
    await loadFaceApiModels(modelBaseUrl);

    this.#embeddingEngine = new EmbeddingEngine();
    if (params.wasmBaseUrl) {
      // Optional override; EmbeddingEngine also tries /wasm/ internally.
      // The ORT UMD bundle also reads env.wasm.wasmPaths when initialized.
      // We set it via the global env in the UMD module when it loads.
      void params.wasmBaseUrl;
    }
    const onnxUrl = params.onnxModelUrl ?? "/models/mobilefacenet.onnx";
    const ok = await this.#embeddingEngine.load(onnxUrl);
    if (ok) {
      this.#modelType = "arcface";
      this.#embeddingDim = this.#embeddingEngine.embeddingDim;
    } else {
      this.#modelType = "faceapi";
      this.#embeddingDim = 128;
    }
  }

  attachVideo(videoElement: HTMLVideoElement | null) {
    this.#video = videoElement;
  }

  async captureMultiFrameFromVideo(count = 5, delayMs = 220): Promise<HTMLCanvasElement[]> {
    if (!this.#video) throw new Error("Video not attached");
    const v = this.#video;
    if (v.videoWidth < 2 || v.videoHeight < 2) {
      throw new Error("Camera preview not ready yet. Try again.");
    }
    const frames: HTMLCanvasElement[] = [];
    for (let i = 0; i < count; i++) {
      const c = document.createElement("canvas");
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const ctx = c.getContext("2d");
      if (!ctx) throw new Error("Canvas context could not be created");
      ctx.drawImage(v, 0, 0);
      frames.push(c);
      if (i < count - 1) await new Promise((r) => window.setTimeout(r, delayMs));
    }
    return frames;
  }

  async processLiveFrames(frames: HTMLCanvasElement[]): Promise<LiveProcessResult> {
    const extracted: ExtractedFace[] = [];
    for (let i = 0; i < frames.length; i++) {
      const det = await detectAndExtractFace(frames[i]!, 0.5, 0.18);
      if (!det) {
        cleanup({ frames });
        throw new Error(`No face detected in frame ${i + 1}. Try again with better lighting.`);
      }
      const q = assessFaceQuality({
        alignedFace: det.alignedFace,
        score: det.score,
        box: det.box,
        sourceDims: { width: frames[i]!.width, height: frames[i]!.height },
        policy: { minScore: 0.8, minFaceFrac: 0.12, minBlurScore: 55 },
      });
      if (!q.ok) {
        cleanup({ frames, aligned: [det] });
        throw new Error(`Face quality is low (${q.issues.join(", ")}). Please retake in better lighting.`);
      }
      extracted.push(det);
    }

    return {
      liveAlignedFaces: extracted,
      livePreviewCanvases: extracted.map((d) => d.alignedFace),
    };
  }

  async buildLiveEmbeddingFromAlignedFaces(alignedFaces: ExtractedFace[]): Promise<Float32Array> {
    const embeddings: Float32Array[] = [];
    for (const det of alignedFaces) {
      let emb: Float32Array | null = null;
      if (this.#modelType === "arcface" && this.#embeddingEngine?.isLoaded) {
        emb = await this.#embeddingEngine.getEmbedding(det.alignedFace);
      }
      if (!emb) {
        emb = det.descriptor;
        this.#modelType = "faceapi";
        this.#embeddingDim = 128;
      }
      embeddings.push(emb);
    }
    const { averageEmbeddings } = await import("./similarity");
    return averageEmbeddings(embeddings);
  }

  async buildPerFrameEmbeddings(alignedFaces: ExtractedFace[]): Promise<{
    perFrame: Float32Array[];
    averaged: Float32Array;
  }> {
    const perFrame: Float32Array[] = [];
    for (const det of alignedFaces) {
      let emb: Float32Array | null = null;
      if (this.#modelType === "arcface" && this.#embeddingEngine?.isLoaded) {
        emb = await this.#embeddingEngine.getEmbedding(det.alignedFace);
      }
      if (!emb) {
        emb = det.descriptor;
        this.#modelType = "faceapi";
        this.#embeddingDim = 128;
      }
      perFrame.push(emb);
    }
    const { averageEmbeddings } = await import("./similarity");
    return { perFrame, averaged: averageEmbeddings(perFrame) };
  }

  comparePerFrame(
    perFrameEmbeddings: Float32Array[],
    aadhaarEmbedding: Float32Array,
    strictness: Strictness,
  ): CompareResult[] {
    const thresholds = strictnessThresholds(strictness);
    return perFrameEmbeddings.map((e) => compare(e, aadhaarEmbedding, thresholds));
  }

  async processAadhaarFile(file: File): Promise<AadhaarProcessResult> {
    if (this.#aadhaarObjectUrl) revokeURL(this.#aadhaarObjectUrl);
    const objectUrl = URL.createObjectURL(file);
    this.#aadhaarObjectUrl = objectUrl;

    const img = await loadImage(objectUrl);

    const maxDim = 1024;
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const imgCanvas = document.createElement("canvas");
    imgCanvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    imgCanvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = imgCanvas.getContext("2d");
    if (!ctx) throw new Error("Canvas context could not be created");
    ctx.drawImage(img, 0, 0, imgCanvas.width, imgCanvas.height);

    const det = await detectAndExtractFace(imgCanvas, 0.35, 0.2);
    if (!det) {
      throw new Error("No face found in the uploaded image. Try a clearer photo.");
    }

    const q = assessFaceQuality({
      alignedFace: det.alignedFace,
      score: det.score,
      box: det.box,
      sourceDims: { width: imgCanvas.width, height: imgCanvas.height },
      policy: { minScore: 0.55, minFaceFrac: 0.04, minBlurScore: 25 },
    });
    if (!q.ok) {
      const onlyFaceSmall = q.issues.length === 1 && q.issues[0] === "Face too small in image";
      if (!onlyFaceSmall) {
        cleanup({ aligned: [det] });
        throw new Error(`Face quality is low (${q.issues.join(", ")}). Please upload a clearer image.`);
      }
      // Proceed with a warning at UI level; we don't block the pipeline.
    }

    let emb: Float32Array | null = null;
    if (this.#modelType === "arcface" && this.#embeddingEngine?.isLoaded) {
      emb = await this.#embeddingEngine.getEmbedding(det.alignedFace);
    }
    if (!emb) {
      emb = det.descriptor;
      this.#modelType = "faceapi";
      this.#embeddingDim = 128;
    }

    return {
      aadhaarEmbedding: emb,
      aadhaarFaceCanvas: det.alignedFace,
      aadhaarCropCanvas: det.cropCanvas,
      cropBox: det.cropBox,
      modelType: this.#modelType,
      embeddingDim: this.#embeddingDim,
      objectUrl,
    };
  }

  compare(liveEmbedding: Float32Array, aadhaarEmbedding: Float32Array, strictness: Strictness): CompareResult {
    const thresholds = strictnessThresholds(strictness);
    return compare(liveEmbedding, aadhaarEmbedding, thresholds);
  }

  cleanup(params: {
    frames?: HTMLCanvasElement[];
    livePreviewCanvases?: HTMLCanvasElement[];
    liveAlignedFaces?: ExtractedFace[];
    liveEmbedding?: Float32Array | null;
    livePerFrameEmbeddings?: Float32Array[] | null;
    aadhaarFaceCanvas?: HTMLCanvasElement | null;
    aadhaarCropCanvas?: HTMLCanvasElement | null;
    aadhaarEmbedding?: Float32Array | null;
    aadhaarObjectUrl?: string | null;
  } = {}) {
    cleanup({
      frames: params.frames,
      aligned: [
        ...(params.liveAlignedFaces ?? []),
        ...(params.livePreviewCanvases ?? []).map((c) => ({ alignedFace: c })),
        params.aadhaarFaceCanvas || params.aadhaarCropCanvas
          ? { alignedFace: params.aadhaarFaceCanvas ?? undefined, cropCanvas: params.aadhaarCropCanvas ?? undefined }
          : null,
      ],
      embeddings: [params.liveEmbedding, params.aadhaarEmbedding, ...(params.livePerFrameEmbeddings ?? [])],
      urls: [params.aadhaarObjectUrl ?? this.#aadhaarObjectUrl],
    });
    if (params.liveEmbedding) zeroOut(params.liveEmbedding);
    if (params.aadhaarEmbedding) zeroOut(params.aadhaarEmbedding);
    if (params.livePerFrameEmbeddings) params.livePerFrameEmbeddings.forEach((e) => (e ? zeroOut(e) : undefined));
    if (this.#aadhaarObjectUrl) revokeURL(this.#aadhaarObjectUrl);
    this.#aadhaarObjectUrl = null;
  }

  dispose() {
    this.#embeddingEngine?.dispose();
    this.#embeddingEngine = null;
    this.#video = null;
    if (this.#aadhaarObjectUrl) revokeURL(this.#aadhaarObjectUrl);
    this.#aadhaarObjectUrl = null;
  }

  get modelInfo() {
    return { modelType: this.#modelType, embeddingDim: this.#embeddingDim };
  }
}

function loadImage(objectUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      revokeURL(objectUrl);
      reject(new Error("Failed to load image"));
    };
    img.src = objectUrl;
  });
}

