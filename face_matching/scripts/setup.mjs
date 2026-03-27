/**
 * Setup script — copies face-api.js models and ONNX Runtime WASM files
 * into public/, then downloads the MobileFaceNet ONNX embedding model.
 *
 * Usage:  node scripts/setup.mjs
 */
import { promises as fs } from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT   = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function copyTree(src, dest) {
  await ensureDir(dest);
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyTree(s, d);
    } else {
      await fs.copyFile(s, d);
    }
  }
}

function download(url, dest, redirects = 10) {
  return new Promise((resolve, reject) => {
    if (redirects <= 0) return reject(new Error('Too many redirects'));
    const get = url.startsWith('https') ? https.get : https.get;
    get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return download(res.headers.location, dest, redirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => fs.writeFile(dest, Buffer.concat(chunks)).then(resolve, reject));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function main() {
  console.log('\n  Face Verification — Setup\n');

  /* ── 1. face-api.js models ────────────────────── */
  const faceApiSrc  = path.join(ROOT, 'node_modules', '@vladmandic', 'face-api', 'model');
  const faceApiDest = path.join(PUBLIC, 'models', 'face-api');

  process.stdout.write('  [1/3] Copying face-api.js models … ');
  try {
    await copyTree(faceApiSrc, faceApiDest);
    const count = (await fs.readdir(faceApiDest)).length;
    console.log(`done (${count} files)`);
  } catch (e) {
    console.log(`FAILED — ${e.message}`);
    console.log('        Make sure you ran  npm install  first.\n');
  }

  /* ── 2. ONNX Runtime WASM ─────────────────────── */
  const ortDist = path.join(ROOT, 'node_modules', 'onnxruntime-web', 'dist');
  const wasmDir = path.join(PUBLIC, 'wasm');

  process.stdout.write('  [2/3] Copying ONNX-Runtime WASM files … ');
  try {
    await ensureDir(wasmDir);
    const all = await fs.readdir(ortDist);
    const wasm = all.filter((f) => f.endsWith('.wasm'));
    for (const w of wasm) await fs.copyFile(path.join(ortDist, w), path.join(wasmDir, w));
    console.log(`done (${wasm.length} files)`);
  } catch (e) {
    console.log(`FAILED — ${e.message}`);
  }

  /* ── 3. MobileFaceNet ONNX model ──────────────── */
  const modelDest = path.join(PUBLIC, 'models', 'mobilefacenet.onnx');
  const MODEL_URL = 'https://huggingface.co/deepghs/insightface/resolve/4e1f33d3fe0e50a0945f3a53ab94ae8977ae7ddb/buffalo_s/w600k_mbf.onnx';

  process.stdout.write('  [3/3] Downloading MobileFaceNet ONNX model … ');
  try {
    try {
      await fs.access(modelDest);
      console.log('already exists — skipped');
    } catch {
      await ensureDir(path.dirname(modelDest));
      await download(MODEL_URL, modelDest);
      const stat = await fs.stat(modelDest);
      console.log(`done (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
    }
  } catch (e) {
    console.log(`FAILED — ${e.message}`);
    console.log('        You can manually place a compatible ONNX model at:');
    console.log(`          ${modelDest}`);
    console.log('        Sources:');
    console.log('          • https://github.com/nicehash/mobilefacenet-onnx');
    console.log('          • ONNX Model Zoo / InsightFace');
    console.log('        The app will fall back to face-api.js 128-D descriptors.\n');
  }

  /* ── 4. ZKP artifacts from main frontend ───────── */
  const kycZkpSrc = path.resolve(ROOT, '..', 'frontend', 'public', 'zkp');
  const kycZkpDest = path.join(PUBLIC, 'zkp');
  process.stdout.write('  [4/4] Copying flexibleKyc artifacts … ');
  try {
    await copyTree(kycZkpSrc, kycZkpDest);
    console.log('done');
  } catch (e) {
    console.log(`SKIPPED — ${e.message}`);
    console.log('        Run frontend circuit compile first, then re-run: npm run setup');
  }

  console.log('\n  Setup complete!  Run:  npm run dev\n');
}

main().catch(console.error);
