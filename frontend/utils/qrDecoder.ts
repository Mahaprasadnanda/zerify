import { BrowserQRCodeReader } from "@zxing/browser";

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

  const result = await reader.decodeFromCanvas(canvas);

  return result.getText();
}