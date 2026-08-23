import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { Settings } from "../types";
import {
  checkWatchDir,
  clearAllCache,
  clearPlaybackCache,
  getPlaybackCacheLimits,
  getPlaybackCacheStats,
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

export function SettingsView({ settings, tools, onSave }: Props) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [limits, setLimits] = useState<PlaybackCacheLimits | null>(null);
  const [stats, setStats] = useState<PlaybackCacheStats | null>(null);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageIsError, setMessageIsError] = useState(false);
  const [resolved, setResolved] = useState({ ffmpeg: "", ffprobe: "" });

  const refreshCacheInfo = useCallback(async () => {
    const [nextLimits, nextStats] = await Promise.all([
      getPlaybackCacheLimits(),
      getPlaybackCacheStats(),
    ]);
    setLimits(nextLimits);
    setStats(nextStats);
    return { nextLimits, nextStats };
  }, []);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  useEffect(() => {
    refreshCacheInfo().catch(() => {
      setLimits(null);
      setStats(null);
    });
  }, [refreshCacheInfo, settings.playbackCacheMaxGb]);

  useEffect(() => {
    if (!limits) {
      return;
    }
    setDraft((current) => ({
      ...current,
      playbackCacheMaxGb: clampCacheGb(current.playbackCacheMaxGb, limits),
    }));
  }, [limits]);

  useEffect(() => {
    resolvedToolPaths()
      .then(([ffmpeg, ffprobe]) => setResolved({ ffmpeg, ffprobe }))
      .catch(() => setResolved({ ffmpeg: "", ffprobe: "" }));
  }, [settings, tools]);

  async function pickWatchDir() {
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
              <button type="button" onClick={pickWatchDir}>
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
              checked={draft.preferNvenc}
              onChange={(e) =>
                setDraft((d) => ({ ...d, preferNvenc: e.target.checked }))
              }
            />
            Prefer NVENC when available
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
          <label className="settings-field">
            Maximum cache size ({draft.playbackCacheMaxGb} GB)
            <input
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
