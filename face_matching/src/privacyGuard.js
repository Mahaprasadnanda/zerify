/**
 * Privacy Guard — zeroes out all sensitive data from memory
 * after the verification flow completes.
 */

export function clearCanvas(canvas) {
  if (!canvas) return;
  try {
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.width = 0;
    canvas.height = 0;
  } catch { /* already detached */ }
}

export function zeroOut(arr) {
  if (arr && typeof arr.fill === 'function') {
    arr.fill(0);
  }
}

export function revokeURL(url) {
  if (url) {
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
  }
}

export function cleanup(resources = {}) {
  const { frames, aligned, embeddings, urls } = resources;

  if (frames) frames.forEach(clearCanvas);

  if (aligned) {
    aligned.forEach((item) => {
      if (!item) return;
      if (item.alignedFace) clearCanvas(item.alignedFace);
      if (item.descriptor) zeroOut(item.descriptor);
    });
  }

  if (embeddings) {
    embeddings.forEach((e) => { if (e) zeroOut(e); });
  }

  if (urls) urls.forEach(revokeURL);
}
