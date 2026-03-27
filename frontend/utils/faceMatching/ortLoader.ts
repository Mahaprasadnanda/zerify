let ortLoadPromise: Promise<unknown> | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-ort-src="${src}"]`) as HTMLScriptElement | null;
    if (existing) {
      if (existing.dataset.loaded === "true") return resolve();
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Failed to load ONNX Runtime bundle")), {
        once: true,
      });
      return;
    }

    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.dataset.ortSrc = src;
    s.dataset.loaded = "false";
    s.addEventListener("load", () => {
      s.dataset.loaded = "true";
      resolve();
    });
    s.addEventListener("error", () => reject(new Error("Failed to load ONNX Runtime bundle")));
    document.head.appendChild(s);
  });
}

export async function loadOrt(): Promise<unknown> {
  if (typeof window === "undefined") throw new Error("ORT loader can only run in the browser.");
  if (!ortLoadPromise) {
    ortLoadPromise = (async () => {
      // This file is copied into /public/vendor by `npm run setup:face-matching`.
      await loadScript("/vendor/ort.wasm.min.js");
      // onnxruntime-web UMD attaches to `window.ort` (and sometimes `globalThis.ort`)
      const g = globalThis as typeof globalThis & { ort?: unknown };
      if (!g.ort) {
        throw new Error("ONNX Runtime bundle loaded but `ort` global not found.");
      }
      return g.ort;
    })();
  }
  return await ortLoadPromise;
}

