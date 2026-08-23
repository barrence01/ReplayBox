#!/usr/bin/env bash
# Full ReplayBox production build: host checks, npm deps, bundled FFmpeg, Tauri app.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

echo "==> Checking host tools"
"${ROOT}/scripts/check-build-deps.sh"

echo "==> Installing npm dependencies"
npm install

echo "==> Preparing bundled FFmpeg/FFprobe (cached when possible)"
npm run prepare:ffmpeg

echo "==> Building ReplayBox (Tauri production bundle)"
# prepare:ffmpeg runs again inside tauri:build; second run is a cache hit.
npm run tauri:build

echo "==> Done"
echo "Artifacts are under src-tauri/target/release/ (and bundle output if enabled)."
