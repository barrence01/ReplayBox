# ReplayBox

Desktop app for cataloging game recordings and editing clips with **VFR-safe**, time-based trims.

Stack: **Tauri 2** + **React/TypeScript** + **FFmpeg/FFprobe** + **SQLite**.

## Features

- Recursive watch folder (configurable; default under `Gravacoes`)
- Game session detection via Linux `/proc` (configurable process names)
- Session view after the game closes (session clips + all recordings)
- Library grid with thumbnails and names
- Editor with timestamp timeline (PTS/time — not frame indices)
- **Precise trim** — re-encode, VFR-safe
- **Fast trim** — stream copy (may cut on keyframe)
- Compress (libx264 CRF; optional NVENC via system FFmpeg override)
- Create a copy or replace the original (atomic replace)
- Bundled FFmpeg/FFprobe built from Git (with local cache)

## Requirements

- Linux (game detection uses `/proc`)
- [Node.js](https://nodejs.org/) 18+ and npm
- Rust toolchain (`rustc` / `cargo`)
- System packages for Tauri (WebKitGTK, etc.)
- Build deps for bundled FFmpeg (first compile only):

```bash
# Arch Linux
sudo pacman -S --needed base-devel nasm pkgconf x264
```

`nasm` is **required** — `scripts/build-ffmpeg.sh` exits with an error if it is missing.

## Setup

Full production build (checks deps, npm install, FFmpeg, Tauri):

```bash
./scripts/build-all.sh
# or: npm run build:all
```

See **[docs/BUILD.md](docs/BUILD.md)** for host packages and what gets downloaded automatically.

Development:

```bash
npm install
npm run tauri:dev        # runs prepare:ffmpeg automatically
```

Production only (assumes deps already installed):

```bash
npm run tauri:build
```

### FFmpeg cache

- Source/checkout and binaries live under `.cache/ffmpeg/`
- Cache key: `n7.1` + CPU arch + fingerprint of configure flags
- Staged copies for Tauri: `src-tauri/resources/ffmpeg/{ffmpeg,ffprobe}`
- Cache hit only copies into `resources/` (no recompile)

Leave FFmpeg/FFprobe paths **empty** in Settings to use the bundled tools. Set absolute paths to override (e.g. a system build with NVENC).

### License note

The bundled build enables **GPL** (`--enable-gpl`) because it links **libx264**. Distribute ReplayBox accordingly.

## First run

1. Open **Settings**
2. Confirm or change the **watch folder**
3. Add **game process names** (matched against `/proc/*/comm` and cmdline), e.g. `cs2`
4. Click **Rescan** in Library if needed

When a listed game process disappears, ReplayBox opens the **Session** view with clips from that session.

## VFR notes

The timeline and trim APIs work in **milliseconds / timestamps**, not frame counts. Precise trim uses FFmpeg `trim` / `atrim` + `setpts` / `asetpts` and does **not** force `-r` (CFR).

## Project layout

```
scripts/build-all.sh      Full production build
scripts/build-ffmpeg.sh   Git fetch + cache + stage into resources
docs/BUILD.md             Build guide and dependency downloads
src/                      React UI
src-tauri/src/            Rust backend (watcher, /proc, SQLite, FFmpeg)
src-tauri/resources/ffmpeg/   Staged bundled binaries (gitignored)
.cache/ffmpeg/            Build cache (gitignored)
```
