# Building ReplayBox

This guide covers a full production build: host packages, downloads, bundled FFmpeg, and the Tauri app.

## Quick start

```bash
# From the repository root
chmod +x scripts/build-all.sh   # once
./scripts/build-all.sh
```

Or via npm:

```bash
npm run build:all
```

For day-to-day development (bundled FFmpeg + hot reload):

```bash
npm run tauri:dev
```

## What `build-all` does

1. Verifies host tools (`node`, `npm`, `cargo`, `rustc`, `git`, `make`, `pkg-config`, **`nasm`**, **libx264**)
2. Runs `npm install`
3. Runs `npm run prepare:ffmpeg` (build or cache-hit copy of FFmpeg/FFprobe)
4. Runs `npm run tauri:build` (frontend + Rust + app bundle)

## System packages (install yourself)

These are **not** downloaded by the script; install them with your distro package manager.

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
  xdg-utils
```

- **`nasm`** — required. `scripts/build-ffmpeg.sh` exits with an error if it is missing.
- **`x264`** — required for `--enable-libx264` in the bundled FFmpeg build.
- **WebKitGTK / related** — required by Tauri on Linux (exact package names may vary by release).

### Other distros

Install the equivalents of: a C toolchain, NASM, pkg-config, libx264 (dev), Node.js 18+, Rust, and Tauri Linux dependencies ([Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)).

## What gets downloaded / generated automatically

| Source | When | Where | Notes |
|--------|------|--------|--------|
| **npm packages** (`react`, `@tauri-apps/*`, `vite`, …) | `npm install` | `node_modules/` | From the npm registry |
| **FFmpeg source** (Git tag `n7.1`) | First `prepare:ffmpeg` (cache miss) | `.cache/ffmpeg/src/` | Cloned from GitHub mirror (fallback: `git.ffmpeg.org`) |
| **Compiled FFmpeg / FFprobe** | Same build | `.cache/ffmpeg/n7.1-<arch>-<fingerprint>/` | Cached; later runs only copy |
| **Staged binaries** | Every prepare | `src-tauri/resources/ffmpeg/{ffmpeg,ffprobe}` | Used by the app / Tauri bundle |
| **Rust crates** | `cargo` / `tauri build` | Cargo registry + `src-tauri/target/` | Downloaded by Cargo as needed |
| **App binary / installers** | `tauri build` | `src-tauri/target/release/` (+ bundle formats if enabled) | Production output |

### FFmpeg cache behavior

- Cache key: tag **`n7.1`** + CPU architecture + fingerprint of configure flags in `scripts/build-ffmpeg.sh`
- **Cache hit:** no Git fetch/compile; copies binaries into `resources/ffmpeg/`
- **Cache miss:** clone/checkout, `./configure`, `make`, install into the cache prefix, then stage

You do **not** need a system `ffmpeg`/`ffprobe` on `PATH` for development or packaging. Empty paths in Settings use the bundled tools.

## Individual commands

| Command | Purpose |
|---------|---------|
| `npm run prepare:ffmpeg` | Only build/stage bundled FFmpeg |
| `npm run tauri:dev` | Prepare FFmpeg + run the app in dev mode |
| `npm run tauri:build` | Prepare FFmpeg + production Tauri build |
| `npm run build:all` / `./scripts/build-all.sh` | Full check + install + FFmpeg + production build |

## License note (bundled FFmpeg)

The bundled FFmpeg is configured with **`--enable-gpl`** and **libx264**. Distributing the app means complying with those license terms.

## Troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| `nasm is required to build bundled FFmpeg` | Install `nasm` |
| `libx264 not found` | Install `x264` (and headers / pkg-config file) |
| `resource path .../ffmpeg doesn't exist` | Run `npm run prepare:ffmpeg` before a bare `cargo`/`tauri` build |
| Slow first build | Normal: compiling FFmpeg from source can take several minutes |
| `Gdk-Message: Error 71 … Wayland display` then app exits | WebKitGTK/NVIDIA on Wayland. ReplayBox sets `__NV_DISABLE_EXPLICIT_SYNC` and `WEBKIT_DISABLE_DMABUF_RENDERER` in `main.rs`. If it still fails, try: `GDK_BACKEND=x11 npm run tauri:dev` |
| Vite `The service is no longer running` after crash | Side effect of the Tauri process exiting; fix the window crash first, then restart `tauri:dev` |
