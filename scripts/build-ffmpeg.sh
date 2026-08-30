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
  --enable-nvenc
  --enable-vaapi
  --enable-static
  --disable-shared
  --disable-ffplay
  --enable-ffmpeg
  --enable-ffprobe
)

NV_CODEC_HEADERS_TAG="${NV_CODEC_HEADERS_TAG:-n12.1.14.0}"
NV_CODEC_HEADERS_DIR="${CACHE_ROOT}/nv-codec-headers"
NV_CODEC_HEADERS_PREFIX="${CACHE_ROOT}/nv-codec-headers-prefix"

ensure_nv_codec_headers() {
  local pc_file="${NV_CODEC_HEADERS_PREFIX}/lib/pkgconfig/ffnvcodec.pc"
  local header_file="${NV_CODEC_HEADERS_PREFIX}/include/ffnvcodec/nvEncodeAPI.h"
  if [[ -f "${pc_file}" && -f "${header_file}" ]]; then
    local pc_prefix=""
    pc_prefix="$(grep '^prefix=' "${pc_file}" | cut -d= -f2- || true)"
    if [[ "${pc_prefix}" == "${NV_CODEC_HEADERS_PREFIX}" ]]; then
      return 0
    fi
    echo "Reinstalling nv-codec-headers (pkg-config prefix mismatch)" >&2
  fi

  if [[ ! -d "${NV_CODEC_HEADERS_DIR}/.git" ]]; then
    echo "Cloning nv-codec-headers…"
    rm -rf "${NV_CODEC_HEADERS_DIR}"
    git clone --depth 1 --branch "${NV_CODEC_HEADERS_TAG}" \
      https://github.com/FFmpeg/nv-codec-headers.git "${NV_CODEC_HEADERS_DIR}"
  else
    git -C "${NV_CODEC_HEADERS_DIR}" fetch --tags --force origin "${NV_CODEC_HEADERS_TAG}" 2>/dev/null \
      || git -C "${NV_CODEC_HEADERS_DIR}" fetch --tags --force origin \
        "refs/tags/${NV_CODEC_HEADERS_TAG}:refs/tags/${NV_CODEC_HEADERS_TAG}"
    git -C "${NV_CODEC_HEADERS_DIR}" checkout -f "tags/${NV_CODEC_HEADERS_TAG}" 2>/dev/null \
      || git -C "${NV_CODEC_HEADERS_DIR}" checkout -f "${NV_CODEC_HEADERS_TAG}"
  fi
  rm -rf "${NV_CODEC_HEADERS_PREFIX}"
  make -C "${NV_CODEC_HEADERS_DIR}" clean >/dev/null 2>&1 || true
  make -C "${NV_CODEC_HEADERS_DIR}" install PREFIX="${NV_CODEC_HEADERS_PREFIX}"

  if [[ ! -f "${pc_file}" ]]; then
    echo "error: nv-codec-headers install did not produce ${pc_file}" >&2
    exit 1
  fi
}

verify_ffnvcodec_pkg_config() {
  export PKG_CONFIG_PATH="${NV_CODEC_HEADERS_PREFIX}/lib/pkgconfig${PKG_CONFIG_PATH:+:${PKG_CONFIG_PATH}}"
  if ! pkg-config --exists "ffnvcodec >= 12.1.14.0"; then
    echo "error: pkg-config cannot find ffnvcodec (PKG_CONFIG_PATH=${PKG_CONFIG_PATH})" >&2
    pkg-config --print-errors --exists "ffnvcodec >= 12.1.14.0" 2>&1 || true
    exit 1
  fi
}

assert_hardware_encoders() {
  local ffmpeg_bin="$1"
  local encoders
  encoders="$("${ffmpeg_bin}" -hide_banner -encoders 2>&1)" || {
    echo "error: failed to list encoders from ${ffmpeg_bin}" >&2
    exit 1
  }
  if ! grep -q 'h264_nvenc' <<<"${encoders}"; then
    echo "error: bundled FFmpeg missing h264_nvenc encoder" >&2
    exit 1
  fi
  if ! grep -q 'h264_vaapi' <<<"${encoders}"; then
    echo "error: bundled FFmpeg missing h264_vaapi encoder" >&2
    exit 1
  fi
  echo "Hardware encoders verified: h264_nvenc, h264_vaapi"
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
    assert_hardware_encoders "${KEY_DIR}/ffmpeg"
    copy_to_staging "${KEY_DIR}/ffmpeg" "${KEY_DIR}/ffprobe"
    exit 0
  fi
fi

echo "FFmpeg cache miss — building ${FFMPEG_TAG} (${ARCH}, ${FINGERPRINT})"

"${ROOT}/scripts/check-build-deps.sh" --ffmpeg

ensure_ffmpeg_remote() {
  # Broken/empty .git/config (no remotes) is common after interrupted clones or cache copies.
  if ! git -C "${SRC_DIR}" remote get-url origin >/dev/null 2>&1; then
    git -C "${SRC_DIR}" remote add origin "${MIRROR_URL}" 2>/dev/null \
      || git -C "${SRC_DIR}" remote set-url origin "${MIRROR_URL}"
  fi
}

fetch_ffmpeg_tag() {
  local url="$1"
  git -C "${SRC_DIR}" remote set-url origin "${url}"
  git -C "${SRC_DIR}" fetch --tags --force origin "${FFMPEG_TAG}" 2>/dev/null \
    || git -C "${SRC_DIR}" fetch --tags --force origin "refs/tags/${FFMPEG_TAG}:refs/tags/${FFMPEG_TAG}"
}

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
  ensure_ffmpeg_remote
  if ! fetch_ffmpeg_tag "${MIRROR_URL}" && ! fetch_ffmpeg_tag "${REPO_URL}"; then
    if git -C "${SRC_DIR}" rev-parse -q --verify "refs/tags/${FFMPEG_TAG}" >/dev/null; then
      echo "warning: could not fetch ${FFMPEG_TAG}; using existing local tag" >&2
    else
      echo "error: failed to fetch FFmpeg tag ${FFMPEG_TAG} and it is not present locally" >&2
      exit 1
    fi
  fi
  git -C "${SRC_DIR}" checkout -f "tags/${FFMPEG_TAG}" 2>/dev/null \
    || git -C "${SRC_DIR}" checkout -f "${FFMPEG_TAG}"
fi

rm -rf "${PREFIX_DIR}"
mkdir -p "${PREFIX_DIR}" "${KEY_DIR}"

ensure_nv_codec_headers
verify_ffnvcodec_pkg_config
export PKG_CONFIG_PATH="${NV_CODEC_HEADERS_PREFIX}/lib/pkgconfig${PKG_CONFIG_PATH:+:${PKG_CONFIG_PATH}}"

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

assert_hardware_encoders "${KEY_DIR}/ffmpeg"

copy_to_staging "${KEY_DIR}/ffmpeg" "${KEY_DIR}/ffprobe"
echo "Cached at ${KEY_DIR}"
