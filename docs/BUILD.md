# Building ReplayBox

Build instructions for ReplayBox — see the [README](../README.md) for the project overview.

This guide covers a full production build (tested on Arch Linux + KDE Plasma): host packages, downloads, bundled FFmpeg, and the Tauri app.

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

### AppImage

To build only the Linux AppImage and copy it to `build/` at the repo root:

```bash
chmod +x scripts/build-appimage.sh   # once
./scripts/build-appimage.sh
```

Or via npm:

```bash
npm run build:appimage
```

The script runs the same host checks and FFmpeg prepare as `build-all`, stages host GStreamer plugins into `src-tauri/.appimage-gst/` for WebKit `<video>` playback, then `tauri build --bundles appimage`, and copies `*.AppImage` from `src-tauri/target/release/bundle/appimage/` into `build/`. It sets `NO_STRIP=true` so linuxdeploy works on Arch (bundled `strip` otherwise fails on modern system libraries).

FFmpeg/FFprobe showing as “found” in Settings does **not** cover editor playback: the editor uses WebKitGTK + GStreamer. Without plugins in the AppImage, opening the editor can freeze the UI.

ReplayBox allows only **one running instance**. A second launch focuses (and shows) the existing window — including when it was hidden to the tray.

For day-to-day development:

```bash
npm run tauri:dev
```

That command:

1. Prepares bundled FFmpeg (`prepare:ffmpeg`)
2. Starts the Tauri + Vite dev app

## Binaries

The `src-tauri` crate defines one binary. `Cargo.toml` sets `default-run = "replaybox"`.

| Binary | Path | Purpose |
|--------|------|---------|
| `replaybox` | `src/main.rs` | Tauri UI |

```bash
cd src-tauri
cargo run --bin replaybox
cargo run                      # same as --bin replaybox
```

Do **not** run bare `cargo build` / `cargo run` from the repo root — `Cargo.toml` lives under `src-tauri/`. Use the npm scripts or `--manifest-path src-tauri/Cargo.toml`.

## Library indexing

On process start, ReplayBox:

1. Serves the UI from the last SQLite catalog (cache)
2. Runs `scan_library` asynchronously and emits `catalog-updated` when finished

There is no continuous folder watcher. Use **Rescan** in the Library (or restart the app) to pick up new files. Opening a game folder runs a scoped background scan for that folder. Closing the window hides to the system tray without re-indexing.

Rescan and folder scans run asynchronously; the UI listens for `catalog-scan-started` / `catalog-scan-finished` and refreshes on `catalog-updated`.

## Logging

Application files are stored under XDG directories resolved by Tauri `PathResolver` (`identifier`: `org.replaybox`):

| Kind | Path |
|------|------|
| Config (`settings.json`) | `~/.config/org.replaybox/` |
| Data (`replaybox.db`) | `~/.local/share/org.replaybox/` |
| Logs | `~/.local/share/org.replaybox/logs/` |
| Cache (thumbnails) | `~/.cache/org.replaybox/thumbnails/` |
| Cache (preview / playback) | `~/.cache/org.replaybox/playback/` |

The **preview cache** holds remuxed or transcoded MP4 copies used for in-app playback when the original file is not WebView-friendly. Each entry is `{recordingId}.mp4` with a `{recordingId}.json` sidecar (source mtime/size and strategy). Original recordings stay in the watch folder. Entries older than 24 hours are removed automatically; total size is capped by **Preview cache** in Settings (default 5 GB).

Logs are created when the app **runs** (dev or installed binary), not by `./scripts/build-all.sh` alone.

| File | Contents | Retention |
|------|----------|-----------|
| `replaybox.log.*` | Application events (catalog scan, cache jobs, errors) | 7 days |
| `ffmpeg.log.*` | Raw stderr from preview-cache FFmpeg jobs | 7 days |

- **Rotation:** one log file per day, named `{basename}.YYYY-MM-DD` (for example `replaybox.log.2026-08-22`).
- **Retention:** at most 7 days of rotated log files; older files are removed on startup.
- **Default level (`replaybox.log` only):** `info`.
- **Override:** set `RUST_LOG` before starting the app, for example `RUST_LOG=debug npm run tauri:dev`.
- **Debug builds:** app logs go to the daily file and to stderr.
- **Release builds:** app logs go to the daily file only.
- **FFmpeg logs:** written as raw stderr lines to `ffmpeg.log` (not routed through `tracing` or `RUST_LOG`).

Typical `replaybox.log` entries include catalog scan start/finish, skipped unchanged files during indexing, media server errors, and tray or autostart setup failures.

To inspect today's logs:

```bash
tail -f ~/.local/share/org.replaybox/logs/replaybox.log.$(date +%F)
tail -f ~/.local/share/org.replaybox/logs/ffmpeg.log.$(date +%F)
```

## System tray

The tray icon (StatusNotifier on KDE Plasma; AppIndicator on some other desktops) provides **Show** and **Quit**. Closing the main window hides the app; **Quit** exits the process.

On **KDE Plasma**, the tray icon usually works out of the box via StatusNotifier. On **GNOME**, install AppIndicator/StatusNotifier support if the icon is missing (e.g. `libayatana-appindicator` / `libappindicator-gtk3` depending on the distro).

## Launch on login

Settings → **Start ReplayBox when you log in** uses XDG Autostart (`tauri-plugin-autostart`). Saving syncs `~/.config/autostart/`.

## What `build-all` does

1. Verifies host tools (`node`, `npm`, `cargo`, `rustc`, `git`, `make`, `pkg-config`, **`nasm`**, **libx264**)
2. Runs `npm install`
3. Runs `npm run prepare:ffmpeg`
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
  xdg-utils \
  gstreamer \
  gst-plugins-base \
  gst-plugins-good \
  gst-plugins-bad \
  gst-plugins-ugly \
  gst-libav
```

- **`nasm`** — required. `scripts/build-ffmpeg.sh` exits with an error if it is missing.
- **`x264`** — required for `--enable-libx264` in the bundled FFmpeg build.
- **`libappindicator-gtk3`** — recommended for system tray icons on GNOME and other desktops that need AppIndicator; optional on KDE Plasma (StatusNotifier).
- **WebKitGTK / related** — required by Tauri on Linux (exact package names may vary by release).
- **GStreamer + plugins / `gst-libav`** — required for AppImage builds so WebKit can play video in the editor. `build-appimage.sh` copies `/usr/lib/gstreamer-1.0` into the bundle.

### Other distros

Install the equivalents of: a C toolchain, NASM, pkg-config, libx264 (dev), Node.js 18+, Rust, AppIndicator/StatusNotifier support, and Tauri Linux dependencies ([Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)).

## What gets downloaded / generated automatically

| Source | When | Where | Notes |
|--------|------|--------|--------|
| **npm packages** | `npm install` | `node_modules/` | From the npm registry |
| **FFmpeg source** (Git tag `n7.1`) | First `prepare:ffmpeg` (cache miss) | `.cache/ffmpeg/src/` | Cloned from GitHub mirror (fallback: `git.ffmpeg.org`) |
| **Compiled FFmpeg / FFprobe** | Same build | `.cache/ffmpeg/n7.1-<arch>-<fingerprint>/` | Cached; later runs only copy |
| **Staged FFmpeg tools** | Every prepare | `src-tauri/resources/ffmpeg/{ffmpeg,ffprobe}` | Used by the app / Tauri bundle |
| **Rust crates** | `cargo` / `tauri build` | Cargo registry + target dir | Downloaded by Cargo as needed |
| **App binary / installers** | `tauri build` | `src-tauri/target/release/` (+ bundle formats if enabled) | Production output |
| **AppImage copy** | `build:appimage` | `build/*.AppImage` | Copied from Tauri bundle output |
| **Staged GStreamer plugins** | `build:appimage` | `src-tauri/.appimage-gst/` | Copied from `/usr/lib/gstreamer-1.0` into the AppImage |

### FFmpeg cache behavior

- Cache key: tag **`n7.1`** + CPU architecture + fingerprint of configure flags in `scripts/build-ffmpeg.sh`
- **Cache hit:** no Git fetch/compile; copies binaries into `resources/ffmpeg/`
- **Cache miss:** clone/checkout, `./configure`, `make`, install into the cache prefix, then stage

You do **not** need a system `ffmpeg`/`ffprobe` on `PATH` for development or packaging. Empty paths in Settings use the bundled tools.

## Individual commands

| Command | Purpose |
|---------|---------|
| `npm run prepare:ffmpeg` | Build/stage bundled FFmpeg only |
| `npm run tauri:dev` | FFmpeg + Tauri/Vite dev |
| `npm run tauri:build` | FFmpeg + production Tauri build |
| `npm run build:all` / `./scripts/build-all.sh` | Full check + install + FFmpeg + production build |
| `npm run build:appimage` / `./scripts/build-appimage.sh` | Same checks + AppImage only → `build/` |

## License note (bundled FFmpeg)

The bundled FFmpeg is configured with **`--enable-gpl`** and **libx264**. Distributing the app means complying with those license terms.

## Troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| `could not find Cargo.toml` in repo root | Run npm scripts from the root, or `cd src-tauri` / use `--manifest-path` |
| `resource path .../ffmpeg doesn't exist` | Run `npm run prepare:ffmpeg` |
| Tray icon missing on GNOME | Install AppIndicator/StatusNotifier support for your DE |
| `nasm is required to build bundled FFmpeg` | Install `nasm` |
| `libx264 not found` | Install `x264` (and headers / pkg-config file) |
| Slow first build | Normal: compiling FFmpeg from source can take several minutes |
| `Gdk-Message: Error 71 … Wayland display` then app exits | WebKitGTK/NVIDIA on Wayland. ReplayBox sets `__NV_DISABLE_EXPLICIT_SYNC` and `WEBKIT_DISABLE_DMABUF_RENDERER` in `main.rs`. If it still fails, try: `GDK_BACKEND=x11 npm run tauri:dev` |
| Vite `The service is no longer running` after crash | Side effect of the Tauri process exiting; fix the window crash first, then restart `tauri:dev` |
| `failed to run linuxdeploy` when bundling AppImage | On Arch, use `./scripts/build-appimage.sh` (sets `NO_STRIP=true`), or export `NO_STRIP=true` before `tauri build` |
| AppImage freezes when opening the editor | Missing GStreamer plugins in the bundle. Install `gst-libav` and related plugins, then rebuild with `./scripts/build-appimage.sh`. Sanity check: `./src-tauri/target/release/replaybox` should work without freezing |
| Second launch opens another window | Unexpected — single-instance should focus the existing window. Ensure you are on a build that includes `tauri-plugin-single-instance` |
