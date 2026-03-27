import { BrowserQRCodeReader } from "@zxing/browser";

async function tryDecodeCanvas(reader: BrowserQRCodeReader, canvas: HTMLCanvasElement): Promise<string | null> {
  try {
    const result = await reader.decodeFromCanvas(canvas);
    return result.getText();
  } catch {
    return null;
  }
}

/**
 * Front+back composite scans: try full image then back panel (usually right half) crops.
 */
function compositeCropCanvases(source: HTMLCanvasElement): HTMLCanvasElement[] {
  const w = source.width;
  const h = source.height;
  const out: HTMLCanvasElement[] = [];
  const cut = (sx: number, sy: number, sw: number, sh: number) => {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.floor(sw));
    c.height = Math.max(1, Math.floor(sh));
    const cx = c.getContext("2d");
    if (!cx) return;
    cx.drawImage(source, sx, sy, sw, sh, 0, 0, c.width, c.height);
    out.push(c);
  };
  if (w >= h * 1.12) {
    cut(Math.floor(w * 0.45), 0, Math.ceil(w * 0.55), h);
    cut(Math.floor(w * 0.5), 0, Math.ceil(w * 0.5), h);
    cut(Math.floor(w * 0.48), 0, Math.ceil(w * 0.52), h);
  }
  if (h >= w * 1.12) {
    cut(0, Math.floor(h * 0.48), w, Math.ceil(h * 0.52));
  }
  return out;
}

export async function decodeQrFromFile(file: File): Promise<string> {
  const reader = new BrowserQRCodeReader();

  const img = new Image();
  const url = URL.createObjectURL(file);

  img.src = url;

  await new Promise((resolve) => {
    img.onload = resolve;
  });

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  if (!ctx) {
    throw new Error("Canvas context could not be created");
  }

  canvas.width = img.width;
  canvas.height = img.height;

  ctx.drawImage(img, 0, 0);

  try {
    const direct = await tryDecodeCanvas(reader, canvas);
    if (direct) return direct;

    for (const crop of compositeCropCanvases(canvas)) {
      const t = await tryDecodeCanvas(reader, crop);
      if (t) return t;
    }

    throw new Error("QR not detected");
  } finally {
    URL.revokeObjectURL(url);
  }
}
