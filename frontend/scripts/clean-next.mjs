import { rm } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const nextDir = path.join(root, ".next");

try {
  await rm(nextDir, { recursive: true, force: true });
  process.stdout.write("Cleaned .next cache\n");
} catch {
  // ignore
}

