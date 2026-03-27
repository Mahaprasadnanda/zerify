#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo
echo "Face Verification - Local Runner (macOS/Linux)"
echo "---------------------------------------------"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js is not installed (or not on PATH)."
  echo "Install Node.js LTS from https://nodejs.org/ and re-run."
  echo
  exit 1
fi

echo "[1/3] Installing dependencies..."
npm install

echo
echo "[2/3] Running setup (models + WASM)..."
npm run setup

echo
echo "[3/3] Starting dev server..."
echo "Open http://localhost:3000 in your browser."
echo "(Keep this terminal open while using the app.)"
echo
npm run dev
