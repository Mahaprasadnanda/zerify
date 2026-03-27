/**
 * Camera module — handles webcam initialization, live preview,
 * and multi-frame capture. Frames are kept in memory only.
 */
export class Camera {
  #stream = null;
  #videoEl = null;

  constructor(videoElement) {
    this.#videoEl = videoElement;
  }

  async #waitForVideoReady({ timeoutMs = 15000 } = {}) {
    const v = this.#videoEl;
    // If metadata is already available, don't wait.
    if (v.videoWidth > 0 && v.videoHeight > 0) return;

    await new Promise((resolve, reject) => {
      let done = false;
      const t = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error("Timeout starting video source"));
      }, timeoutMs);

      const onReady = () => {
        if (done) return;
        // Some browsers fire loadedmetadata but still have 0x0 briefly.
        if (v.videoWidth > 0 && v.videoHeight > 0) {
          done = true;
          cleanup();
          resolve();
        }
      };

      const cleanup = () => {
        clearTimeout(t);
        v.removeEventListener("loadedmetadata", onReady);
        v.removeEventListener("loadeddata", onReady);
        v.removeEventListener("canplay", onReady);
        v.removeEventListener("playing", onReady);
      };

      v.addEventListener("loadedmetadata", onReady, { once: false });
      v.addEventListener("loadeddata", onReady, { once: false });
      v.addEventListener("canplay", onReady, { once: false });
      v.addEventListener("playing", onReady, { once: false });
    });
  }

  async start() {
    // Ensure we don't hold a stale device lock.
    this.stop();

    try {
      // Try a couple of constraint sets; some devices/browsers are picky.
      const attempts = [
        { video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" }, audio: false },
        { video: { facingMode: "user" }, audio: false },
        { video: true, audio: false },
      ];

      let lastErr = null;
      for (const constraints of attempts) {
        try {
          this.#stream = await navigator.mediaDevices.getUserMedia(constraints);
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (!this.#stream) throw lastErr ?? new Error("Failed to access camera");

      const v = this.#videoEl;
      // Ensure these are set to avoid autoplay issues.
      v.muted = true;
      v.playsInline = true;
      v.autoplay = true;
      v.srcObject = this.#stream;

      await this.#waitForVideoReady({ timeoutMs: 15000 });
      await v.play();
      // Some browsers only become non-0x0 after play.
      await this.#waitForVideoReady({ timeoutMs: 15000 });
    } catch (err) {
      const name = err?.name;
      const message = err instanceof Error ? err.message : String(err);
      if (name === "NotAllowedError") {
        throw new Error("Camera permission denied. Please allow camera access and reload.");
      }
      if (name === "NotFoundError") {
        throw new Error("No camera found. Please connect a webcam.");
      }
      if (name === "NotReadableError") {
        throw new Error(
          "Camera is busy (device in use). Close other apps/tabs using the camera and click “Retry camera”.",
        );
      }
      if (name === "OverconstrainedError") {
        throw new Error("Camera constraints not supported by this device. Try another camera or browser.");
      }
      throw new Error(`Camera error: ${message}`);
    }
  }

  stop() {
    if (this.#stream) {
      this.#stream.getTracks().forEach((t) => t.stop());
      this.#stream = null;
    }
    if (this.#videoEl) {
      this.#videoEl.srcObject = null;
    }
  }

  captureFrame() {
    if (!this.#stream || !this.#stream.active) {
      throw new Error('Camera is not active');
    }
    const canvas = document.createElement('canvas');
    canvas.width = this.#videoEl.videoWidth;
    canvas.height = this.#videoEl.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(this.#videoEl, 0, 0);
    return canvas;
  }

  async captureMultiFrame(count = 3, delayMs = 250) {
    const frames = [];
    for (let i = 0; i < count; i++) {
      frames.push(this.captureFrame());
      if (i < count - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    return frames;
  }

  get isActive() {
    return this.#stream !== null && this.#stream.active;
  }
}
