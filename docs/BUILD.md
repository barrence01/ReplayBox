# Building ReplayBox

Build instructions for ReplayBox — see the [README](../README.md) for the project overview.

This guide covers a full production build (tested on Arch Linux and Ubuntu): host packages, downloads, bundled FFmpeg, and the Tauri app.

## Quick start

```bash
# From the repository root
chmod +x scripts/check-build-deps.sh scripts/build-all.sh   # once
./scripts/check-build-deps.sh
./scripts/build-all.sh
```

Or via npm:

```bash
npm run build:all
```

### AppImage

**Recommended:** build inside Ubuntu 22.04 via Podman or Docker for a portable AppImage (glibc 2.35 baseline, works on Arch and Ubuntu):

```bash
chmod +x scripts/build-appimage-container.sh   # once
./scripts/build-appimage-container.sh
```

Or via npm:

```bash
npm run build:appimage:container
```

Requires only **Podman** (rootless, preferred) or **Docker** on the host — no Tauri/GStreamer packages needed locally. The container image includes **Node.js 20 LTS** (Ubuntu apt ships Node 12, which is too old for Tauri CLI). First run builds the container image and may take a while (FFmpeg + Rust + linuxdeploy); later runs reuse caches under `.cache/`.

Options:

```bash
./scripts/build-appimage-container.sh --rebuild-image   # force image rebuild
./scripts/build-appimage-container.sh --shell           # debug shell in container
VERBOSE=1 ./scripts/build-appimage-container.sh         # verbose AppImage log
```

| | Container build | Native host build |
| --- | --- | --- |
| Host deps | Podman or Docker only | Full Tauri/GStreamer stack |
| glibc baseline | Ubuntu 22.04 (portable) | Depends on host distro |
| Command | `npm run build:appimage:container` | `npm run build:appimage` |

**Native host build** (advanced — inherits host libraries):

To build only the Linux AppImage on the host and copy it to `build/` at the repo root:

```bash
chmod +x scripts/check-build-deps.sh scripts/build-appimage.sh   # once
./scripts/check-build-deps.sh --appimage
./scripts/build-appimage.sh
```

Or via npm:

```bash
npm run build:appimage
```

#### Container troubleshooting

| Symptom | Likely fix |
| --- | --- |
| Permission denied on output files (Podman) | Wrapper uses `--userns=keep-id`; ensure rootless Podman is configured |
| Root-owned files in `build/` (Docker) | Wrapper passes `-u uid:gid`; or `chown` after build |
| `failed to run linuxdeploy` | `VERBOSE=1 ./scripts/build-appimage-container.sh`; inspect `build/appimage-build.log` |
| FUSE-related errors | Try `REPLAYBOX_CONTAINER_FUSE=1 ./scripts/build-appimage-container.sh` |
| Unwanted image prune | `REPLAYBOX_CONTAINER_NO_PRUNE=1` |

After a successful build, the wrapper prunes dangling `<none>` images without the `org.replaybox.appimage-builder` label; the tagged `replaybox-appimage-builder:latest` image is kept.


For day-to-day development:

```bash
npm run tauri:dev
```

That command:

1. Verifies host deps for WebKit video preview (`check-build-deps.sh --dev`)
2. Prepares bundled FFmpeg (`prepare:ffmpeg`)
3. Starts the Tauri + Vite dev app



## Binaries

The `src-tauri` crate defines one binary. `Cargo.toml` sets `default-run = "replaybox"`.


| Binary      | Path          | Purpose  |
| ----------- | ------------- | -------- |
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


| Kind                       | Path                                 |
| -------------------------- | ------------------------------------ |
| Config (`settings.json`)   | `~/.config/org.replaybox/`           |
| Data (`replaybox.db`)      | `~/.local/share/org.replaybox/`      |
| Logs                       | `~/.local/share/org.replaybox/logs/` |
| Cache (thumbnails)         | `~/.cache/org.replaybox/thumbnails/` |
| Cache (preview / playback) | `~/.cache/org.replaybox/playback/`   |


The **preview cache** holds compatibility copies used when the editor cannot play the original recording. For MP4 + H.264, ReplayBox serves the watch-folder file first (HTTP Range supports `moov` at the end of the file). A cache job runs only after a confirmed playback failure, or proactively for non-MP4 containers such as MKV. The fallback ladder is: **Direct** (original) → **StreamCopy** (video copy, Opus preserved when possible, faststart) → **Transcode** (video re-encode, last resort).

When StreamCopy runs on an **MP4** source, ReplayBox remuxes the recording **in place** in the watch folder (lossless container fix; no duplicate in the preview cache). If in-place replacement fails, it falls back to a cache copy. **MKV** StreamCopy and **Transcode** previews still use `~/.cache/org.replaybox/playback/` (`{recordingId}.mp4` plus a `{recordingId}.json` sidecar). Entries older than 24 hours are removed automatically; total size is capped by **Preview cache** in Settings (default 5 GB). WebKit may reject some OBS MP4s (VFR, `moov` at end) before optimization; that is a player limitation, not a codec mismatch in the catalog.

Logs are created when the app **runs** (dev or installed binary), not by `./scripts/build-all.sh` alone.


| File              | Contents                                              | Retention |
| ----------------- | ----------------------------------------------------- | --------- |
| `replaybox.log.*` | Application events (catalog scan, cache jobs, errors) | 7 days    |
| `ffmpeg.log.*`    | Raw stderr from preview-cache FFmpeg jobs             | 7 days    |


- **Rotation:** one log file per day, named `{basename}.YYYY-MM-DD` (for example `replaybox.log.2026-08-22`).
- **Retention:** at most 7 days of rotated log files; older files are removed on startup.
- **Default level (**`replaybox.log` **only):** `info`.
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

The tray icon (StatusNotifier on KDE Plasma; AppIndicator on some other desktops) provides **Show**, **Pause Jobs** / **Resume Jobs**, and **Quit**. Closing the main window hides the app to the tray, releases editor/UI resources, discards the in-memory library catalog (reloaded from SQLite on reopen), cancels preview preparation jobs, and pauses job queues (in-flight edit jobs finish; no new work starts). Reopening returns to the **Session** home. While any edit or preview job is queued or processing, the tray icon switches to a busy badge variant. **Pause Jobs** is a sticky toggle that keeps queues paused even after the window is shown again. **Quit** cancels active jobs and exits the process.

The app starts on the **Session** view.

On **KDE Plasma**, the tray icon usually works out of the box via StatusNotifier. On **GNOME**, install AppIndicator/StatusNotifier support if the icon is missing (e.g. `libayatana-appindicator` / `libappindicator-gtk3` depending on the distro).

## Launch on login

Settings → **Start ReplayBox in the tray when you log in** uses XDG Autostart (`tauri-plugin-autostart`) with `--hidden`. Saving syncs `~/.config/autostart/`. Login launch stays in the system tray until you open the window from the tray.

## What `build-all` does

1. Verifies host tools via `scripts/check-build-deps.sh` (Node, Rust, Tauri/GTK/WebKit libs, NASM, libx264, and related build deps)
2. Runs `npm install`
3. Runs `npm run prepare:ffmpeg`
4. Runs `npm run tauri:build` (frontend + Rust + app bundle)



## System packages (install yourself)

These are **not** downloaded by the script; install them with your distro package manager.

Validate before building:

```bash
./scripts/check-build-deps.sh           # full production build
./scripts/check-build-deps.sh --dev      # tauri dev (WebKit video preview plugins)
./scripts/check-build-deps.sh --appimage # AppImage build (adds GStreamer runtime + libfuse2)
./scripts/check-build-deps.sh --ffmpeg   # bundled FFmpeg only
```

If anything is missing, the script prints install commands for Arch Linux and Ubuntu.

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
  fuse2 \
  patchelf
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
  patchelf \
  wget \
  curl \
  file \
  xdg-utils
```

Node.js **20+** (Tauri 2 / Vite 7). Do not use Ubuntu apt `nodejs` on 22.04 (Node 12):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # v20.x or newer
```

On Ubuntu 24.04+, `libfuse2` may install as `libfuse2t64`. linuxdeploy is itself an AppImage and needs `libfuse.so.2`, or extract-and-run (`APPIMAGE_EXTRACT_AND_RUN=1`, which `build-appimage.sh` sets).

Rust on Ubuntu (install rustup, then reopen the shell or run `source "$HOME/.cargo/env"`):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

- `nasm` — required. `scripts/build-ffmpeg.sh` exits with an error if it is missing.
- `x264` / `libx264-dev` — required for `--enable-libx264` in the bundled FFmpeg build.
- `libva-dev` (Ubuntu) / `libva` (Arch) — required for `--enable-vaapi` in the bundled FFmpeg build.
- **nv-codec-headers** — fetched automatically into `.cache/ffmpeg/nv-codec-headers` during `prepare:ffmpeg` (needed for `--enable-nvenc`).
- `libappindicator-gtk3` / `libayatana-appindicator3-dev` — recommended for system tray icons on GNOME and other desktops that need AppIndicator; optional on KDE Plasma (StatusNotifier).
- **WebKitGTK / related** — required by Tauri on Linux (exact package names may vary by release).
- **GStreamer + plugins / `gst-libav` / `gstreamer1.0-libav`** — required for AppImage builds so WebKit can play video in the editor. `build-appimage.sh` stages a curated subset under `src-tauri/.appimage-gst/` and sets `GSTREAMER_PLUGINS_DIR` so linuxdeploy only bundles those plugins. `gstreamer1.0-tools` (`gst-inspect-1.0`) is needed at bundle time.
- **`fuse2` (Arch) / `libfuse2` (Ubuntu, possibly `libfuse2t64`)** — required to run/build AppImages on hosts that use FUSE2.
- **`librsvg` / `librsvg2-bin`** — linuxdeploy’s GTK plugin uses `rsvg-convert` for icons.
- **`patchelf`** — required by linuxdeploy’s GStreamer plugin (`--appimage` builds) to set RPATHs on bundled plugins.
- **Node.js 20+** — required for Tauri CLI, Vite, and Vitest (`check-build-deps.sh` verifies the major version).
- **`xdg-utils` (`xdg-open`)** — required by Tauri/linuxdeploy when bundling AppImage.

### Other distros

Install the equivalents of the packages above, or run `./scripts/check-build-deps.sh` and follow the printed hints. See also [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

## What gets downloaded / generated automatically


| Source                             | When                                | Where                                                     | Notes                                                                              |
| ---------------------------------- | ----------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **npm packages**                   | `npm install`                       | `node_modules/`                                           | From the npm registry                                                              |
| **FFmpeg source** (Git tag `n7.1`) | First `prepare:ffmpeg` (cache miss) | `.cache/ffmpeg/src/`                                      | Cloned from GitHub mirror (fallback: `git.ffmpeg.org`)                             |
| **Compiled FFmpeg / FFprobe**      | Same build                          | `.cache/ffmpeg/n7.1-<arch>-<fingerprint>/`                | Cached; later runs only copy                                                       |
| **Staged FFmpeg tools**            | Every prepare                       | `src-tauri/resources/ffmpeg/{ffmpeg,ffprobe}`             | Used by the app / Tauri bundle                                                     |
| **Rust crates**                    | `cargo` / `tauri build`             | Cargo registry + target dir                               | Downloaded by Cargo as needed                                                      |
| **App binary / installers**        | `tauri build`                       | `src-tauri/target/release/` (+ bundle formats if enabled) | Production output                                                                  |
| **AppImage copy**                  | `build:appimage`                    | `build/*.AppImage`                                        | Copied from Tauri bundle output                                                    |
| **Staged GStreamer plugins**       | `build:appimage`                    | `src-tauri/.appimage-gst/`                                | Curated plugins; also exported as `GSTREAMER_PLUGINS_DIR` for linuxdeploy          |
| **appimagetool extract**           | AppImage re-pack                    | `.cache/appimage/appimagetool/`                           | Extracted once from Tauri’s linuxdeploy plugin (gitignored)                        |
| **AppImage type2 runtime**         | AppImage re-pack                    | `.cache/appimage/runtime-x86_64`                          | Avoids re-download on every re-pack (gitignored)                                   |
| **AppImage scratch TMPDIR**        | AppImage normalize/re-pack          | `.cache/appimage/tmp/`                                    | Cleared before icon normalize; used by `mksquashfs` / extract asserts (not `/tmp`) |




### FFmpeg cache behavior

- Cache key: tag `n7.1` + CPU architecture + fingerprint of configure flags in `scripts/build-ffmpeg.sh`
- **Cache hit:** no Git fetch/compile; copies binaries into `resources/ffmpeg/`
- **Cache miss:** clone/checkout, `./configure`, `make`, install into the cache prefix, then stage

You do **not** need a system `ffmpeg`/`ffprobe` on `PATH` for development or packaging. Empty paths in Settings use the bundled tools.

### Hardware encoding in the AppImage

The bundled FFmpeg includes **h264_nvenc** and **h264_vaapi** when built with `npm run prepare:ffmpeg`. GPU drivers and libraries remain on the **host**:

- **NVENC (NVIDIA):** proprietary driver with `libnvidia-encode.so.1` (`nvidia-smi` should work).
- **VAAPI (Intel / AMD):** `libva`, Mesa or vendor drivers, and `/dev/dri/renderD*`.

Settings shows compiled vs runtime status for each backend. Preview prefers hardware automatically (NVENC, then VAAPI, then libx264). Edit jobs follow **Prefer hardware encoding when available**.

| Symptom | Likely cause |
| --- | --- |
| NVENC compiled but driver unavailable | Install/update the NVIDIA driver; verify `libnvidia-encode.so.1` |
| VAAPI compiled but device unavailable | Install `libva` / Mesa; run `vainfo`; check `/dev/dri/renderD128` |
| Falls back to software only | Expected without a working GPU stack; libx264 always available |

## Individual commands


| Command                                                  | Purpose                                                     |
| -------------------------------------------------------- | ----------------------------------------------------------- |
| `npm run prepare:ffmpeg`                                 | Build/stage bundled FFmpeg only                             |
| `npm run tauri:dev`                                      | FFmpeg + Tauri/Vite dev                                     |
| `npm run tauri:build`                                    | FFmpeg + production Tauri build                             |
| `npm run build:all` / `./scripts/build-all.sh`           | Full check + install + FFmpeg + production build            |
| `npm run build:appimage` / `./scripts/build-appimage.sh` | Checks + curated GST staging + AppImage → `build/` (native host) |
| `npm run build:appimage:container` / `./scripts/build-appimage-container.sh` | Same via Ubuntu 22.04 container (recommended) |
| `VERBOSE=1 ./scripts/build-appimage.sh`                  | Same; also mirrors the (always verbose) Tauri/linuxdeploy log to the terminal |




## License (redistribution)

ReplayBox application code is **MIT** — see [LICENSE](../LICENSE).

The AppImage bundles additional components under **GPL-2.0** (bundled FFmpeg with libx264) and **LGPL-2.1** (GStreamer, WebKitGTK, GTK). Full texts and corresponding-source notes: **[THIRD_PARTY.md](../THIRD_PARTY.md)**. License files are copied into the AppImage at `usr/share/licenses/replaybox/`.

## Troubleshooting


| Symptom                                                  | Likely cause                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `could not find Cargo.toml` in repo root                 | Run npm scripts from the root, or `cd src-tauri` / use `--manifest-path`                                                                                                                                                                                                                                                                               |
| `resource path .../ffmpeg doesn't exist`                 | Run `npm run prepare:ffmpeg`                                                                                                                                                                                                                                                                                                                           |
| `FFmpeg/FFprobe missing` banner in AppImage              | Bundled tools were present under `resources/ffmpeg/` but the app resolves `$RESOURCE/ffmpeg/`. Rebuild with `./scripts/build-appimage.sh` (normalizes layout into `usr/lib/ReplayBox/ffmpeg/` — or `replaybox` — and asserts `-version` before/after re-pack)                                                                                          |
| Tray icon missing on GNOME                               | Install AppIndicator/StatusNotifier support for your DE                                                                                                                                                                                                                                                                                                |
| `nasm is required to build bundled FFmpeg`               | Install `nasm`                                                                                                                                                                                                                                                                                                                                         |
| `libx264 not found`                                      | Install `x264` (and headers / pkg-config file)                                                                                                                                                                                                                                                                                                         |
| `libva not found` / FFmpeg configure fails on VAAPI      | Install `libva-dev` (Ubuntu) or `libva` (Arch)                                                                                                                                                                                                                                                                                                       |
| `bundled FFmpeg missing h264_nvenc` / `h264_vaapi`       | Re-run `npm run prepare:ffmpeg` after installing build deps; clear stale cache under `.cache/ffmpeg/` if needed                                                                                                                                                                                                                                      |
| `ffnvcodec` / NVENC configure error in container build    | Stale `.cache/ffmpeg/nv-codec-headers-prefix` from a host-path build; re-run `npm run prepare:ffmpeg` (script reinstalls when pkg-config prefix mismatches) or remove `.cache/ffmpeg/nv-codec-headers-prefix/`                                                                                                                                     |
| Slow first build                                         | Normal: compiling FFmpeg from source can take several minutes                                                                                                                                                                                                                                                                                          |
| `GStreamer element appsink/autoaudiosink not found` in dev | WebKitGTK needs host GStreamer plugins for editor video preview. Run `./scripts/check-build-deps.sh --dev` — it fails early with install hints. On Arch: `gst-plugins-base` + `gst-plugins-good` (+ `gst-plugins-bad`, `gst-libav` recommended). Verify: `gst-inspect-1.0 appsink autoaudiosink`. |
| `WebKitWebProcess` + `GLib-GObject-CRITICAL` after opening editor | Often follows missing GStreamer elements above. Fix plugins first; if it persists, try `GDK_BACKEND=x11 npm run tauri:dev`. |
| `Gdk-Message: Error 71 … Wayland display` then app exits | WebKitGTK/NVIDIA on Wayland. ReplayBox sets `__NV_DISABLE_EXPLICIT_SYNC` and `WEBKIT_DISABLE_DMABUF_RENDERER` in `main.rs`. If it still fails, try: `GDK_BACKEND=x11 npm run tauri:dev`                                                                                                                                                                |
| Vite `The service is no longer running` after crash      | Side effect of the Tauri process exiting; fix the window crash first, then restart `tauri:dev`                                                                                                                                                                                                                                                         |
| `failed to run linuxdeploy` when bundling AppImage       | Tauri hides linuxdeploy stderr unless `--verbose` is set. Use `./scripts/build-appimage.sh` (always passes `--verbose`, sets `NO_STRIP=true` and `APPIMAGE_EXTRACT_AND_RUN=1`, and dumps host/log matches on failure). Inspect `build/appimage-build.log`. Run `./scripts/check-build-deps.sh --appimage` first (`patchelf`, `libfuse2`/`libfuse2t64`, `librsvg2-bin`, `gstreamer1.0-tools`). If the Tauri tool cache is corrupt: `rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}"/tauri/linuxdeploy*` |
| `appimagetool not found` after linuxdeploy succeeds (container) | Tauri caches under `XDG_CACHE_HOME` (e.g. `.cache/container-xdg/tauri/`). Re-run `./scripts/build-appimage-container.sh` — `build-appimage.sh` resolves that path automatically. |
| AppImage freezes when opening the editor                 | Missing GStreamer plugins in the bundle. Install `gst-libav` and related plugins, then rebuild with `./scripts/build-appimage.sh` (clears/restages `src-tauri/.appimage-gst/` when the fingerprint changes). Smoke-test: open the editor and play a local H.264 MP4. Sanity check: `./src-tauri/target/release/replaybox` should work without freezing |
| Second launch opens another window                       | Unexpected — single-instance should focus the existing window. Ensure you are on a build that includes `tauri-plugin-single-instance`                                                                                                                                                                                                                  |


