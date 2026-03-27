export function clearCanvas(canvas: HTMLCanvasElement | null | undefined) {
  if (!canvas) return;
  try {
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    // ignore
  }
}

export function zeroOut(arr: Float32Array | null | undefined) {
  if (arr && typeof arr.fill === "function") {
    arr.fill(0);
  }
}

export function revokeURL(url: string | null | undefined) {
  if (!url) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    // ignore
  }
}

export function cleanup(resources: {
  frames?: HTMLCanvasElement[];
  aligned?: Array<{
    alignedFace?: HTMLCanvasElement;
    cropCanvas?: HTMLCanvasElement;
    descriptor?: Float32Array;
  } | null | undefined>;
  embeddings?: Array<Float32Array | null | undefined>;
  urls?: Array<string | null | undefined>;
} = {}) {
  const { frames, aligned, embeddings, urls } = resources;

  if (frames) frames.forEach(clearCanvas);

  if (aligned) {
    aligned.forEach((item) => {
      if (!item) return;
      if (item.cropCanvas) clearCanvas(item.cropCanvas);
      if (item.alignedFace) clearCanvas(item.alignedFace);
      if (item.descriptor) zeroOut(item.descriptor);
    });
  }

  if (embeddings) embeddings.forEach((e) => (e ? zeroOut(e) : undefined));
  if (urls) urls.forEach(revokeURL);
}

