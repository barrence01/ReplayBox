#!/usr/bin/env bash
# Full ReplayBox production build: host checks, npm deps, bundled FFmpeg, Tauri app.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: missing required command '$1'" >&2
    echo "See docs/BUILD.md for dependencies." >&2
    exit 1
  fi
}

echo "==> Checking host tools"
need_cmd node
need_cmd npm
need_cmd cargo
need_cmd rustc
need_cmd git
need_cmd make
need_cmd pkg-config

# NASM is required to compile bundled FFmpeg (no --disable-x86asm fallback).
if ! command -v nasm >/dev/null 2>&1; then
  echo "error: nasm is required to build bundled FFmpeg" >&2
  echo "Install (Arch): pacman -S --needed nasm" >&2
  echo "See docs/BUILD.md for details." >&2
  exit 1
fi

if ! pkg-config --exists x264; then
  echo "error: libx264 not found (pkg-config x264)" >&2
  echo "Install (Arch): pacman -S --needed x264" >&2
  echo "See docs/BUILD.md for details." >&2
  exit 1
fi

echo "==> Installing npm dependencies"
npm install

echo "==> Preparing bundled FFmpeg/FFprobe (cached when possible)"
npm run prepare:ffmpeg

echo "==> Building ReplayBox (Tauri production bundle)"
# prepare:ffmpeg runs again inside tauri:build; second run is a cache hit.
npm run tauri:build

echo "==> Done"
echo "Artifacts are under src-tauri/target/release/ (and bundle output if enabled)."
