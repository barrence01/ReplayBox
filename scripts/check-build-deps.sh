#!/usr/bin/env bash
# Validate host build dependencies for ReplayBox.
# Usage: check-build-deps.sh [--ffmpeg | --appimage]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PROFILE="${CHECK_BUILD_DEPS_PROFILE:-full}"
for arg in "$@"; do
  case "${arg}" in
    --ffmpeg) PROFILE="ffmpeg" ;;
    --appimage) PROFILE="appimage" ;;
    -h|--help)
      echo "Usage: check-build-deps.sh [--ffmpeg | --appimage]"
      echo "  (default)  full Tauri production build deps"
      echo "  --ffmpeg   bundled FFmpeg build only"
      echo "  --appimage full deps + AppImage/GStreamer/fuse checks"
      exit 0
      ;;
    *)
      echo "error: unknown argument '${arg}'" >&2
      exit 2
      ;;
  esac
done

MISSING=()

record_missing() {
  MISSING+=("$1")
}

need_cmd() {
  local name="$1"
  if ! command -v "${name}" >/dev/null 2>&1; then
    record_missing "command: ${name}"
    return 1
  fi
}

need_pkgconfig() {
  local pkg="$1"
  local label="$2"
  if ! pkg-config --exists "${pkg}" 2>/dev/null; then
    record_missing "pkg-config: ${label} (${pkg})"
    return 1
  fi
}

need_appindicator() {
  if pkg-config --exists ayatana-appindicator3-0.1 2>/dev/null \
    || pkg-config --exists ayatana-appindicator3 2>/dev/null; then
    return 0
  fi
  record_missing "pkg-config: libayatana-appindicator3-dev (ayatana-appindicator3-0.1)"
  return 1
}

resolve_gstreamer_plugin_dir() {
  local dir=""
  if command -v pkg-config >/dev/null 2>&1; then
    dir="$(pkg-config --variable=pluginsdir gstreamer-1.0 2>/dev/null || true)"
    if [[ -n "${dir}" && -d "${dir}" ]]; then
      printf '%s\n' "${dir}"
      return 0
    fi
  fi
  for dir in /usr/lib/gstreamer-1.0 /usr/lib/x86_64-linux-gnu/gstreamer-1.0; do
    if [[ -d "${dir}" ]]; then
      printf '%s\n' "${dir}"
      return 0
    fi
  done
  return 1
}

GST_REQUIRED_PLUGINS=(
  libgstcoreelements.so
  libgstplayback.so
  libgsttypefindfunctions.so
  libgstlibav.so
  libgstisomp4.so
  libgstmatroska.so
  libgstaudioconvert.so
  libgstaudioresample.so
  libgstaudioparsers.so
  libgstvideoconvertscale.so
  libgstautodetect.so
  libgstvolume.so
  libgstapp.so
)

need_libfuse2() {
  if ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
    return 0
  fi
  for path in \
    /usr/lib/x86_64-linux-gnu/libfuse.so.2 \
    /usr/lib/libfuse.so.2 \
    /usr/lib64/libfuse.so.2; do
    if [[ -e "${path}" ]]; then
      return 0
    fi
  done
  record_missing "library: libfuse2 / libfuse2t64 (libfuse.so.2)"
  return 1
}

need_download_tool() {
  if command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1; then
    return 0
  fi
  record_missing "command: curl or wget"
  return 1
}

check_gstreamer_runtime() {
  local plugin_dir plugin path
  if ! plugin_dir="$(resolve_gstreamer_plugin_dir)"; then
    record_missing "GStreamer plugin directory (gstreamer-1.0 plugins)"
    return 1
  fi

  shopt -s nullglob
  local libav_plugins=("${plugin_dir}"/*libav* "${plugin_dir}"/*gstlibav*)
  shopt -u nullglob
  if [[ ${#libav_plugins[@]} -eq 0 ]]; then
    record_missing "GStreamer libav plugins under ${plugin_dir}"
  fi

  for plugin in "${GST_REQUIRED_PLUGINS[@]}"; do
    path="${plugin_dir}/${plugin}"
    if [[ ! -f "${path}" ]]; then
      record_missing "GStreamer plugin: ${plugin} (under ${plugin_dir})"
    fi
  done

  REPLAYBOX_GST_PLUGIN_DIR="${plugin_dir}"
  export REPLAYBOX_GST_PLUGIN_DIR
}

check_ffmpeg_profile() {
  need_cmd git || true
  need_cmd make || true
  need_cmd pkg-config || true
  need_cmd nasm || true
  if command -v pkg-config >/dev/null 2>&1; then
    need_pkgconfig x264 "libx264-dev / x264" || true
  fi
}

check_full_profile() {
  need_cmd node || true
  need_cmd npm || true
  need_cmd cargo || true
  need_cmd rustc || true
  need_cmd git || true
  need_cmd make || true
  need_cmd gcc || true
  need_cmd g++ || true
  need_cmd nasm || true
  need_cmd pkg-config || true

  if command -v pkg-config >/dev/null 2>&1; then
    need_pkgconfig x264 "libx264-dev / x264" || true
    need_pkgconfig gstreamer-1.0 "libgstreamer1.0-dev / gstreamer" || true
    need_pkgconfig gstreamer-plugins-base-1.0 "libgstreamer-plugins-base1.0-dev / gst-plugins-base" || true
    need_pkgconfig gtk+-3.0 "libgtk-3-dev / gtk3" || true
    need_pkgconfig webkit2gtk-4.1 "libwebkit2gtk-4.1-dev / webkit2gtk-4.1" || true
    need_appindicator || true
  fi
}

check_appimage_profile() {
  check_full_profile
  need_cmd file || true
  need_cmd sha256sum || true
  need_download_tool || true
  need_cmd rsvg-convert || true
  need_cmd gst-inspect-1.0 || true
  need_libfuse2 || true
  check_gstreamer_runtime || true
}

print_install_hints() {
  cat <<'EOF'

Install missing dependencies:

### Arch Linux

```bash
sudo pacman -S --needed \
  base-devel \
  nasm \
  pkgconf \
  x264 \
  nodejs \
  npm \
  rust \
  webkit2gtk-4.1 \
  curl \
  wget \
  file \
  openssl \
  appmenu-gtk-module \
  libappindicator-gtk3 \
  librsvg \
  xdg-utils \
  gstreamer \
  gst-plugins-base \
  gst-plugins-good \
  gst-plugins-bad \
  gst-plugins-ugly \
  gst-libav \
  fuse2
```

Rust on Arch is included in the `rust` package above.

### Ubuntu

```bash
sudo apt update && sudo apt install -y \
  pkgconf \
  build-essential \
  nasm \
  libx264-dev \
  libssl-dev \
  libgstreamer1.0-dev \
  libgstreamer-plugins-base1.0-dev \
  gstreamer1.0-plugins-base \
  gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad \
  gstreamer1.0-plugins-ugly \
  gstreamer1.0-libav \
  gstreamer1.0-tools \
  libgtk-3-dev \
  libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  librsvg2-bin \
  libfuse2 \
  wget \
  curl \
  file \
  nodejs \
  npm
```

On Ubuntu 24.04+, `libfuse2` may pull in `libfuse2t64`. linuxdeploy is itself an AppImage and needs `libfuse.so.2` (or `APPIMAGE_EXTRACT_AND_RUN=1`, which `build-appimage.sh` sets).

Rust on Ubuntu (install rustup, then reopen the shell or run `source "$HOME/.cargo/env"`):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

EOF
}

case "${PROFILE}" in
  ffmpeg) check_ffmpeg_profile ;;
  full) check_full_profile ;;
  appimage) check_appimage_profile ;;
esac

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "error: missing build dependencies:" >&2
  printf '  - %s\n' "${MISSING[@]}" >&2
  print_install_hints >&2
  exit 1
fi

if [[ "${PROFILE}" == "appimage" && -n "${REPLAYBOX_GST_PLUGIN_DIR:-}" ]]; then
  mkdir -p "${ROOT}/.cache"
  printf 'REPLAYBOX_GST_PLUGIN_DIR=%q\n' "${REPLAYBOX_GST_PLUGIN_DIR}" \
    >"${ROOT}/.cache/replaybox-build-env"
fi

exit 0
