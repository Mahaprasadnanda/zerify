@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"

echo.
echo Face Verification - Local Runner (Windows)
echo -----------------------------------------
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js is not installed or not on PATH.
  echo Install Node.js LTS from https://nodejs.org/ and re-run this file.
  echo.
  pause
  exit /b 1
)

echo [1/3] Installing dependencies...
call npm install
if errorlevel 1 (
  echo.
  echo ERROR: npm install failed.
  pause
  exit /b 1
)

echo.
echo [2/3] Running setup (models + WASM)...
call npm run setup
if errorlevel 1 (
  echo.
  echo ERROR: npm run setup failed.
  pause
  exit /b 1
)

echo.
echo [3/3] Starting dev server...
echo Open http://localhost:3000 in your browser.
echo (Keep this window open while using the app.)
echo.
call npm run dev

endlocal
