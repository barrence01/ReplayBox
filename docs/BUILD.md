# Building ReplayBox

Build instructions for ReplayBox — see the [README](../README.md) for the project overview.

This guide covers a full production build: host packages, downloads, bundled FFmpeg, the `replayboxd` sidecar, and the Tauri app.

## Quick start

```bash
# From the repository root
chmod +x scripts/build-all.sh scripts/stage-daemon.sh   # once
./scripts/build-all.sh
```

Or via npm:

```bash
npm run build:all
```

For day-to-day development:

```bash
npm run tauri:dev
```

That command:

1. Prepares bundled FFmpeg (`prepare:ffmpeg`)
2. Stages `replayboxd` as a Tauri `externalBin` sidecar (`stage:daemon`)
3. Starts the Tauri + Vite dev app

## Binaries

The `src-tauri` crate defines two binaries. `Cargo.toml` sets `default-run = "replaybox"`.

| Binary | Path | Purpose |
|--------|------|---------|
| `replaybox` | `src/main.rs` | Tauri UI |
| `replayboxd` | `src/bin/replayboxd.rs` | Background daemon (watch folder + game process sessions) |

```bash
# From the repository root (preferred)
npm run build:daemon
npm run stage:daemon           # debug → src-tauri/binaries/replayboxd-<host-triple>
npm run stage:daemon:release   # release (used by tauri:build / build-all)

cd src-tauri
cargo run --bin replaybox
cargo run                      # same as --bin replaybox
cargo run --bin replayboxd
```

Do **not** run bare `cargo build` / `cargo run` from the repo root — `Cargo.toml` lives under `src-tauri/`. Use the npm scripts or `--manifest-path src-tauri/Cargo.toml`.

`stage:daemon` creates a placeholder under `src-tauri/binaries/` if needed so Tauri’s build script accepts `externalBin`, then builds and overwrites with the real binary. Staged `binaries/replayboxd-*` files are gitignored (`.gitkeep` remains).

Without `--bin` or `default-run`, Cargo errors with *could not determine which binary to run* when both binaries exist.

### Background service (`replayboxd`)

Flow:

1. `npm run tauri:dev` or `npm run stage:daemon` so a source binary exists (sidecar beside the app, `target/…/replayboxd`, or `binaries/replayboxd-*`).
2. Settings → **Run background service** → Save.
3. The app **copies** the daemon to:

   `~/.local/share/com.williambarrence.replaybox/bin/replayboxd`

4. It writes `~/.config/systemd/user/replayboxd.service` with `ExecStart=` set to that installed path, then runs `systemctl --user enable --now replayboxd`.

**AppImage note:** never point systemd at a path inside an AppImage mount (`/tmp/.mount_*`). Those disappear when the AppImage is not running. Install-to-app-data is what keeps the service valid for future AppImage bundles.

On startup with the service enabled, ReplayBox refreshes the installed binary if the source is newer and restarts the unit when needed.

Useful checks:

```bash
systemctl --user status replayboxd
systemctl --user cat replayboxd    # ExecStart should be under ~/.local/share/.../bin/
```

If you need the user service without an active graphical login session, see `loginctl enable-linger`.

## What `build-all` does

1. Verifies host tools (`node`, `npm`, `cargo`, `rustc`, `git`, `make`, `pkg-config`, **`nasm`**, **libx264**)
2. Runs `npm install`
3. Runs `npm run prepare:ffmpeg`
4. Stages release `replayboxd` for `externalBin` (`stage:daemon:release`)
5. Runs `npm run tauri:build` (frontend + Rust + app bundle; stages daemon again via `beforeBuildCommand`)

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
| **npm packages** | `npm install` | `node_modules/` | From the npm registry |
| **FFmpeg source** (Git tag `n7.1`) | First `prepare:ffmpeg` (cache miss) | `.cache/ffmpeg/src/` | Cloned from GitHub mirror (fallback: `git.ffmpeg.org`) |
| **Compiled FFmpeg / FFprobe** | Same build | `.cache/ffmpeg/n7.1-<arch>-<fingerprint>/` | Cached; later runs only copy |
| **Staged FFmpeg tools** | Every prepare | `src-tauri/resources/ffmpeg/{ffmpeg,ffprobe}` | Used by the app / Tauri bundle |
| **Staged `replayboxd` sidecar** | `stage:daemon` / `tauri:dev` / `tauri:build` | `src-tauri/binaries/replayboxd-<triple>` | Tauri `externalBin`; gitignored |
| **Rust crates** | `cargo` / `tauri build` | Cargo registry + target dir | Downloaded by Cargo as needed |
| **Installed daemon (runtime)** | Enable background service | `~/.local/share/com.williambarrence.replaybox/bin/replayboxd` | systemd `ExecStart` target |
| **App binary / installers** | `tauri build` | `src-tauri/target/release/` (+ bundle formats if enabled) | Production output |

### FFmpeg cache behavior

- Cache key: tag **`n7.1`** + CPU architecture + fingerprint of configure flags in `scripts/build-ffmpeg.sh`
- **Cache hit:** no Git fetch/compile; copies binaries into `resources/ffmpeg/`
- **Cache miss:** clone/checkout, `./configure`, `make`, install into the cache prefix, then stage

You do **not** need a system `ffmpeg`/`ffprobe` on `PATH` for development or packaging. Empty paths in Settings use the bundled tools.

## Individual commands

| Command | Purpose |
|---------|---------|
| `npm run prepare:ffmpeg` | Build/stage bundled FFmpeg only |
| `npm run build:daemon` | `cargo build --bin replayboxd` via manifest path |
| `npm run stage:daemon` | Build debug daemon + copy to `binaries/replayboxd-<triple>` |
| `npm run stage:daemon:release` | Same for release (production) |
| `npm run tauri:dev` | FFmpeg + stage daemon + Tauri/Vite dev |
| `npm run tauri:build` | FFmpeg + stage release daemon + production Tauri build |
| `npm run build:all` / `./scripts/build-all.sh` | Full check + install + FFmpeg + stage + production build |

## License note (bundled FFmpeg)

The bundled FFmpeg is configured with **`--enable-gpl`** and **libx264**. Distributing the app means complying with those license terms.

## Troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| `could not find Cargo.toml` in repo root | Run npm scripts from the root, or `cd src-tauri` / use `--manifest-path` |
| `could not determine which binary to run` | Use `--bin replaybox` or rely on `default-run`; or `npm run tauri:dev` |
| `resource path .../ffmpeg doesn't exist` | Run `npm run prepare:ffmpeg` |
| `resource path .../binaries/replayboxd-... doesn't exist` | Run `npm run stage:daemon` (or `tauri:dev` / `tauri:build`) |
| `replayboxd binary not found` when enabling the service | Stage/build the daemon first, then Save settings again |
| Unit active but `ExecStart` under `/tmp/.mount_*` | Old unit; disable/re-enable the background service so it reinstalls under app data |
| `nasm is required to build bundled FFmpeg` | Install `nasm` |
| `libx264 not found` | Install `x264` (and headers / pkg-config file) |
| Slow first build | Normal: compiling FFmpeg from source can take several minutes |
| `Gdk-Message: Error 71 … Wayland display` then app exits | WebKitGTK/NVIDIA on Wayland. ReplayBox sets `__NV_DISABLE_EXPLICIT_SYNC` and `WEBKIT_DISABLE_DMABUF_RENDERER` in `main.rs`. If it still fails, try: `GDK_BACKEND=x11 npm run tauri:dev` |
| Vite `The service is no longer running` after crash | Side effect of the Tauri process exiting; fix the window crash first, then restart `tauri:dev` |
