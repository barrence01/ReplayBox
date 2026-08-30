# Third-party licenses

ReplayBox application code is licensed under the [MIT License](LICENSE).

The distributed AppImage and bundled tools include additional components under other licenses. Full license texts are vendored in this repository and copied into the AppImage at `usr/share/licenses/replaybox/`.

## Bundled FFmpeg (GPL-2.0)

ReplayBox ships `ffmpeg` and `ffprobe` built from FFmpeg tag **n7.1** with:

- `--enable-gpl`
- `--enable-libx264`
- `--enable-nvenc`
- `--enable-vaapi`
- static linking (`--enable-static --disable-shared`)

Rebuild instructions: [scripts/build-ffmpeg.sh](scripts/build-ffmpeg.sh).

**Corresponding source:** FFmpeg tag `n7.1` from [https://github.com/FFmpeg/FFmpeg](https://github.com/FFmpeg/FFmpeg) (or [https://git.ffmpeg.org/ffmpeg.git](https://git.ffmpeg.org/ffmpeg.git)), plus libx264 and libva from your build host, and [nv-codec-headers](https://github.com/FFmpeg/nv-codec-headers) (build-time only), using the configure flags in `scripts/build-ffmpeg.sh`.

NVENC and VAAPI encoders call into **host GPU drivers** at runtime; they are not redistributed inside the AppImage.

License text: [licenses/GPL-2.0.txt](licenses/GPL-2.0.txt).

## libx264 (GPL-2.0)

The bundled FFmpeg binaries link **libx264** statically. libx264 is GPL-2.0. License text: [licenses/GPL-2.0.txt](licenses/GPL-2.0.txt).

## AppImage media stack (LGPL-2.1)

The Linux AppImage bundles dynamic libraries for in-app video playback and the desktop shell, including:

- **GStreamer** plugins (curated set; includes `libgstlibav.so`)
- **WebKitGTK**
- **GTK / GLib** and related dependencies

`gst-libav` links against the **host system's FFmpeg** at build time (not the bundled static FFmpeg above).

License text: [licenses/LGPL-2.1.txt](licenses/LGPL-2.1.txt).

**Corresponding source for bundled system libraries:** Ubuntu 22.04 packages in the container build environment (e.g. `gstreamer1.0-plugins-base`, `gstreamer1.0-plugins-good`, `gstreamer1.0-plugins-bad`, `gstreamer1.0-libav`, `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libglib2.0-0`). Sources are available from [https://packages.ubuntu.com/jammy/](https://packages.ubuntu.com/jammy/).

## Other dependencies (permissive)

These are used at build time or linked permissively; they do not require GPL/LGPL compliance for ReplayBox application code:

| Component | License |
|-----------|---------|
| nv-codec-headers (FFmpeg NVENC build) | MIT |
| libva (FFmpeg VAAPI build) | MIT |
| React, Vite, TypeScript tooling | MIT |
| Tauri and Rust crates (see `Cargo.lock`) | MIT / Apache-2.0 / similar |
| SQLite (`rusqlite` with `bundled`) | Public domain |

## AppImage license path

When installed from an AppImage, license files are at:

```
usr/share/licenses/replaybox/LICENSE
usr/share/licenses/replaybox/THIRD_PARTY.md
usr/share/licenses/replaybox/GPL-2.0.txt
usr/share/licenses/replaybox/LGPL-2.1.txt
```

Extract with: `./ReplayBox-*.AppImage --appimage-extract`
