# Face Verification System

A **privacy-preserving, browser-only** face verification engine. All processing — face detection, alignment, embedding generation, and similarity scoring — runs entirely in the browser via WebAssembly and WebGL. **No images or biometric data ever leave your device.**

## Quick Start

```bash
npm install
npm run setup      # copies models + WASM files into public/
npm run dev        # starts Vite dev server on http://localhost:3000
```

## How It Works

| Step | What happens | Technology |
|------|-------------|------------|
| 1. Camera capture | 3 frames grabbed 250 ms apart | `getUserMedia` |
| 2. Face detection | SSD MobileNetV1 finds the face | face-api.js (TF.js) |
| 3. Landmark extraction | 68-point facial landmarks | face-api.js |
| 4. Alignment | 5-point similarity transform → 112×112 crop | Canvas 2D |
| 5. Embedding | MobileFaceNet ONNX model → 512-D vector | ONNX Runtime Web (WASM) |
| 6. Multi-frame averaging | Average 3 embeddings → L2 normalise | Pure JS |
| 7. Similarity | Cosine similarity + Euclidean distance | Pure JS |
| 8. Decision | Verified / Suspicious / Mismatch | Threshold logic |

## Architecture

```
Camera → Multi-frame Capture → Face Detection + Landmarks
                                        ↓
                              5-point Similarity Transform
                                        ↓
                              112×112 Aligned Face Canvas
                                        ↓
                         ┌──────────────┴──────────────┐
                    ONNX MobileFaceNet            face-api.js
                    (primary, 512-D)             (fallback, 128-D)
                         └──────────────┬──────────────┘
                                        ↓
                              Average + L2 Normalise
                                        ↓
                          Cosine Similarity / Euclidean Dist
                                        ↓
                              Verified / Suspicious / Mismatch
```

## Models

| Model | Purpose | Size | Source |
|-------|---------|------|--------|
| SSD MobileNetV1 | Face detection | ~5.4 MB | face-api.js |
| 68-point Landmarks | Facial alignment | ~350 KB | face-api.js |
| Face Recognition Net | Fallback 128-D descriptors | ~6.2 MB | face-api.js |
| MobileFaceNet (ArcFace) | Primary 512-D embeddings | ~13 MB | [InsightFace w600k_mbf](https://huggingface.co/deepghs/insightface) |

## Decision Thresholds

| Cosine Similarity | Status |
|-------------------|--------|
| ≥ 0.75 | **Verified** |
| 0.60 – 0.75 | **Suspicious** |
| < 0.60 | **Mismatch** |

These thresholds are calibrated for ArcFace-trained MobileFaceNet and work reasonably well with the face-api.js fallback.

## Privacy Guarantees

- **No network calls** after initial page load
- **No server-side processing** — everything runs in WASM / WebGL
- **No persistent storage** — images and embeddings exist only in memory
- **Active cleanup** — all biometric data is zeroed and canvas buffers cleared after comparison
- **No console logging** of any sensitive data

## File Structure

```
face_matching/
├── index.html                 Main HTML
├── package.json               Dependencies
├── vite.config.js             Vite configuration
├── scripts/
│   └── setup.mjs              Downloads/copies models + WASM
├── public/
│   ├── models/
│   │   ├── face-api/          SSD, Landmarks, Recognition weights
│   │   └── mobilefacenet.onnx ONNX embedding model
│   └── wasm/                  ONNX Runtime WASM binaries
└── src/
    ├── main.js                App orchestration + UI logic
    ├── camera.js              Webcam capture module
    ├── faceProcessor.js       Detection + alignment pipeline
    ├── embeddingEngine.js     ONNX model inference
    ├── similarity.js          Cosine / Euclidean + decision
    ├── privacyGuard.js        Memory cleanup
    └── styles.css             UI theme
```

## Result Object

The comparison function returns:

```js
{
  similarityScore: number,  // cosine similarity (−1 to 1)
  distance: number,         // Euclidean distance
  status: "verified" | "suspicious" | "mismatch"
}
```

## Browser Support

Requires a modern browser with:
- WebAssembly (ONNX Runtime)
- WebGL (TF.js / face-api.js)
- `getUserMedia` (camera access)
- ES2020 modules

Tested on Chrome 120+, Edge 120+, Firefox 120+.
