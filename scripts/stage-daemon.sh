#!/usr/bin/env bash
# Build replayboxd and stage it for Tauri externalBin (binaries/replayboxd-<triple>).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${1:-debug}"
MANIFEST="${ROOT}/src-tauri/Cargo.toml"
BIN_DIR="${ROOT}/src-tauri/binaries"

if [[ "${PROFILE}" != "debug" && "${PROFILE}" != "release" ]]; then
  echo "usage: $0 [debug|release]" >&2
  exit 1
fi

TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
if [[ -z "${TRIPLE}" ]]; then
  echo "error: could not detect rustc host triple" >&2
  exit 1
fi

mkdir -p "${BIN_DIR}"
DEST="${BIN_DIR}/replayboxd-${TRIPLE}"

# tauri-build requires the externalBin path to exist before any cargo build of this package.
if [[ ! -f "${DEST}" ]]; then
  printf '%s\n' '#!/bin/sh' 'echo "replayboxd placeholder — run npm run stage:daemon"' > "${DEST}"
  chmod +x "${DEST}"
fi

CARGO_ARGS=(build --manifest-path "${MANIFEST}" --bin replayboxd)
if [[ "${PROFILE}" == "release" ]]; then
  CARGO_ARGS+=(--release)
fi

echo "==> Building replayboxd (${PROFILE})"
cargo "${CARGO_ARGS[@]}"

TARGET_DIR="$(cargo metadata --manifest-path "${MANIFEST}" --format-version 1 --no-deps \
  | sed -n 's/.*"target_directory":"\([^"]*\)".*/\1/p' | head -n1)"
if [[ -z "${TARGET_DIR}" ]]; then
  TARGET_DIR="${ROOT}/src-tauri/target"
fi

SRC="${TARGET_DIR}/${PROFILE}/replayboxd"
if [[ ! -f "${SRC}" ]]; then
  echo "error: expected binary not found: ${SRC}" >&2
  echo "hint: target_directory=${TARGET_DIR}" >&2
  exit 1
fi

cp -f "${SRC}" "${DEST}"
chmod +x "${DEST}"
echo "Staged: ${DEST}"
