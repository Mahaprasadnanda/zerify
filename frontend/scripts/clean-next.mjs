import { rm } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const nextDir = path.join(root, ".next");

async function isDevServerRunning() {
  // If a Next dev server is already running on 3000, deleting `.next` will crash it
  // (e.g. missing generated `pages/_document.js`).
  // So we skip cleaning in that case.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 450);
  try {
    const res = await fetch("http://localhost:3000/", { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

try {
  if (await isDevServerRunning()) {
    process.stdout.write("Skipped cleaning .next (dev server already running)\n");
  } else {
    await rm(nextDir, { recursive: true, force: true });
    process.stdout.write("Cleaned .next cache\n");
  }
} catch {
  // ignore
}

