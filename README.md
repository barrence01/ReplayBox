<p align="center">
  <img src="src-tauri/icons/icon.png" alt="ReplayBox" width="128" />
</p>

<h1 align="center">ReplayBox</h1>

<p align="center"><strong>Clip companion for game recordings</strong></p>

---

ReplayBox helps you turn long game recordings into shareable clips — watch your recordings folder, review what you captured after a session, trim and compress, then export a copy ready to upload or send.

---

## Screenshots

```
[placeholder-image: library]
[placeholder-image: session]
[placeholder-image: editor]
```

## Features

- **Game folders** — browse recordings by game under your watch directory
- **Session review** — when a configured game process exits, jump straight to that session’s clips
- **Background service** — optional `replayboxd` systemd user unit keeps indexing and sessions running with the UI closed
- **Time-based trim** — precise (VFR-safe re-encode) or fast (stream copy; may cut on keyframe)
- **Compress** — smaller files for uploads, with optional system NVENC override
- **Bundled FFmpeg** — no system FFmpeg install required for basic use (built from source with cache)

## Build

Host packages, FFmpeg bundling, and troubleshooting: **[docs/BUILD.md](docs/BUILD.md)**.

```bash
# Install JS deps
npm install

# Development (UI + hot reload; prepares bundled FFmpeg first)
npm run tauri:dev

# Full production build
./scripts/build-all.sh
# or: npm run build:all
```

The Rust crate ships two binaries:

| Binary | Role |
|--------|------|
| `replaybox` | Tauri desktop app (default for `cargo run`) |
| `replayboxd` | Background daemon (folder watcher + game sessions) |

```bash
cd src-tauri

# Desktop app
cargo run --bin replaybox
# or: cargo run   # default-run is replaybox

# Background daemon (needed before enabling the Settings toggle)
cargo build --bin replayboxd
cargo run --bin replayboxd
```

## First run

1. Open **Settings** and confirm the **watch folder** (where your recordings live).
2. Add **game process names** (matched against `/proc`, e.g. `cs2`).
3. (Optional) Enable **Run background service** so indexing and sessions continue while ReplayBox is closed. Build `replayboxd` first (see Build above); Save settings installs/enables the user systemd unit. If you need the service without a graphical login session, see `loginctl enable-linger`.
4. Play a game — when it closes, use **Session** to review new clips.
5. Open a clip to trim or compress, then **create a copy** (or replace the original).

## Stack

Tauri 2 · React / TypeScript · FFmpeg · SQLite — **Linux**

## License note

The bundled FFmpeg build enables **GPL** because it links **libx264**. See [docs/BUILD.md](docs/BUILD.md) before redistributing.
