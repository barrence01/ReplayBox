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

Host packages, FFmpeg bundling, daemon staging, and troubleshooting: **[docs/BUILD.md](docs/BUILD.md)**.

```bash
npm install
npm run tauri:dev      # FFmpeg + stage replayboxd + hot reload
npm run build:all      # full production build (or ./scripts/build-all.sh)
```

| Binary | Role |
|--------|------|
| `replaybox` | Desktop app (`default-run` for `cargo run`) |
| `replayboxd` | Background daemon (watch folder + game sessions) |

```bash
npm run build:daemon          # build daemon only
npm run stage:daemon          # debug → src-tauri/binaries/replayboxd-<triple>
npm run stage:daemon:release  # release sidecar for production bundles
```

Enabling **Run background service** copies the daemon to  
`~/.local/share/com.williambarrence.replaybox/bin/replayboxd` and points the systemd user unit at that path (AppImage-safe).

## First run

1. Open **Settings** and confirm the **watch folder**.
2. Add **game process names** (matched against `/proc`, e.g. `cs2`).
3. (Optional) Enable **Run background service**, then Save — indexing/sessions continue with the UI closed. Prefer `npm run tauri:dev` so the sidecar exists. For the service without a graphical login, see `loginctl enable-linger`.
4. Play a game — when it closes, use **Session** to review clips.
5. Open a clip to trim or compress (**create a copy** or replace the original).

## Stack

Tauri 2 · React / TypeScript · FFmpeg · SQLite — **Linux**

## License note

The bundled FFmpeg build enables **GPL** because it links **libx264**. See [docs/BUILD.md](docs/BUILD.md) before redistributing.
