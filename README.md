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
- **Time-based trim** — precise (VFR-safe re-encode) or fast (stream copy; may cut on keyframe)
- **Compress** — smaller files for uploads, with optional system NVENC override
- **Bundled FFmpeg** — no system FFmpeg install required for basic use (built from source with cache)

## Quick Start

**From source** — see [docs/BUILD.md](docs/BUILD.md) for host packages, what gets downloaded, and troubleshooting.

```bash
# Development
npm install
npm run tauri:dev

# Full production build
./scripts/build-all.sh
# or: npm run build:all
```

## First run

1. Open **Settings** and confirm the **watch folder** (where your recordings live).
2. Add **game process names** (matched against `/proc`, e.g. `cs2`).
3. Play a game — when it closes, use **Session** to review new clips.
4. Open a clip to trim or compress, then **create a copy** (or replace the original).

## Stack

Tauri 2 · React / TypeScript · FFmpeg · SQLite — **Linux**

## License note

The bundled FFmpeg build enables **GPL** because it links **libx264**. See [docs/BUILD.md](docs/BUILD.md) before redistributing.
