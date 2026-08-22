#!/usr/bin/env bash
# Build ReplayBox AppImage and copy it to build/ at the repo root.
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
need_cmd file

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

GST_PLUGIN_DIR="/usr/lib/gstreamer-1.0"
if [[ ! -d "${GST_PLUGIN_DIR}" ]]; then
  echo "error: GStreamer plugin directory not found: ${GST_PLUGIN_DIR}" >&2
  echo "Install (Arch): pacman -S --needed gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad gst-plugins-ugly gst-libav" >&2
  echo "See docs/BUILD.md for details." >&2
  exit 1
fi

# Need libav (or similarly named) plugins for WebKit <video> / H.264 in the AppImage.
shopt -s nullglob
LIBAV_PLUGINS=("${GST_PLUGIN_DIR}"/*libav* "${GST_PLUGIN_DIR}"/*gstlibav*)
shopt -u nullglob
if [[ ${#LIBAV_PLUGINS[@]} -eq 0 ]]; then
  echo "error: no GStreamer libav plugins under ${GST_PLUGIN_DIR}" >&2
  echo "Install (Arch): pacman -S --needed gst-libav" >&2
  echo "See docs/BUILD.md for details." >&2
  exit 1
fi

GST_STAGE="${ROOT}/src-tauri/.appimage-gst"
echo "==> Staging GStreamer plugins for AppImage"
rm -rf "${GST_STAGE}"
mkdir -p "${GST_STAGE}"
cp -a "${GST_PLUGIN_DIR}" "${GST_STAGE}/gstreamer-1.0"

echo "==> Installing npm dependencies"
npm install

echo "==> Preparing bundled FFmpeg/FFprobe (cached when possible)"
npm run prepare:ffmpeg

echo "==> Building ReplayBox AppImage (verbose)"
# prepare:ffmpeg runs again via beforeBuildCommand; second run is a cache hit.
# NO_STRIP=true: Arch (and other rolling distros) — linuxdeploy's bundled strip
# fails on modern ELF (.relr.dyn); see https://github.com/tauri-apps/tauri/issues/14755
export NO_STRIP=true
OUT_DIR="${ROOT}/build"
mkdir -p "${OUT_DIR}"
LOG_FILE="${OUT_DIR}/appimage-build.log"
echo "    Full log: ${LOG_FILE}"
npx tauri build --bundles appimage --verbose 2>&1 | tee "${LOG_FILE}"

APPIMAGE_DIR="${ROOT}/src-tauri/target/release/bundle/appimage"
APPDIR_GST="${APPIMAGE_DIR}/ReplayBox.AppDir/usr/lib/gstreamer-1.0"
if [[ -d "${APPIMAGE_DIR}/ReplayBox.AppDir" ]]; then
  if [[ ! -d "${APPDIR_GST}" ]] || [[ -z "$(ls -A "${APPDIR_GST}" 2>/dev/null)" ]]; then
    echo "error: AppDir missing GStreamer plugins at ${APPDIR_GST}" >&2
    echo "AppImage would freeze on video playback in the editor." >&2
    echo "See ${LOG_FILE}" >&2
    exit 1
  fi
fi

shopt -s nullglob
APPIMAGES=("${APPIMAGE_DIR}"/*.AppImage)
shopt -u nullglob

if [[ ${#APPIMAGES[@]} -eq 0 ]]; then
  echo "error: no AppImage found under ${APPIMAGE_DIR}" >&2
  echo "See ${LOG_FILE}" >&2
  exit 1
fi

echo "==> Copying AppImage(s) to build/"
for src in "${APPIMAGES[@]}"; do
  dest="${OUT_DIR}/$(basename "${src}")"
  cp -f "${src}" "${dest}"
  chmod +x "${dest}"
  echo "  ${dest}"
done

echo "==> Done"
echo "    Log: ${LOG_FILE}"
