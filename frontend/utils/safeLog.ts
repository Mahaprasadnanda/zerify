/**
 * Dev-only logging helpers — never pass PII, witness fields, embeddings, or proof payloads.
 * In production, these are no-ops so nothing sensitive can appear in DevTools.
 */

const isDev = process.env.NODE_ENV === "development";

export function safeLog(message: string): void {
  if (isDev) {
    console.log(message);
  }
}

export function safeWarn(message: string): void {
  if (isDev) {
    console.warn(message);
  }
}

export function safeError(message: string): void {
  if (isDev) {
    console.error(message);
  }
}
