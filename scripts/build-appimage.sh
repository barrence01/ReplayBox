#!/usr/bin/env bash
# Build ReplayBox AppImage and copy it to build/ at the repo root.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

VERBOSE="${VERBOSE:-0}"
# Cached AppImage tooling binaries (gitignored via .cache/).
CACHE_ROOT="${ROOT}/.cache/appimage"
RUNTIME_CACHE="${CACHE_ROOT}/runtime-x86_64"
APPIMAGETOOL_CACHE="${CACHE_ROOT}/appimagetool"
RUNTIME_URL="https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-x86_64"
# mksquashfs/appimagetool use $TMPDIR heavily. A full /tmp (tmpfs) silently
# packs empty stubs for usr/share icons/desktop — appimage-manager then shows
# Name=<AppImage filename> and a blank icon. Keep scratch on the build disk.
TMPDIR_APPIMAGE="${CACHE_ROOT}/tmp"
mkdir -p "${TMPDIR_APPIMAGE}"
export TMPDIR="${TMPDIR_APPIMAGE}"
export TEMP="${TMPDIR_APPIMAGE}"
export TMP="${TMPDIR_APPIMAGE}"

# Phase timing (wall-clock seconds from script start).
SECONDS=0
T0=0
T_gst=""
T_npm=""
T_tauri=""
T_icons=""
T_repack=""
mark() {
  # Usage: mark VAR_NAME
  printf -v "$1" '%s' "${SECONDS}"
}
elapsed_between() {
  local start="$1" end="$2"
  echo $((end - start))
}

echo "==> Checking host tools"
"${ROOT}/scripts/check-build-deps.sh" --appimage
if [[ -f "${ROOT}/.cache/replaybox-build-env" ]]; then
  # shellcheck disable=SC1091
  source "${ROOT}/.cache/replaybox-build-env"
fi
GST_PLUGIN_DIR="${REPLAYBOX_GST_PLUGIN_DIR:-}"
if [[ -z "${GST_PLUGIN_DIR}" ]] && command -v pkg-config >/dev/null 2>&1; then
  GST_PLUGIN_DIR="$(pkg-config --variable=pluginsdir gstreamer-1.0 2>/dev/null || true)"
fi
if [[ -z "${GST_PLUGIN_DIR}" || ! -d "${GST_PLUGIN_DIR}" ]]; then
  for candidate in /usr/lib/gstreamer-1.0 /usr/lib/x86_64-linux-gnu/gstreamer-1.0; do
    if [[ -d "${candidate}" ]]; then
      GST_PLUGIN_DIR="${candidate}"
      break
    fi
  done
fi
if [[ ! -d "${GST_PLUGIN_DIR}" ]]; then
  echo "error: GStreamer plugin directory not found" >&2
  exit 1
fi

# Curated plugins for WebKit editor playback (local MP4/H.264, WebM, basic sinks).
# Required entries must exist; optional ones are copied when present on the host.
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
GST_OPTIONAL_PLUGINS=(
  libgstsoup.so
  libgstgdkpixbuf.so
  libgstpng.so
  libgstjpeg.so
  libgstjpegformat.so
  libgstid3demux.so
  libgsttaglib.so
  libgstvideoparsersbad.so
  libgstvideorate.so
  libgstvideofilter.so
  libgstopengl.so
  libgstximagesink.so
  libgstwaylandsink.so
  libgstpulseaudio.so
  libgstalsa.so
  libgstmultifile.so
)

GST_STAGE="${ROOT}/src-tauri/.appimage-gst"
GST_STAGE_PLUGINS="${GST_STAGE}/gstreamer-1.0"
GST_FINGERPRINT_FILE="${GST_STAGE}/.fingerprint"

gst_fingerprint() {
  local plugin
  {
    echo "dir=${GST_PLUGIN_DIR}"
    for plugin in "${GST_REQUIRED_PLUGINS[@]}" "${GST_OPTIONAL_PLUGINS[@]}"; do
      local path="${GST_PLUGIN_DIR}/${plugin}"
      if [[ -e "${path}" ]]; then
        # device:inode:size:mtime — cheap and stable for skip-vs-recopy.
        stat -c '%d:%i:%s:%Y %n' "${path}"
      else
        echo "missing ${plugin}"
      fi
    done
  } | sha256sum | awk '{print $1}'
}

stage_gstreamer_plugins() {
  echo "==> Staging GStreamer plugins for AppImage (curated)"
  local fp
  fp="$(gst_fingerprint)"

  if [[ -f "${GST_FINGERPRINT_FILE}" ]] \
    && [[ -d "${GST_STAGE_PLUGINS}" ]] \
    && [[ "$(cat "${GST_FINGERPRINT_FILE}")" == "${fp}" ]]; then
    local count
    count="$(find "${GST_STAGE_PLUGINS}" -maxdepth 1 -type f | wc -l)"
    echo "    Cache hit (${count} plugins, fingerprint ${fp:0:12}…)"
    return 0
  fi

  local plugin path missing=()
  for plugin in "${GST_REQUIRED_PLUGINS[@]}"; do
    path="${GST_PLUGIN_DIR}/${plugin}"
    if [[ ! -f "${path}" ]]; then
      missing+=("${plugin}")
    fi
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "error: required GStreamer plugins missing under ${GST_PLUGIN_DIR}:" >&2
    printf '  %s\n' "${missing[@]}" >&2
    echo "Install (Arch): pacman -S --needed gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad gst-libav" >&2
    exit 1
  fi

  rm -rf "${GST_STAGE}"
  mkdir -p "${GST_STAGE_PLUGINS}"

  local copied=0
  for plugin in "${GST_REQUIRED_PLUGINS[@]}" "${GST_OPTIONAL_PLUGINS[@]}"; do
    path="${GST_PLUGIN_DIR}/${plugin}"
    if [[ -f "${path}" ]]; then
      cp -a "${path}" "${GST_STAGE_PLUGINS}/"
      copied=$((copied + 1))
    fi
  done

  printf '%s\n' "${fp}" >"${GST_FINGERPRINT_FILE}"
  echo "    Staged ${copied} plugins (fingerprint ${fp:0:12}…)"
}

# Infer current bundling phase from running child processes.
infer_bundle_phase() {
  if pgrep -f 'mksquashfs' >/dev/null 2>&1; then
    echo "mksquashfs"
  elif pgrep -f 'linuxdeploy-plugin-gstreamer|patchelf' >/dev/null 2>&1; then
    echo "gstreamer"
  elif pgrep -f 'linuxdeploy' >/dev/null 2>&1; then
    echo "linuxdeploy"
  elif pgrep -f 'cargo.*(build|rustc)|rustc ' >/dev/null 2>&1; then
    echo "cargo"
  else
    echo "tauri"
  fi
}

appdir_progress_line() {
  local target_dir="${CARGO_TARGET_DIR:-${ROOT}/src-tauri/target}"
  local appdir="${target_dir}/release/bundle/appimage/ReplayBox.AppDir"
  local gst_dir="${appdir}/usr/lib/gstreamer-1.0"
  local size="—"
  local plugins="—"
  if [[ -d "${appdir}" ]]; then
    size="$(du -sh "${appdir}" 2>/dev/null | awk '{print $1}')"
  fi
  if [[ -d "${gst_dir}" ]]; then
    plugins="$(find "${gst_dir}" -maxdepth 1 -type f 2>/dev/null | wc -l | tr -d ' ')"
  fi
  printf 'AppDir=%s gst_plugins=%s' "${size}" "${plugins}"
}

mark T0
stage_gstreamer_plugins
mark T_gst

echo "==> Installing npm dependencies"
if [[ ! -d "${ROOT}/node_modules" ]] \
  || [[ "${ROOT}/package-lock.json" -nt "${ROOT}/node_modules" ]]; then
  npm install
else
  echo "    Skipping npm install (node_modules up to date)"
fi
mark T_npm

echo "==> Building ReplayBox AppImage"
# prepare:ffmpeg runs via beforeBuildCommand in tauri.conf.json (cached when possible).
# NO_STRIP=true: Arch (and other rolling distros) — linuxdeploy's bundled strip
# fails on modern ELF (.relr.dyn); see https://github.com/tauri-apps/tauri/issues/14755
export NO_STRIP=true
export APPIMAGE_EXTRACT_AND_RUN=1
# Point linuxdeploy's gstreamer plugin at the curated stage (not all of /usr/lib/gstreamer-1.0).
export GSTREAMER_PLUGINS_DIR="${GST_STAGE_PLUGINS}"
if [[ -z "${GSTREAMER_HELPERS_DIR:-}" ]]; then
  for candidate in \
    /usr/lib/x86_64-linux-gnu/gstreamer1.0/gstreamer-1.0 \
    /usr/lib64/gstreamer-1.0 \
    /usr/lib/gstreamer1.0/gstreamer-1.0; do
    if [[ -d "${candidate}" ]]; then
      export GSTREAMER_HELPERS_DIR="${candidate}"
      break
    fi
  done
fi
OUT_DIR="${ROOT}/build"
mkdir -p "${OUT_DIR}"
LOG_FILE="${OUT_DIR}/appimage-build.log"
echo "    Full log: ${LOG_FILE}"
echo "    GSTREAMER_PLUGINS_DIR=${GSTREAMER_PLUGINS_DIR}"
if [[ -n "${GSTREAMER_HELPERS_DIR:-}" ]]; then
  echo "    GSTREAMER_HELPERS_DIR=${GSTREAMER_HELPERS_DIR}"
fi
echo "    Bundling can take several minutes on HDD (linuxdeploy + squashfs)."
echo "    Follow live: tail -f ${LOG_FILE}"

# Always pass --verbose: without it Tauri captures linuxdeploy stderr and
# replaces it with a generic `failed to run linuxdeploy` on failure.
TAURI_ARGS=(build --bundles appimage --verbose)

run_tauri() {
  # Do not wrap with stdbuf: it can turn child pipelines (e.g. ffmpeg|head in
  # prepare:ffmpeg) into SIGPIPE/exit 141 under pipefail when stdout is a file.
  npx tauri "${TAURI_ARGS[@]}"
}

dump_host_diag() {
  local pretty="unknown" fuse="missing" userns="" tauri_cache="${HOME}/.cache/tauri"
  if [[ -f /etc/os-release ]]; then
    # shellcheck disable=SC1091
    pretty="$(. /etc/os-release; echo "${PRETTY_NAME:-unknown}")"
  fi
  echo "    OS: ${pretty}"
  echo "    NO_STRIP=${NO_STRIP-<unset>} APPIMAGE_EXTRACT_AND_RUN=${APPIMAGE_EXTRACT_AND_RUN-<unset>}"
  echo "    GSTREAMER_PLUGINS_DIR=${GSTREAMER_PLUGINS_DIR-<unset>}"
  echo "    GSTREAMER_HELPERS_DIR=${GSTREAMER_HELPERS_DIR-<unset>}"
  echo "    TMPDIR=${TMPDIR-<unset>}"
  if ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
    fuse="yes"
  else
    for path in \
      /usr/lib/x86_64-linux-gnu/libfuse.so.2 \
      /usr/lib/libfuse.so.2 \
      /usr/lib64/libfuse.so.2; do
      if [[ -e "${path}" ]]; then
        fuse="${path}"
        break
      fi
    done
  fi
  echo "    libfuse.so.2: ${fuse}"
  for tool in file patchelf rsvg-convert gst-inspect-1.0 curl wget fusermount fusermount3; do
    if command -v "${tool}" >/dev/null 2>&1; then
      echo "    ${tool}: $(command -v "${tool}")"
    else
      echo "    ${tool}: missing"
    fi
  done
  userns="/proc/sys/kernel/apparmor_restrict_unprivileged_userns"
  if [[ -r "${userns}" ]]; then
    echo "    apparmor_restrict_unprivileged_userns=$(cat "${userns}" 2>/dev/null || echo '?')"
  fi
  echo "    Tauri linuxdeploy cache: ${tauri_cache}"
  if compgen -G "${tauri_cache}/linuxdeploy*" >/dev/null 2>&1; then
    ls -lh "${tauri_cache}"/linuxdeploy* 2>/dev/null | sed 's/^/      /'
  else
    echo "      (no linuxdeploy files)"
  fi
}

dump_tauri_failure() {
  local status="$1"
  local log="$2"
  local matches=""
  echo "error: tauri build failed (exit ${status})" >&2
  echo "    Log: ${log}" >&2
  echo "==> Host diagnostics" >&2
  dump_host_diag >&2
  if [[ -f "${log}" ]]; then
    echo "==> linuxdeploy / bundler matches in log" >&2
    matches="$(
      grep -nEi 'linuxdeploy|fuse|strip|relr|patchelf|gstreamer|rsvg|ERROR|Error |failed|AppImage|dlopen|cannot|not found' "${log}" 2>/dev/null \
        | tail -n 80 || true
    )"
    if [[ -n "${matches}" ]]; then
      printf '%s\n' "${matches}" >&2
    else
      echo "    (no matching lines)" >&2
    fi
    echo "==> Last 20 log lines" >&2
    tail -n 20 "${log}" >&2 || true
  else
    echo "    (log file missing)" >&2
  fi
}

# Always keep a full (verbose) log. Default mode shows milestones + AppDir/process
# heartbeat so buffered linuxdeploy output does not look like a hang.
echo "    Tauri --verbose is always on so linuxdeploy stderr is captured in the log."
if [[ "${VERBOSE}" == "1" ]]; then
  echo "    VERBOSE=1: mirroring the full log to the terminal."
fi
echo "    Progress below…"
set +e
if [[ "${VERBOSE}" == "1" ]]; then
  run_tauri 2>&1 | tee "${LOG_FILE}"
  TAURI_STATUS=${PIPESTATUS[0]}
else
  run_tauri >"${LOG_FILE}" 2>&1 &
  TAURI_PID=$!
  LAST_HB=0
  LAST_INTERESTING=""
  while kill -0 "${TAURI_PID}" 2>/dev/null; do
    sleep 5
    interesting=""
    if [[ -f "${LOG_FILE}" ]]; then
      interesting="$(
        grep -E 'Running beforeBuildCommand|Compiling |Finished |Built application|Bundling |Deploying dependencies|Copying plugins|Running output plugin|Generating squashfs|Success|Error |error:|FAILED|Failed |linuxdeploy|ERROR|strip |fuse' "${LOG_FILE}" \
          | tail -n 1 || true
      )"
    fi
    now="${SECONDS}"
    if [[ -n "${interesting}" && "${interesting}" != "${LAST_INTERESTING}" ]]; then
      printf '    %s\n' "${interesting}"
      LAST_INTERESTING="${interesting}"
      LAST_HB="${now}"
    elif (( now - LAST_HB >= 10 )); then
      phase="$(infer_bundle_phase)"
      prog="$(appdir_progress_line)"
      printf '    … %s (%ss elapsed, %s)\n' "${phase}" "${now}" "${prog}"
      LAST_HB="${now}"
    fi
  done
  wait "${TAURI_PID}"
  TAURI_STATUS=$?
fi
set -e
if [[ "${TAURI_STATUS}" -ne 0 ]]; then
  dump_tauri_failure "${TAURI_STATUS}" "${LOG_FILE}"
  exit "${TAURI_STATUS}"
fi
grep -E 'Finished|Bundling|bundle at|Success' "${LOG_FILE}" | tail -n 8 | sed 's/^/    /' || true
mark T_tauri

# Honor CARGO_TARGET_DIR (e.g. Cursor sandbox cache) so we copy the AppImage
# that this build actually produced, not a stale one under src-tauri/target.
TARGET_DIR="${CARGO_TARGET_DIR:-${ROOT}/src-tauri/target}"
APPIMAGE_DIR="${TARGET_DIR}/release/bundle/appimage"
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

# --- FreeDesktop / AppImage icon normalization ---------------------------------
# Canonical AppDir layout (AppImage spec + Waywallen-style):
#   Icon=org.replaybox.replaybox (matches desktop basename / hicolor name)
#   root .desktop + .svg are symlinks into usr/share/…
#   .DirIcon → root SVG (scalable) — AppImageManager installs SVG reliably
# Tauri may emit hicolor/256x256@2 and product-name desktop/icon leftovers.

APPIMAGE_DESKTOP_ID="org.replaybox.replaybox"

ensure_cached_runtime() {
  mkdir -p "${CACHE_ROOT}"
  if [[ -f "${RUNTIME_CACHE}" && -s "${RUNTIME_CACHE}" ]]; then
    echo "    Using cached type2 runtime (${RUNTIME_CACHE})"
    return 0
  fi
  echo "    Downloading AppImage type2 runtime → ${RUNTIME_CACHE}"
  local tmp
  tmp="$(mktemp "${RUNTIME_CACHE}.XXXXXX")"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "${tmp}" "${RUNTIME_URL}"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "${tmp}" "${RUNTIME_URL}"
  else
    echo "error: curl or wget is required to download the AppImage runtime" >&2
    rm -f "${tmp}"
    exit 1
  fi
  mv -f "${tmp}" "${RUNTIME_CACHE}"
}

find_appimagetool() {
  if command -v appimagetool >/dev/null 2>&1; then
    command -v appimagetool
    return 0
  fi
  local plugin="${HOME}/.cache/tauri/linuxdeploy-plugin-appimage.AppImage"
  if [[ -x "${plugin}" ]]; then
    local extracted=""
    local candidate
    for candidate in \
      "${APPIMAGETOOL_CACHE}/squashfs-root/usr/bin/appimagetool" \
      "${APPIMAGETOOL_CACHE}/squashfs-root/appimagetool-prefix/usr/bin/appimagetool"; do
      if [[ -x "${candidate}" ]]; then
        extracted="${candidate}"
        break
      fi
    done
    if [[ -z "${extracted}" ]]; then
      # Status must go to stderr — stdout is captured by $(find_appimagetool).
      echo "    Extracting appimagetool → ${APPIMAGETOOL_CACHE}" >&2
      rm -rf "${APPIMAGETOOL_CACHE}"
      mkdir -p "${APPIMAGETOOL_CACHE}"
      (
        cd "${APPIMAGETOOL_CACHE}"
        "${plugin}" --appimage-extract >/dev/null
      )
      for candidate in \
        "${APPIMAGETOOL_CACHE}/squashfs-root/usr/bin/appimagetool" \
        "${APPIMAGETOOL_CACHE}/squashfs-root/appimagetool-prefix/usr/bin/appimagetool"; do
        if [[ -x "${candidate}" ]]; then
          extracted="${candidate}"
          break
        fi
      done
    fi
    if [[ -n "${extracted}" && -x "${extracted}" ]]; then
      echo "${extracted}"
      return 0
    fi
  fi
  return 1
}

# Drop mksquashfs/extract scratch only — keep runtime + appimagetool tooling caches.
clean_appimage_tmpdir() {
  echo "==> Cleaning AppImage scratch TMPDIR (${TMPDIR_APPIMAGE})"
  mkdir -p "${TMPDIR_APPIMAGE}"
  # Avoid deleting the directory itself (TMPDIR must stay valid for this process).
  find "${TMPDIR_APPIMAGE}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
}

normalize_appdir_icons() {
  local appdir="$1"
  local icons_src="${ROOT}/src-tauri/icons"
  local hicolor="${appdir}/usr/share/icons/hicolor"
  local id="${APPIMAGE_DESKTOP_ID}"
  local apps_dir="${appdir}/usr/share/applications"

  echo "==> Normalizing FreeDesktop icons in AppDir (id=${id})"

  # Drop Tauri/legacy leftovers that confuse integrators (wrong basename vs Icon=).
  rm -rf "${hicolor}/256x256@2"
  rm -f \
    "${appdir}/ReplayBox.desktop" \
    "${appdir}/replaybox.desktop" \
    "${appdir}/ReplayBox.png" \
    "${appdir}/replaybox.png" \
    "${appdir}/ReplayBox.svg" \
    "${appdir}/replaybox.svg" \
    "${appdir}/${id}.desktop" \
    "${appdir}/${id}.png" \
    "${appdir}/${id}.svg" \
    "${appdir}/.DirIcon" \
    "${apps_dir}/ReplayBox.desktop" \
    "${apps_dir}/replaybox.desktop" \
    "${apps_dir}/${id}.desktop"
  if [[ -d "${hicolor}" ]]; then
    find "${hicolor}" -type f \( \
      -name 'ReplayBox.*' -o -name 'replaybox.*' -o -name "${id}.*" \
    \) -delete 2>/dev/null || true
  fi

  install_icon() {
    local size="$1"
    local src="$2"
    local dest_dir="${hicolor}/${size}/apps"
    mkdir -p "${dest_dir}"
    cp -f "${src}" "${dest_dir}/${id}.png"
  }

  install_icon "32x32" "${icons_src}/32x32.png"
  install_icon "64x64" "${icons_src}/64x64.png"
  install_icon "128x128" "${icons_src}/128x128.png"
  install_icon "256x256" "${icons_src}/256x256.png"
  install_icon "512x512" "${icons_src}/icon.png"

  mkdir -p "${hicolor}/scalable/apps"
  cp -f "${ROOT}/replaybox-icon.svg" "${hicolor}/scalable/apps/${id}.svg"

  # Single canonical .desktop under usr/share/applications; root is a symlink.
  # Tauri/linuxdeploy may leave empty stubs — rewrite so Name=/Icon= never fall back
  # to the AppImage filename.
  local desktop_body
  desktop_body="$(cat <<EOF
[Desktop Entry]
Type=Application
Name=ReplayBox
Comment=Game recording catalog and VFR-safe clip editor
Exec=replaybox
Icon=${id}
Terminal=false
Categories=Utility;
StartupNotify=true
StartupWMClass=replaybox
EOF
)"
  mkdir -p "${apps_dir}"
  printf '%s\n' "${desktop_body}" >"${apps_dir}/${id}.desktop"

  ln -sfn "usr/share/applications/${id}.desktop" "${appdir}/${id}.desktop"
  # Waywallen-style: root icon + .DirIcon are SVG (AppImageManager installs scalable reliably).
  ln -sfn "usr/share/icons/hicolor/scalable/apps/${id}.svg" "${appdir}/${id}.svg"
  ln -sfn "${id}.svg" "${appdir}/.DirIcon"
}

stage_license_files() {
  local appdir="$1"
  local dest="${appdir}/usr/share/licenses/replaybox"
  echo "==> Staging license files in AppDir"
  mkdir -p "${dest}"
  cp -f "${ROOT}/LICENSE" "${dest}/LICENSE"
  cp -f "${ROOT}/THIRD_PARTY.md" "${dest}/THIRD_PARTY.md"
  cp -f "${ROOT}/licenses/GPL-2.0.txt" "${dest}/GPL-2.0.txt"
  cp -f "${ROOT}/licenses/LGPL-2.1.txt" "${dest}/LGPL-2.1.txt"
}

# Tauri preserves bundle.resources paths under $RESOURCE (e.g. resources/ffmpeg/ffmpeg).
# tools.rs resolves $RESOURCE/ffmpeg/{ffmpeg,ffprobe}. Copy into that layout before re-pack.
resolve_appdir_resource_dir() {
  local appdir="$1"
  local preferred="${appdir}/usr/lib/replaybox"
  local found=""
  if [[ -d "${preferred}" ]]; then
    printf '%s\n' "${preferred}"
    return 0
  fi
  found="$(find "${appdir}" -path '*/resources/ffmpeg/ffmpeg' -type f 2>/dev/null | head -n 1 || true)"
  if [[ -n "${found}" ]]; then
    # …/resources/ffmpeg/ffmpeg → resource dir is two levels up from ffmpeg/
    printf '%s\n' "$(cd "$(dirname "${found}")/../.." && pwd)"
    return 0
  fi
  return 1
}

normalize_bundled_ffmpeg() {
  local appdir="$1"
  local resource src_dir dest_dir name src dest
  echo "==> Normalizing bundled FFmpeg paths in AppDir"

  if ! resource="$(resolve_appdir_resource_dir "${appdir}")"; then
    echo "error: could not locate Tauri resource dir under ${appdir}" >&2
    echo "Expected usr/lib/replaybox or …/resources/ffmpeg/ffmpeg" >&2
    exit 1
  fi

  src_dir="${resource}/resources/ffmpeg"
  if [[ ! -f "${src_dir}/ffmpeg" || ! -f "${src_dir}/ffprobe" ]]; then
    src_dir="${ROOT}/src-tauri/resources/ffmpeg"
  fi
  if [[ ! -f "${src_dir}/ffmpeg" || ! -f "${src_dir}/ffprobe" ]]; then
    echo "error: bundled ffmpeg/ffprobe not found under ${resource}/resources/ffmpeg" >&2
    echo "or staging ${ROOT}/src-tauri/resources/ffmpeg — run npm run prepare:ffmpeg" >&2
    exit 1
  fi

  dest_dir="${resource}/ffmpeg"
  mkdir -p "${dest_dir}"
  for name in ffmpeg ffprobe; do
    src="${src_dir}/${name}"
    dest="${dest_dir}/${name}"
    if [[ "${src}" -ef "${dest}" ]]; then
      continue
    fi
    install -m 755 "${src}" "${dest}"
  done
  echo "    Staged bundled FFmpeg into ${dest_dir}/"
}

assert_bundled_ffmpeg() {
  local base="$1"
  local resource="${base}/usr/lib/replaybox"
  local dest_dir="${resource}/ffmpeg"
  local name bin

  echo "==> Asserting bundled FFmpeg at ${dest_dir}"
  if [[ ! -d "${resource}" ]]; then
    echo "error: resource dir missing: ${resource}" >&2
    exit 1
  fi
  for name in ffmpeg ffprobe; do
    bin="${dest_dir}/${name}"
    if [[ ! -s "${bin}" ]]; then
      echo "error: bundled ${name} missing or empty: ${bin}" >&2
      exit 1
    fi
    if [[ ! -x "${bin}" ]]; then
      echo "error: bundled ${name} is not executable: ${bin}" >&2
      exit 1
    fi
    if ! "${bin}" -version >/dev/null 2>&1; then
      echo "error: bundled ${name} failed -version: ${bin}" >&2
      exit 1
    fi
  done
}

assert_license_files() {
  local base="$1"
  local prefix="${base}/usr/share/licenses/replaybox"
  local file
  for file in LICENSE THIRD_PARTY.md GPL-2.0.txt LGPL-2.1.txt; do
    if [[ ! -s "${prefix}/${file}" ]]; then
      echo "error: license file missing or empty: ${prefix}/${file}" >&2
      exit 1
    fi
  done
}

assert_appdir_ready() {
  local appdir="$1"
  local id="${APPIMAGE_DESKTOP_ID}"
  local desk_root="${appdir}/${id}.desktop"
  local desk_apps="${appdir}/usr/share/applications/${id}.desktop"
  local icon_root="${appdir}/${id}.svg"
  local diricon="${appdir}/.DirIcon"
  local icon_svg="${appdir}/usr/share/icons/hicolor/scalable/apps/${id}.svg"

  echo "==> Asserting AppDir desktop/icon entries before re-pack"

  if [[ ! -s "${desk_apps}" ]]; then
    echo "error: desktop file missing or empty: ${desk_apps}" >&2
    exit 1
  fi
  if ! grep -q '^Name=ReplayBox$' "${desk_apps}"; then
    echo "error: expected Name=ReplayBox in ${desk_apps}" >&2
    exit 1
  fi
  if ! grep -q "^Icon=${id}$" "${desk_apps}"; then
    echo "error: expected Icon=${id} in ${desk_apps}" >&2
    exit 1
  fi

  # Root entries must be resolvable symlinks (AppImage canonical layout).
  if [[ ! -L "${desk_root}" ]] || [[ ! -e "${desk_root}" ]]; then
    echo "error: root desktop must be a resolvable symlink: ${desk_root}" >&2
    exit 1
  fi
  if [[ ! -L "${icon_root}" ]] || [[ ! -e "${icon_root}" ]]; then
    echo "error: root SVG icon must be a resolvable symlink: ${icon_root}" >&2
    exit 1
  fi
  if [[ ! -L "${diricon}" ]] || [[ ! -e "${diricon}" ]]; then
    echo "error: .DirIcon must be a resolvable symlink: ${diricon}" >&2
    exit 1
  fi

  # Exactly one .desktop in AppDir root.
  local root_desktops
  root_desktops="$(find "${appdir}" -maxdepth 1 -name '*.desktop' | wc -l | tr -d ' ')"
  if [[ "${root_desktops}" != "1" ]]; then
    echo "error: expected exactly one .desktop in AppDir root, found ${root_desktops}" >&2
    find "${appdir}" -maxdepth 1 -name '*.desktop' >&2 || true
    exit 1
  fi

  if [[ ! -s "${icon_svg}" ]]; then
    echo "error: scalable SVG missing or empty: ${icon_svg}" >&2
    exit 1
  fi

  assert_license_files "${appdir}"
  assert_bundled_ffmpeg "${appdir}"
}

assert_appimage_contents() {
  local appimage="$1"
  local id="${APPIMAGE_DESKTOP_ID}"
  local extract_dir desk icon_svg desk_root icon_root diricon

  echo "==> Asserting packed AppImage desktop/icon contents"
  if [[ ! -s "${appimage}" ]]; then
    echo "error: AppImage missing or empty: ${appimage}" >&2
    exit 1
  fi

  extract_dir="$(mktemp -d "${TMPDIR_APPIMAGE}/extract.XXXXXX")"
  (
    cd "${extract_dir}"
    if ! "${appimage}" --appimage-extract >/dev/null; then
      echo "error: failed to extract ${appimage} for verification" >&2
      exit 1
    fi
    desk="squashfs-root/usr/share/applications/${id}.desktop"
    icon_svg="squashfs-root/usr/share/icons/hicolor/scalable/apps/${id}.svg"
    desk_root="squashfs-root/${id}.desktop"
    icon_root="squashfs-root/${id}.svg"
    diricon="squashfs-root/.DirIcon"
    if [[ ! -s "${desk}" ]]; then
      echo "error: packed desktop missing or empty: ${desk}" >&2
      echo "hint: /tmp may be full — this script sets TMPDIR=${TMPDIR_APPIMAGE}" >&2
      exit 1
    fi
    if ! grep -q '^Name=ReplayBox$' "${desk}"; then
      echo "error: packed desktop missing Name=ReplayBox" >&2
      exit 1
    fi
    if ! grep -q "^Icon=${id}$" "${desk}"; then
      echo "error: packed desktop missing Icon=${id}" >&2
      exit 1
    fi
    if [[ ! -s "${icon_svg}" ]]; then
      echo "error: packed scalable SVG missing or empty: ${icon_svg}" >&2
      echo "hint: /tmp may be full — this script sets TMPDIR=${TMPDIR_APPIMAGE}" >&2
      exit 1
    fi
    if [[ ! -L "${desk_root}" ]] || [[ ! -e "${desk_root}" ]]; then
      echo "error: packed root desktop symlink missing or broken: ${desk_root}" >&2
      exit 1
    fi
    if [[ ! -L "${icon_root}" ]] || [[ ! -e "${icon_root}" ]]; then
      echo "error: packed root SVG symlink missing or broken: ${icon_root}" >&2
      exit 1
    fi
    if [[ ! -L "${diricon}" ]] || [[ ! -e "${diricon}" ]]; then
      echo "error: packed .DirIcon symlink missing or broken: ${diricon}" >&2
      exit 1
    fi
    # Canary: large bundled libs also go to 0 bytes when scratch space is exhausted.
    if [[ ! -s "squashfs-root/usr/lib/libwebkit2gtk-4.1.so.0" ]]; then
      echo "error: packed libwebkit2gtk is empty — AppImage scratch space likely exhausted" >&2
      echo "hint: free space under TMPDIR=${TMPDIR_APPIMAGE} (not /tmp tmpfs)" >&2
      exit 1
    fi
    assert_license_files "squashfs-root"
    assert_bundled_ffmpeg "squashfs-root"
  )
  rm -rf "${extract_dir}"
}

APPDIR="${APPIMAGE_DIR}/ReplayBox.AppDir"
if [[ ! -d "${APPDIR}" ]]; then
  echo "error: ReplayBox.AppDir not found under ${APPIMAGE_DIR}" >&2
  echo "Cannot normalize icons without AppDir." >&2
  exit 1
fi

clean_appimage_tmpdir
normalize_appdir_icons "${APPDIR}"
stage_license_files "${APPDIR}"
normalize_bundled_ffmpeg "${APPDIR}"
assert_appdir_ready "${APPDIR}"
mark T_icons

echo "==> Re-packing AppImage with normalized icons"
echo "    TMPDIR=${TMPDIR} (avoid full /tmp tmpfs truncating usr/share)"
APPIMAGETOOL="$(find_appimagetool)" || {
  echo "error: appimagetool not found (PATH or ~/.cache/tauri/linuxdeploy-plugin-appimage.AppImage)" >&2
  exit 1
}
# Ensure the bundled (offset-capable) mksquashfs is preferred over any host copy.
APPIMAGETOOL_BIN_DIR="$(cd "$(dirname "${APPIMAGETOOL}")" && pwd)"
for candidate in \
  "${APPIMAGETOOL_BIN_DIR}/mksquashfs" \
  "${APPIMAGETOOL_CACHE}/squashfs-root/appimagetool-prefix/usr/bin/mksquashfs"; do
  if [[ -x "${candidate}" ]]; then
    export PATH="$(dirname "${candidate}"):${PATH}"
    break
  fi
done
ensure_cached_runtime
# Prefer overwriting the same filename Tauri produced — only after a successful pack.
OUT_APPIMAGE="${APPIMAGES[0]}"
TMP_APPIMAGE="${OUT_APPIMAGE}.tmp"
rm -f "${TMP_APPIMAGE}"
export ARCH=x86_64
export LDAI_OUTPUT="${TMP_APPIMAGE}"
export OUTPUT="${TMP_APPIMAGE}"
if ! "${APPIMAGETOOL}" --no-appstream --runtime-file "${RUNTIME_CACHE}" "${APPDIR}" "${TMP_APPIMAGE}"; then
  echo "error: appimagetool re-pack failed; keeping Tauri AppImage at ${OUT_APPIMAGE}" >&2
  rm -f "${TMP_APPIMAGE}"
  exit 1
fi
mv -f "${TMP_APPIMAGE}" "${OUT_APPIMAGE}"
chmod +x "${OUT_APPIMAGE}"
assert_appimage_contents "${OUT_APPIMAGE}"
mark T_repack

# Refresh list after repack.
shopt -s nullglob
APPIMAGES=("${APPIMAGE_DIR}"/*.AppImage)
shopt -u nullglob

echo "==> Copying AppImage(s) to build/"
for src in "${APPIMAGES[@]}"; do
  # Skip leftover *.tmp if any.
  [[ "${src}" == *.tmp ]] && continue
  dest="${OUT_DIR}/$(basename "${src}")"
  cp -f "${src}" "${dest}"
  chmod +x "${dest}"
  echo "  ${dest}"
done

T_done="${SECONDS}"
echo "==> Done"
echo "    Log: ${LOG_FILE}"
echo "    Timing: gst $(elapsed_between "${T0}" "${T_gst}")s | npm $(elapsed_between "${T_gst}" "${T_npm}")s | tauri $(elapsed_between "${T_npm}" "${T_tauri}")s | icons $(elapsed_between "${T_tauri}" "${T_icons}")s | repack $(elapsed_between "${T_icons}" "${T_repack}")s | total ${T_done}s"
echo "    Desktop id: ${APPIMAGE_DESKTOP_ID} (Name=ReplayBox)."