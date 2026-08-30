import { useCallback, useEffect, useRef, useState } from "react";
import { useRequestGeneration } from "../hooks/useRequestGeneration";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import type { HardwareEncodingStatus, Settings, VideoEncoder } from "../types";
import {
  checkWatchDir,
  clearAllCache,
  clearPlaybackCache,
  getLogDir,
  getPlaybackCacheLimits,
  getPlaybackCacheStats,
  hardwareEncodingStatus,
  resolvedToolPaths,
  type PlaybackCacheLimits,
  type PlaybackCacheStats,
} from "../lib/api";
import { formatCacheUsage } from "../lib/format";

interface Props {
  settings: Settings;
  tools: { ffmpeg: boolean; ffprobe: boolean };
  onSave: (settings: Settings) => Promise<void>;
}

function clampCacheGb(value: number, limits: PlaybackCacheLimits): number {
  if (!limits.enabled) {
    return 0;
  }
  return Math.min(Math.max(value, 1), limits.maxGb);
}

function resolveDisplayEncoder(
  status: HardwareEncodingStatus,
  preferHardwareEncoding: boolean,
): VideoEncoder {
  if (!preferHardwareEncoding) {
    return "software";
  }
  if (status.nvencRuntime) {
    return "nvenc";
  }
  if (status.vaapiRuntime) {
    return "vaapi";
  }
  return "software";
}

function activeEncoderLabel(active: VideoEncoder): string {
  switch (active) {
    case "nvenc":
      return "NVENC";
    case "vaapi":
      return "VAAPI";
    default:
      return "Software";
  }
}

export function SettingsView({ settings, tools, onSave }: Props) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [limits, setLimits] = useState<PlaybackCacheLimits | null>(null);
  const [stats, setStats] = useState<PlaybackCacheStats | null>(null);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageIsError, setMessageIsError] = useState(false);
  const [resolved, setResolved] = useState({ ffmpeg: "", ffprobe: "" });
  const [logDir, setLogDir] = useState("");
  const [hwStatus, setHwStatus] = useState<HardwareEncodingStatus | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const cacheClampAppliedRef = useRef(false);
  const cacheInfoGen = useRequestGeneration();
  const toolsProbeGen = useRequestGeneration();
  const { nextGeneration: nextCacheGen, isCurrent: isCacheCurrent, invalidate: invalidateCacheGen } =
    cacheInfoGen;
  const {
    nextGeneration: nextToolsGen,
    isCurrent: isToolsCurrent,
    invalidate: invalidateToolsGen,
  } = toolsProbeGen;

  const refreshCacheInfo = useCallback(async () => {
    const gen = nextCacheGen();
    const [nextLimits, nextStats] = await Promise.all([
      getPlaybackCacheLimits(),
      getPlaybackCacheStats(),
    ]);
    if (!isCacheCurrent(gen)) {
      return { nextLimits, nextStats };
    }
    setLimits(nextLimits);
    setStats(nextStats);
    return { nextLimits, nextStats };
  }, [nextCacheGen, isCacheCurrent]);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  useEffect(() => {
    const gen = nextCacheGen();
    refreshCacheInfo().catch(() => {
      if (!isCacheCurrent(gen)) {
        return;
      }
      setLimits(null);
      setStats(null);
    });
    return () => {
      invalidateCacheGen();
    };
  }, [refreshCacheInfo, settings.playbackCacheMaxGb, nextCacheGen, isCacheCurrent, invalidateCacheGen]);

  useEffect(() => {
    if (!limits || cacheClampAppliedRef.current) {
      return;
    }
    cacheClampAppliedRef.current = true;
    setDraft((current) => ({
      ...current,
      playbackCacheMaxGb: clampCacheGb(current.playbackCacheMaxGb, limits),
    }));
  }, [limits]);

  useEffect(() => {
    const gen = nextToolsGen();
    resolvedToolPaths()
      .then(([ffmpeg, ffprobe]) => {
        if (!isToolsCurrent(gen)) {
          return;
        }
        setResolved({ ffmpeg, ffprobe });
      })
      .catch(() => {
        if (!isToolsCurrent(gen)) {
          return;
        }
        setResolved({ ffmpeg: "", ffprobe: "" });
      });
    getLogDir()
      .then((dir) => {
        if (!isToolsCurrent(gen)) {
          return;
        }
        setLogDir(dir);
      })
      .catch(() => {
        if (!isToolsCurrent(gen)) {
          return;
        }
        setLogDir("");
      });
    hardwareEncodingStatus()
      .then((status) => {
        if (!isToolsCurrent(gen)) {
          return;
        }
        setHwStatus(status);
      })
      .catch(() => {
        if (!isToolsCurrent(gen)) {
          return;
        }
        setHwStatus(null);
      });
    return () => {
      invalidateToolsGen();
    };
  }, [
    settings.ffmpegPath,
    settings.ffprobePath,
    tools,
    nextToolsGen,
    isToolsCurrent,
    invalidateToolsGen,
  ]);

  async function pickWatchDir() {
    if (browsing) {
      return;
    }
    setBrowsing(true);
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select recordings folder",
      });
      if (typeof selected !== "string") {
        return;
      }
      try {
        await checkWatchDir(selected);
        setDraft((d) => ({ ...d, watchDir: selected }));
        setMessage(null);
        setMessageIsError(false);
      } catch (e) {
        setMessage(String(e));
        setMessageIsError(true);
      }
    } finally {
      setBrowsing(false);
    }
  }

  async function handleSave() {
    if (!draft.watchDir.trim()) {
      setMessage("Watch folder path is empty.");
      setMessageIsError(true);
      return;
    }

    if (!limits) {
      setMessage("Could not load preview cache limits.");
      setMessageIsError(true);
      return;
    }

    const cacheGb = clampCacheGb(draft.playbackCacheMaxGb, limits);
    if (cacheGb !== draft.playbackCacheMaxGb) {
      setDraft((d) => ({ ...d, playbackCacheMaxGb: cacheGb }));
    }

    if (limits.enabled && (cacheGb < 1 || cacheGb > limits.maxGb)) {
      setMessage(
        `Preview cache limit must be between 1 and ${limits.maxGb} GB.`,
      );
      setMessageIsError(true);
      return;
    }

    if (!limits.enabled && cacheGb !== 0) {
      setMessage("Preview cache is unavailable due to insufficient disk space.");
      setMessageIsError(true);
      return;
    }

    if (draft.previewCrf < 18 || draft.previewCrf > 35) {
      setMessage("Preview CRF must be between 18 and 35.");
      setMessageIsError(true);
      return;
    }

    const allowedScales = [1, 2, 4];
    if (!allowedScales.includes(draft.previewScale)) {
      setMessage("Preview scale must be Original, 1/2, or 1/4.");
      setMessageIsError(true);
      return;
    }

    setSaving(true);
    setMessage(null);
    setMessageIsError(false);
    try {
      await checkWatchDir(draft.watchDir);
      const payload = { ...draft, playbackCacheMaxGb: cacheGb };
      await onSave(payload);
      await refreshCacheInfo();
      setMessage("Settings saved.");
      setMessageIsError(false);
    } catch (e) {
      setMessage(String(e));
      setMessageIsError(true);
    } finally {
      setSaving(false);
    }
  }

  async function handleClearVideoCache() {
    if (
      !window.confirm(
        "Remove all preview cache files? Previews may take longer until rebuilt.",
      )
    ) {
      return;
    }

    setClearing(true);
    setMessage(null);
    setMessageIsError(false);
    try {
      await clearPlaybackCache();
      await refreshCacheInfo();
      setMessage("Video cache cleared.");
      setMessageIsError(false);
    } catch (e) {
      setMessage(String(e));
      setMessageIsError(true);
    } finally {
      setClearing(false);
    }
  }

  async function handleOpenLogsFolder() {
    setMessage(null);
    setMessageIsError(false);
    try {
      const dir = logDir || (await getLogDir());
      await openPath(dir);
    } catch (e) {
      setMessage(String(e));
      setMessageIsError(true);
    }
  }

  async function handleClearAllCache() {
    if (
      !window.confirm(
        "Remove all preview cache and thumbnail files? Thumbnails will regenerate on the next library scan.",
      )
    ) {
      return;
    }

    setClearing(true);
    setMessage(null);
    setMessageIsError(false);
    try {
      await clearAllCache();
      await refreshCacheInfo();
      setMessage("All cache cleared.");
      setMessageIsError(false);
    } catch (e) {
      setMessage(String(e));
      setMessageIsError(true);
    } finally {
      setClearing(false);
    }
  }

  const cacheBusy = saving || clearing;
  const usageLabel =
    stats != null
      ? formatCacheUsage(stats.usedBytes, draft.playbackCacheMaxGb)
      : "—";

  const displayEncoder =
    hwStatus == null
      ? null
      : resolveDisplayEncoder(hwStatus, draft.preferHardwareEncoding);

  return (
    <section className="view">
      <header className="view__header">
        <div>
          <h1>Settings</h1>
          <p>Watch folder, FFmpeg tools, preview cache, and startup options.</p>
        </div>
      </header>

      <div className="settings-form">
        <section className="settings-section">
          <h2>Library</h2>
          <label className="settings-field">
            Watch folder
            <div className="row-input">
              <input
                value={draft.watchDir}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, watchDir: e.target.value }))
                }
              />
              <button type="button" onClick={() => void pickWatchDir()} disabled={browsing}>
                Browse…
              </button>
            </div>
          </label>
        </section>

        <section className="settings-section">
          <h2>FFmpeg tools</h2>
          <label className="settings-field">
            FFmpeg path
            <input
              value={draft.ffmpegPath}
              placeholder="Leave empty to use bundled FFmpeg"
              onChange={(e) =>
                setDraft((d) => ({ ...d, ffmpegPath: e.target.value }))
              }
            />
            <span className="settings-field-meta">
              <span className={tools.ffmpeg ? "ok" : "error"}>
                {tools.ffmpeg ? "Found" : "Not found"}
              </span>
              {resolved.ffmpeg && (
                <span className="hint path">Resolved: {resolved.ffmpeg}</span>
              )}
            </span>
          </label>

          <label className="settings-field">
            FFprobe path
            <input
              value={draft.ffprobePath}
              placeholder="Leave empty to use bundled FFprobe"
              onChange={(e) =>
                setDraft((d) => ({ ...d, ffprobePath: e.target.value }))
              }
            />
            <span className="settings-field-meta">
              <span className={tools.ffprobe ? "ok" : "error"}>
                {tools.ffprobe ? "Found" : "Not found"}
              </span>
              {resolved.ffprobe && (
                <span className="hint path">Resolved: {resolved.ffprobe}</span>
              )}
            </span>
          </label>
        </section>

        <section className="settings-section">
          <h2>Encoding</h2>
          <label className="check">
            <input
              type="checkbox"
              checked={draft.preferHardwareEncoding}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  preferHardwareEncoding: e.target.checked,
                }))
              }
            />
            Prefer hardware encoding when available
          </label>
          <p className="settings-field-meta">
            Encoder:{" "}
            <span
              className={
                displayEncoder != null && displayEncoder !== "software"
                  ? "ok"
                  : undefined
              }
            >
              {displayEncoder == null
                ? "Checking…"
                : activeEncoderLabel(displayEncoder)}
            </span>
          </p>
        </section>

        <section className="settings-section">
          <h2>Preview</h2>
          <label className="settings-field" htmlFor="preview-crf">
            Preview quality (CRF {draft.previewCrf})
            <input
              id="preview-crf"
              type="range"
              min={18}
              max={35}
              step={1}
              value={draft.previewCrf}
              disabled={cacheBusy}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  previewCrf: Number(e.target.value),
                }))
              }
            />
            <span className="settings-field-meta hint">
              Higher values use less bitrate (lower visual quality). Speed is
              mostly set by resolution and 30 fps encode.
            </span>
          </label>

          <label className="settings-field" htmlFor="preview-scale">
            Preview resolution
            <select
              id="preview-scale"
              value={draft.previewScale}
              disabled={cacheBusy}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  previewScale: Number(e.target.value),
                }))
              }
            >
              <option value={1}>Original</option>
              <option value={2}>1/2</option>
              <option value={4}>1/4</option>
            </select>
            <span className="settings-field-meta hint">
              Relative to the source. Previews encode at 30 fps for faster
              preparation.
            </span>
          </label>
        </section>

        <section className="settings-section">
          <h2>Preview cache</h2>
          <p className="settings-cache-usage">{usageLabel}</p>
          {limits && !limits.enabled && (
            <p className="settings-field-meta error">
              Preview cache unavailable — less than 1 GB free on this disk.
            </p>
          )}
          <label className="settings-field" htmlFor="playback-cache-max-gb">
            Maximum cache size ({draft.playbackCacheMaxGb} GB)
            <input
              id="playback-cache-max-gb"
              type="range"
              min={1}
              max={limits?.maxGb ?? 1}
              step={1}
              value={limits?.enabled ? draft.playbackCacheMaxGb || 1 : 1}
              disabled={!limits?.enabled || cacheBusy}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  playbackCacheMaxGb: Number(e.target.value),
                }))
              }
            />
            <span className="settings-field-meta hint">
              Stored in ~/.cache/org.replaybox/playback/
            </span>
          </label>
          <div className="settings-cache-actions">
            <button
              type="button"
              disabled={cacheBusy}
              onClick={handleClearVideoCache}
            >
              Clear video cache
            </button>
            <button
              type="button"
              className="secondary"
              disabled={cacheBusy}
              onClick={handleClearAllCache}
            >
              Clear all cache
            </button>
          </div>
        </section>

        <section className="settings-section">
          <h2>Startup</h2>
          <label className="check">
            <input
              type="checkbox"
              checked={draft.launchOnStartup}
              onChange={(e) =>
                setDraft((d) => ({ ...d, launchOnStartup: e.target.checked }))
              }
            />
            Start ReplayBox in the tray when you log in
          </label>
        </section>

        <section className="settings-section">
          <h2>Diagnostics</h2>
          <p className="settings-field-meta hint">
            Daily replaybox.log and ffmpeg.log files are kept for 7 days.
          </p>
          {logDir && (
            <p className="settings-field-meta hint path">Logs: {logDir}</p>
          )}
          <div className="settings-cache-actions">
            <button type="button" onClick={() => void handleOpenLogsFolder()}>
              Open logs folder
            </button>
          </div>
        </section>

        <div className="settings-actions">
          <button type="button" disabled={cacheBusy} onClick={handleSave}>
            {saving ? "Saving…" : "Save settings"}
          </button>
          {message && (
            <p className={messageIsError ? "error" : "hint"}>{message}</p>
          )}
        </div>
      </div>
    </section>
  );
}
