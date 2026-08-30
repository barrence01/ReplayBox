#!/usr/bin/env bash
# Container entrypoint — install JS deps for Ubuntu, then run the host build script.
set -euo pipefail

cd /work

export HOME="${HOME:-/work}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-/work/.cache/container-xdg}"
export CARGO_HOME="${CARGO_HOME:-/work/.cache/cargo-home}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/work/.cache/cargo-target}"
export RUSTUP_HOME="${RUSTUP_HOME:-/usr/local/rustup}"
export PATH="/usr/local/cargo/bin:${PATH}"
export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-/work/.cache/npm}"
export NO_STRIP="${NO_STRIP:-true}"
export APPIMAGE_EXTRACT_AND_RUN="${APPIMAGE_EXTRACT_AND_RUN:-1}"

mkdir -p "${XDG_CACHE_HOME}" "${CARGO_HOME}" "${CARGO_TARGET_DIR}" "${NPM_CONFIG_CACHE}"

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
if [[ "${NODE_MAJOR}" -lt 20 ]]; then
  echo "error: Node.js 20+ required (found: $(node --version 2>/dev/null || echo missing))" >&2
  exit 1
fi

# Ensure JS deps match the container (host Arch node_modules may differ).
if [[ ! -d node_modules ]] \
  || [[ ! -f package-lock.json ]] \
  || [[ package-lock.json -nt node_modules ]]; then
  if [[ -f package-lock.json ]]; then
    npm ci --prefer-offline || npm install
  else
    npm install
  fi
else
  echo "==> node_modules up to date (skipping npm ci)"
fi

exec ./scripts/build-appimage.sh "$@"
