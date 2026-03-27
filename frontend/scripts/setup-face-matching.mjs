/**
 * Setup helper (dev-time) for Face Matching assets:
 * - copies ONNX Runtime WASM files into `public/wasm/`
 * - downloads MobileFaceNet ONNX into `public/models/mobilefacenet.onnx`
 *
 * Runtime is browser-only; assets are served locally by Next.js from /public.
 */
import { promises as fs } from "fs";
import path from "path";
import https from "https";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function download(url, dest, redirects = 10) {
  return new Promise((resolve, reject) => {
    if (redirects <= 0) return reject(new Error("Too many redirects"));
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return download(res.headers.location, dest, redirects - 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => fs.writeFile(dest, Buffer.concat(chunks)).then(resolve, reject));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

async function main() {
  process.stdout.write("\nFace Matching — asset setup\n\n");

  // 1) ONNX Runtime WASM
  const ortDist = path.join(ROOT, "node_modules", "onnxruntime-web", "dist");
  const wasmDir = path.join(PUBLIC, "wasm");
  const vendorDir = path.join(PUBLIC, "vendor");
  process.stdout.write("[1/3] Copying ONNX Runtime WASM … ");
  await ensureDir(wasmDir);
  const all = await fs.readdir(ortDist);
  const wasm = all.filter((f) => f.endsWith(".wasm"));
  const wasmMjs = all.filter((f) => /^ort-wasm-.*\.mjs$/i.test(f));
  for (const w of wasm) await fs.copyFile(path.join(ortDist, w), path.join(wasmDir, w));
  for (const m of wasmMjs) await fs.copyFile(path.join(ortDist, m), path.join(wasmDir, m));
  process.stdout.write(`done (${wasm.length + wasmMjs.length} files)\n`);

  // 2) ORT UMD bundle (loaded via <script> to avoid webpack ESM minification issues)
  process.stdout.write("[2/3] Copying ORT UMD bundle … ");
  await ensureDir(vendorDir);
  await fs.copyFile(path.join(ortDist, "ort.wasm.min.js"), path.join(vendorDir, "ort.wasm.min.js"));
  process.stdout.write("done (ort.wasm.min.js)\n");

  // 2) MobileFaceNet ONNX model
  const modelDest = path.join(PUBLIC, "models", "mobilefacenet.onnx");
  const MODEL_URL =
    "https://huggingface.co/deepghs/insightface/resolve/4e1f33d3fe0e50a0945f3a53ab94ae8977ae7ddb/buffalo_s/w600k_mbf.onnx";
  process.stdout.write("[3/3] Downloading MobileFaceNet ONNX … ");
  try {
    await fs.access(modelDest);
    process.stdout.write("already exists — skipped\n");
  } catch {
    await ensureDir(path.dirname(modelDest));
    await download(MODEL_URL, modelDest);
    const stat = await fs.stat(modelDest);
    process.stdout.write(`done (${(stat.size / 1024 / 1024).toFixed(1)} MB)\n`);
  }

  process.stdout.write("\nSetup complete.\n");
  process.stdout.write("Assets served from:\n");
  process.stdout.write("  - /public/wasm/*\n");
  process.stdout.write("  - /public/vendor/ort.wasm.min.js\n");
  process.stdout.write("  - /public/models/mobilefacenet.onnx\n\n");
}

main().catch((e) => {
  process.stderr.write(`Setup failed: ${e?.message ?? String(e)}\n`);
  process.exitCode = 1;
});

