import { BrowserQRCodeReader } from "@zxing/browser";

function get2dContext(canvas) {
  return canvas.getContext("2d", { willReadFrequently: true });
}

function cloneCanvas(source) {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = get2dContext(canvas);
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0);
  return canvas;
}

function scaleCanvas(source, scale) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(source.width * scale));
  canvas.height = Math.max(1, Math.floor(source.height * scale));
  const ctx = get2dContext(canvas);
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function grayscaleCanvas(source, withThreshold = false) {
  const canvas = cloneCanvas(source);
  if (!canvas) return null;
  const ctx = get2dContext(canvas);
  if (!ctx) return null;
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const gray = Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
    const value = withThreshold ? (gray > 140 ? 255 : 0) : Math.max(0, Math.min(255, (gray - 96) * 2));
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

async function tryDecodeCanvas(reader, canvas) {
  try {
    const result = await reader.decodeFromCanvas(canvas);
    return result.getText();
  } catch {
    return null;
  }
}

function compositeCropCanvases(source) {
  const w = source.width;
  const h = source.height;
  const out = [];
  const cut = (sx, sy, sw, sh) => {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.floor(sw));
    c.height = Math.max(1, Math.floor(sh));
    const cx = get2dContext(c);
    if (!cx) return;
    cx.drawImage(source, sx, sy, sw, sh, 0, 0, c.width, c.height);
    out.push(c);
  };
  if (w >= h * 1.12) {
    cut(Math.floor(w * 0.35), 0, Math.ceil(w * 0.65), h);
    cut(Math.floor(w * 0.4), 0, Math.ceil(w * 0.6), h);
    cut(Math.floor(w * 0.45), 0, Math.ceil(w * 0.55), h);
    cut(Math.floor(w * 0.5), 0, Math.ceil(w * 0.5), h);
    cut(Math.floor(w * 0.48), 0, Math.ceil(w * 0.52), h);
    cut(Math.floor(w * 0.55), Math.floor(h * 0.08), Math.ceil(w * 0.35), Math.ceil(h * 0.84));
    cut(Math.floor(w * 0.6), Math.floor(h * 0.12), Math.ceil(w * 0.28), Math.ceil(h * 0.76));
  }
  if (h >= w * 1.12) {
    cut(0, Math.floor(h * 0.48), w, Math.ceil(h * 0.52));
  }
  return out;
}

function decodeCandidates(source) {
  const variants = [];
  const pushIf = (canvas) => {
    if (canvas) variants.push(canvas);
  };

  pushIf(source);
  pushIf(scaleCanvas(source, 1.5));
  pushIf(scaleCanvas(source, 2));
  pushIf(grayscaleCanvas(source, false));
  pushIf(grayscaleCanvas(source, true));

  for (const crop of compositeCropCanvases(source)) {
    pushIf(crop);
    pushIf(scaleCanvas(crop, 1.5));
    pushIf(scaleCanvas(crop, 2));
    pushIf(grayscaleCanvas(crop, false));
    pushIf(grayscaleCanvas(crop, true));
  }

  return variants;
}

export async function decodeQrFromFile(file) {
  const reader = new BrowserQRCodeReader();
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.src = url;
  await new Promise((resolve) => {
    img.onload = resolve;
  });
  const canvas = document.createElement("canvas");
  const ctx = get2dContext(canvas);
  if (!ctx) throw new Error("Canvas context could not be created");
  canvas.width = img.width;
  canvas.height = img.height;
  ctx.drawImage(img, 0, 0);

  try {
    for (const candidate of decodeCandidates(canvas)) {
      const text = await tryDecodeCanvas(reader, candidate);
      if (text) return text;
    }
    throw new Error("QR not detected");
  } finally {
    URL.revokeObjectURL(url);
  }
}
