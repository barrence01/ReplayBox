import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { BackgroundServiceStatus, Settings } from "../types";
import {
  backgroundServiceStatus,
  checkWatchDir,
  resolvedToolPaths,
} from "../lib/api";

interface Props {
  settings: Settings;
  tools: { ffmpeg: boolean; ffprobe: boolean };
  onSave: (settings: Settings) => Promise<void>;
}

export function SettingsView({ settings, tools, onSave }: Props) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [processInput, setProcessInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageIsError, setMessageIsError] = useState(false);
  const [resolved, setResolved] = useState({ ffmpeg: "", ffprobe: "" });
  const [serviceStatus, setServiceStatus] =
    useState<BackgroundServiceStatus | null>(null);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  useEffect(() => {
    resolvedToolPaths()
      .then(([ffmpeg, ffprobe]) => setResolved({ ffmpeg, ffprobe }))
      .catch(() => setResolved({ ffmpeg: "", ffprobe: "" }));
  }, [settings, tools]);

  useEffect(() => {
    backgroundServiceStatus()
      .then(setServiceStatus)
      .catch(() => setServiceStatus(null));
  }, [settings.backgroundServiceEnabled, message]);

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

  function addProcess() {
    const name = processInput.trim();
    if (!name) return;
    if (draft.gameProcessNames.includes(name)) {
      setProcessInput("");
      return;
    }
    setDraft((d) => ({
      ...d,
      gameProcessNames: [...d.gameProcessNames, name],
    }));
    setProcessInput("");
  }

  function removeProcess(name: string) {
    setDraft((d) => ({
      ...d,
      gameProcessNames: d.gameProcessNames.filter((n) => n !== name),
    }));
  }

  async function handleSave() {
    if (!draft.watchDir.trim()) {
      setMessage("Watch folder path is empty.");
      setMessageIsError(true);
      return;
    }

    setSaving(true);
    setMessage(null);
    setMessageIsError(false);
    try {
      await checkWatchDir(draft.watchDir);
      await onSave(draft);
      setMessage("Settings saved.");
      setMessageIsError(false);
    } catch (e) {
      setMessage(String(e));
      setMessageIsError(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="view">
      <header className="view__header">
        <div>
          <h1>Settings</h1>
          <p>Watch folder, FFmpeg tools, and game process detection.</p>
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
          <h2>Game detection</h2>
          <p className="hint settings-section__desc">
            Names matched against <code>/proc/*/comm</code> and cmdline (case
            insensitive substring). Example: <code>cs2</code>,{" "}
            <code>dota2</code>.
          </p>
          <div className="settings-field">
            <div className="row-input">
              <input
                value={processInput}
                placeholder="Process name…"
                onChange={(e) => setProcessInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addProcess();
                  }
                }}
              />
              <button type="button" onClick={addProcess}>
                Add
              </button>
            </div>
            <ul className="chip-list">
              {draft.gameProcessNames.map((name) => (
                <li key={name}>
                  <span>{name}</span>
                  <button type="button" onClick={() => removeProcess(name)}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="settings-subsection">
            <label className="check">
              <input
                type="checkbox"
                checked={draft.backgroundServiceEnabled}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    backgroundServiceEnabled: e.target.checked,
                  }))
                }
              />
              Run background service
            </label>
            <p className="hint">
              When enabled, indexing and game sessions continue via{" "}
              <code>replayboxd</code> (systemd user unit) while the app is
              closed. The daemon is installed under your app data directory so
              the unit stays valid for AppImage installs. Use{" "}
              <code>npm run tauri:dev</code> or <code>npm run stage:daemon</code>{" "}
              so the binary exists, then Save settings to apply. For the service
              without a logged-in session, see{" "}
              <code>loginctl enable-linger</code>.
            </p>
            {serviceStatus && (
              <p
                className={
                  serviceStatus.unitActive === draft.backgroundServiceEnabled
                    ? "ok"
                    : "hint"
                }
              >
                Status: {serviceStatus.message}
              </p>
            )}
          </div>
        </section>

        <div className="settings-actions">
          <button type="button" disabled={saving} onClick={handleSave}>
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
