#!/usr/bin/env bash
# Build ReplayBox AppImage inside Ubuntu 22.04 via Podman (rootless) or Docker.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

IMAGE_NAME="${REPLAYBOX_CONTAINER_IMAGE:-replaybox-appimage-builder:latest}"
IMAGE_LABEL="org.replaybox.appimage-builder=1"
DOCKERFILE="${ROOT}/docker/appimage/Dockerfile"
ENTRYPOINT_FILE="${ROOT}/docker/appimage/entrypoint.sh"
HASH_FILE="${ROOT}/.cache/container-image.hash"

REBUILD_IMAGE=0
SHELL_MODE=0
EXTRA_ARGS=()

usage() {
  cat <<EOF
Usage: build-appimage-container.sh [OPTIONS] [-- EXTRA_ARGS_FOR_BUILD_APPIMAGE]

Build ReplayBox AppImage in Ubuntu 22.04 (Podman rootless preferred, Docker fallback).

Options:
  --rebuild-image   Force rebuild of the container image
  --shell           Open an interactive shell in the builder container
  -h, --help        Show this help

Environment:
  VERBOSE=1                      Verbose AppImage build (passed through)
  REPLAYBOX_CONTAINER_NO_PRUNE=1   Skip dangling image prune after success
  REPLAYBOX_CONTAINER_FUSE=1       Mount /dev/fuse (troubleshooting only)
  REPLAYBOX_IMAGE_REBUILD=1        Same as --rebuild-image
  REPLAYBOX_CONTAINER_IMAGE        Override image tag (default: ${IMAGE_NAME})

EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rebuild-image)
      REBUILD_IMAGE=1
      shift
      ;;
    --shell)
      SHELL_MODE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      EXTRA_ARGS+=("$@")
      break
      ;;
    *)
      echo "error: unknown argument '$1'" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "${REPLAYBOX_IMAGE_REBUILD:-}" == "1" ]]; then
  REBUILD_IMAGE=1
fi

detect_runtime() {
  if command -v podman >/dev/null 2>&1 && podman info >/dev/null 2>&1; then
    echo podman
    return 0
  fi
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    echo docker
    return 0
  fi
  return 1
}

image_hash() {
  sha256sum "${DOCKERFILE}" "${ENTRYPOINT_FILE}" | sha256sum | awk '{print $1}'
}

image_exists() {
  local runtime="$1"
  "${runtime}" image inspect "${IMAGE_NAME}" >/dev/null 2>&1
}

image_meets_requirements() {
  "${RUNTIME}" run --rm --entrypoint bash "${IMAGE_NAME}" -c \
    'command -v xdg-open >/dev/null 2>&1 \
     && [[ "$(node -p "process.versions.node.split(\".\")[0]" 2>/dev/null || echo 0)" -ge 20 ]]' \
    >/dev/null 2>&1
}

needs_image_build() {
  if [[ "${REBUILD_IMAGE}" -eq 1 ]]; then
    return 0
  fi
  if ! image_exists "${RUNTIME}"; then
    return 0
  fi
  local current stored=""
  current="$(image_hash)"
  if [[ ! -f "${HASH_FILE}" ]]; then
    if image_meets_requirements; then
      mkdir -p "${ROOT}/.cache"
      printf '%s\n' "${current}" >"${HASH_FILE}"
      return 1
    fi
    echo "==> Existing image missing required tools (xdg-open or Node 20+); rebuilding"
    return 0
  fi
  stored="$(cat "${HASH_FILE}")"
  if [[ "${current}" != "${stored}" ]]; then
    return 0
  fi
  if ! image_meets_requirements; then
    echo "==> Existing image missing required tools (xdg-open or Node 20+); rebuilding"
    return 0
  fi
  return 1
}

build_image() {
  echo "==> Building container image ${IMAGE_NAME}"
  export DOCKER_BUILDKIT=1
  "${RUNTIME}" build \
    --tag "${IMAGE_NAME}" \
    --label "${IMAGE_LABEL}" \
    --file "${DOCKERFILE}" \
    "${ROOT}"
  mkdir -p "${ROOT}/.cache"
  image_hash >"${HASH_FILE}"
}

run_container() {
  local -a run_args=()
  local vol_suffix=""

  if [[ "${RUNTIME}" == "podman" ]]; then
    vol_suffix=":Z"
    run_args+=(--userns=keep-id)
    run_args+=(--security-opt label=disable)
  else
    vol_suffix=""
    run_args+=(-u "$(id -u):$(id -g)")
  fi

  if [[ "${REPLAYBOX_CONTAINER_FUSE:-}" == "1" ]]; then
    run_args+=(--cap-add=SYS_ADMIN --device=/dev/fuse)
  fi

  run_args+=(
    --rm
    -v "${ROOT}:/work${vol_suffix}"
    -e "HOME=/work"
    -e "XDG_CACHE_HOME=/work/.cache/container-xdg"
    -e "NPM_CONFIG_CACHE=/work/.cache/npm"
    -e "CARGO_HOME=/work/.cache/cargo-home"
    -e "CARGO_TARGET_DIR=/work/.cache/cargo-target"
    -e "NO_STRIP=true"
    -e "APPIMAGE_EXTRACT_AND_RUN=1"
  )

  if [[ -n "${VERBOSE:-}" ]]; then
    run_args+=(-e "VERBOSE=${VERBOSE}")
  fi

  if [[ "${SHELL_MODE}" -eq 1 ]]; then
    echo "==> Interactive shell in ${IMAGE_NAME} (/work mounted)"
    "${RUNTIME}" run -it "${run_args[@]}" "${IMAGE_NAME}" bash
    return 0
  fi

  if [[ ${#EXTRA_ARGS[@]} -gt 0 ]]; then
    echo "==> Running AppImage build in ${IMAGE_NAME} (${RUNTIME})"
    "${RUNTIME}" run "${run_args[@]}" "${IMAGE_NAME}" "${EXTRA_ARGS[@]}"
  else
    echo "==> Running AppImage build in ${IMAGE_NAME} (${RUNTIME})"
    "${RUNTIME}" run "${run_args[@]}" "${IMAGE_NAME}"
  fi
}

prune_unlabeled_images() {
  if [[ "${REPLAYBOX_CONTAINER_NO_PRUNE:-}" == "1" ]]; then
    echo "==> Skipping image prune (REPLAYBOX_CONTAINER_NO_PRUNE=1)"
    return 0
  fi

  echo "==> Pruning dangling images without label"
  local before after removed=0
  before="$("${RUNTIME}" images -q -f dangling=true 2>/dev/null | wc -l | tr -d ' ')"

  "${RUNTIME}" image prune -f >/dev/null 2>&1 || true
  "${RUNTIME}" image prune -f --filter "label!=org.replaybox.appimage-builder" >/dev/null 2>&1 || true

  after="$("${RUNTIME}" images -q -f dangling=true 2>/dev/null | wc -l | tr -d ' ')"
  removed=$((before - after))
  if [[ "${removed}" -lt 0 ]]; then
    removed=0
  fi
  echo "    Removed ${removed} dangling image layer(s); kept ${IMAGE_NAME}"
}

print_outputs() {
  shopt -s nullglob
  local appimages=("${ROOT}"/build/*.AppImage)
  shopt -u nullglob
  if [[ ${#appimages[@]} -gt 0 ]]; then
    echo "==> AppImage output:"
    for f in "${appimages[@]}"; do
      echo "  ${f}"
    done
  fi
  if [[ -f "${ROOT}/build/appimage-build.log" ]]; then
    echo "==> Build log: ${ROOT}/build/appimage-build.log"
  fi
}

# --- main ---
RUNTIME="$(detect_runtime)" || {
  echo "error: neither podman nor docker is available and functional" >&2
  echo "Install Podman (recommended, rootless) or Docker, then retry." >&2
  exit 1
}

echo "==> Using container runtime: ${RUNTIME}"

if needs_image_build; then
  build_image
else
  echo "==> Container image up to date (${IMAGE_NAME})"
fi

set +e
run_container
RUN_STATUS=$?
set -e

if [[ "${SHELL_MODE}" -eq 1 ]]; then
  exit "${RUN_STATUS}"
fi

if [[ "${RUN_STATUS}" -ne 0 ]]; then
  echo "error: container AppImage build failed (exit ${RUN_STATUS})" >&2
  exit "${RUN_STATUS}"
fi

print_outputs
prune_unlabeled_images
echo "==> Done"
