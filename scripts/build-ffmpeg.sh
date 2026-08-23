#!/usr/bin/env bash
# Build FFmpeg/FFprobe from the official Git tag and stage them for Tauri resources.
# Uses a content-addressed cache so unchanged tag+config skips recompilation.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FFMPEG_TAG="${FFMPEG_TAG:-n7.1}"
REPO_URL="${FFMPEG_REPO_URL:-https://git.ffmpeg.org/ffmpeg.git}"
# GitHub mirror is faster/more reliable for shallow clones when the official host is slow.
MIRROR_URL="${FFMPEG_MIRROR_URL:-https://github.com/FFmpeg/FFmpeg.git}"

ARCH="$(uname -m)"
# Fingerprint invalidates cache when this script's configure block changes.
FINGERPRINT="$(
  {
    echo "tag=${FFMPEG_TAG}"
    echo "arch=${ARCH}"
    # Hash the configure flags section of this file.
    sed -n '/^CONFIGURE_FLAGS=(/,/^)/p' "${BASH_SOURCE[0]}"
  } | sha256sum | cut -c1-12
)"

CACHE_ROOT="${ROOT}/.cache/ffmpeg"
SRC_DIR="${CACHE_ROOT}/src"
KEY_DIR="${CACHE_ROOT}/${FFMPEG_TAG}-${ARCH}-${FINGERPRINT}"
PREFIX_DIR="${KEY_DIR}/prefix"
STAGING_DIR="${ROOT}/src-tauri/resources/ffmpeg"

CONFIGURE_FLAGS=(
  --prefix="${PREFIX_DIR}"
  --disable-debug
  --disable-doc
  --enable-gpl
  --enable-libx264
  --enable-static
  --disable-shared
  --disable-ffplay
  --enable-ffmpeg
  --enable-ffprobe
)

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: missing required command '$1'" >&2
    echo "Install build deps (Arch): pacman -S --needed base-devel nasm pkgconf x264" >&2
    exit 1
  fi
}

mkdir -p "${CACHE_ROOT}" "${STAGING_DIR}"

copy_to_staging() {
  local src_ffmpeg="$1"
  local src_ffprobe="$2"
  install -m 755 "${src_ffmpeg}" "${STAGING_DIR}/ffmpeg"
  install -m 755 "${src_ffprobe}" "${STAGING_DIR}/ffprobe"
  echo "Staged bundled tools:"
  echo "  ${STAGING_DIR}/ffmpeg"
  echo "  ${STAGING_DIR}/ffprobe"
  # Capture full -version (no pipe to head): under pipefail, early pipe close → SIGPIPE 141.
  local ver
  ver="$("${STAGING_DIR}/ffmpeg" -version 2>&1)" || true
  printf '%s\n' "${ver%%$'\n'*}"
}

# Cache hit: binaries already built for this tag/arch/fingerprint.
if [[ -x "${KEY_DIR}/ffmpeg" && -x "${KEY_DIR}/ffprobe" ]]; then
  if "${KEY_DIR}/ffmpeg" -version >/dev/null 2>&1 \
    && "${KEY_DIR}/ffprobe" -version >/dev/null 2>&1; then
    echo "FFmpeg cache hit (${FFMPEG_TAG}-${ARCH}-${FINGERPRINT})"
    copy_to_staging "${KEY_DIR}/ffmpeg" "${KEY_DIR}/ffprobe"
    exit 0
  fi
fi

echo "FFmpeg cache miss — building ${FFMPEG_TAG} (${ARCH}, ${FINGERPRINT})"

need_cmd git
need_cmd make
need_cmd pkg-config

# NASM is required for FFmpeg x86 assembly; fail hard (no --disable-x86asm fallback).
if ! command -v nasm >/dev/null 2>&1; then
  echo "error: nasm is required to build bundled FFmpeg" >&2
  echo "Install (Arch): pacman -S --needed nasm" >&2
  exit 1
fi

if ! pkg-config --exists x264; then
  echo "error: libx264 not found (pkg-config x264)" >&2
  echo "Install (Arch): pacman -S --needed x264" >&2
  exit 1
fi

# Reuse a single source checkout; fetch tags as needed.
if [[ ! -d "${SRC_DIR}/.git" ]]; then
  echo "Cloning FFmpeg…"
  if ! git clone --filter=blob:none --branch "${FFMPEG_TAG}" --single-branch \
    "${MIRROR_URL}" "${SRC_DIR}"; then
    rm -rf "${SRC_DIR}"
    git clone --filter=blob:none --branch "${FFMPEG_TAG}" --single-branch \
      "${REPO_URL}" "${SRC_DIR}"
  fi
else
  echo "Updating FFmpeg source…"
  git -C "${SRC_DIR}" fetch --tags --force origin "${FFMPEG_TAG}" 2>/dev/null \
    || git -C "${SRC_DIR}" fetch --tags --force origin "refs/tags/${FFMPEG_TAG}:refs/tags/${FFMPEG_TAG}"
  git -C "${SRC_DIR}" checkout -f "tags/${FFMPEG_TAG}" 2>/dev/null \
    || git -C "${SRC_DIR}" checkout -f "${FFMPEG_TAG}"
fi

rm -rf "${PREFIX_DIR}"
mkdir -p "${PREFIX_DIR}" "${KEY_DIR}"

pushd "${SRC_DIR}" >/dev/null
# Clean previous configure artifacts when switching tags.
make distclean >/dev/null 2>&1 || true

echo "Configuring…"
./configure "${CONFIGURE_FLAGS[@]}"

echo "Compiling (this can take several minutes on first run)…"
make -j"$(nproc)"
make install
popd >/dev/null

if [[ ! -x "${PREFIX_DIR}/bin/ffmpeg" || ! -x "${PREFIX_DIR}/bin/ffprobe" ]]; then
  echo "error: build finished but binaries missing under ${PREFIX_DIR}/bin" >&2
  exit 1
fi

cp -f "${PREFIX_DIR}/bin/ffmpeg" "${KEY_DIR}/ffmpeg"
cp -f "${PREFIX_DIR}/bin/ffprobe" "${KEY_DIR}/ffprobe"
chmod +x "${KEY_DIR}/ffmpeg" "${KEY_DIR}/ffprobe"

copy_to_staging "${KEY_DIR}/ffmpeg" "${KEY_DIR}/ffprobe"
echo "Cached at ${KEY_DIR}"
