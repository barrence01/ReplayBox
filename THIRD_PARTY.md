# Third-party licenses

ReplayBox application code is licensed under the [MIT License](LICENSE).

The distributed AppImage and bundled tools include additional components under other licenses. Full license texts are vendored in this repository and copied into the AppImage at `usr/share/licenses/replaybox/`.

## Bundled FFmpeg (GPL-2.0)

ReplayBox ships `ffmpeg` and `ffprobe` built from FFmpeg tag **n7.1** with:

- `--enable-gpl`
- `--enable-libx264`
- static linking (`--enable-static --disable-shared`)

Rebuild instructions: [scripts/build-ffmpeg.sh](scripts/build-ffmpeg.sh).

**Corresponding source:** FFmpeg tag `n7.1` from [https://github.com/FFmpeg/FFmpeg](https://github.com/FFmpeg/FFmpeg) (or [https://git.ffmpeg.org/ffmpeg.git](https://git.ffmpeg.org/ffmpeg.git)), plus libx264 from your build host, using the configure flags in `scripts/build-ffmpeg.sh`.

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

**Corresponding source for bundled system libraries:** the Arch Linux packages installed on the build host (e.g. `gstreamer`, `gst-plugins-base`, `gst-plugins-good`, `gst-plugins-bad`, `gst-libav`, `webkit2gtk-4.1`, `gtk3`, `glib2`). Sources are available from [https://archlinux.org/packages/](https://archlinux.org/packages/) and [https://gitlab.archlinux.org/archlinux/packaging/packages/](https://gitlab.archlinux.org/archlinux/packaging/packages/).

## Other dependencies (permissive)

These are used at build time or linked permissively; they do not require GPL/LGPL compliance for ReplayBox application code:

| Component | License |
|-----------|---------|
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
