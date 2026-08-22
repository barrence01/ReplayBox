<p align="center">
  <img src="src-tauri/icons/icon.png" alt="ReplayBox" width="128" />
</p>

<h1 align="center">ReplayBox</h1>

<p align="center"><strong>Clip companion for game recordings</strong></p>

---

ReplayBox helps you turn long game recordings into shareable clips — browse your recordings folder, review the last 24 hours, trim and compress, then export a copy ready to upload or send.

---

## Screenshots

```
[placeholder-image: library]
[placeholder-image: session]
[placeholder-image: editor]
```

## Features

- **Game folders** — browse recordings by game under your watch directory
- **Last 24 hours** — review recent captures
- **System tray** — close to tray; indexing runs when the app starts (DB cache + async scan)
- **Launch on login** — optional autostart from Settings
- **Time-based trim** — precise (VFR-safe re-encode) or fast (stream copy; may cut on keyframe)
- **Compress** — smaller files for uploads, with optional system NVENC override
- **Bundled FFmpeg** — no system FFmpeg install required for basic use (built from source with cache)

## Build

Host packages, FFmpeg bundling, and troubleshooting: **[docs/BUILD.md](docs/BUILD.md)**.

```bash
npm install
npm run tauri:dev      # FFmpeg + hot reload
npm run build:all      # full production build (or ./scripts/build-all.sh)
```

| Binary | Role |
|--------|------|
| `replaybox` | Desktop app (`default-run` for `cargo run`) |

## First run

1. Open **Settings** and confirm the **watch folder**.
2. (Optional) Enable **Start ReplayBox when you log in**, then Save.
3. Use **Library** or **Session** (last 24 hours) to browse recordings.
4. Open a clip to trim or compress (**create a copy** or replace the original).
5. Closing the window hides to the tray; use **Quit** in the tray menu to exit.

## Logs

Backend logs are written daily to `~/.local/share/org.replaybox/logs/replaybox.log.YYYY-MM-DD` (at most 7 days retained). Config, database, and cache use separate XDG folders. See **[docs/BUILD.md — Logging](docs/BUILD.md#logging)** for all paths and how to change verbosity with `RUST_LOG`.

## Stack

Tauri 2 · React / TypeScript · FFmpeg · SQLite — **Linux**

## License note

The bundled FFmpeg build enables **GPL** because it links **libx264**. See [docs/BUILD.md](docs/BUILD.md) before redistributing.
