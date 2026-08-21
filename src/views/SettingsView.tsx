import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { Settings } from "../types";
import { resolvedToolPaths } from "../lib/api";

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
  const [resolved, setResolved] = useState({ ffmpeg: "", ffprobe: "" });

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

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
    if (typeof selected === "string") {
      setDraft((d) => ({ ...d, watchDir: selected }));
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

  return (
    <section className="view">
      <header className="view__header">
        <div>
          <h1>Settings</h1>
          <p>Watch folder, FFmpeg tools, and game process detection.</p>
        </div>
      </header>

      <div className="settings-form">
        <label className="stack-label">
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

        <label className="stack-label">
          FFmpeg path
          <input
            value={draft.ffmpegPath}
            placeholder="Leave empty to use bundled FFmpeg"
            onChange={(e) =>
              setDraft((d) => ({ ...d, ffmpegPath: e.target.value }))
            }
          />
          <span className={tools.ffmpeg ? "ok" : "error"}>
            {tools.ffmpeg ? "Found" : "Not found"}
          </span>
          {resolved.ffmpeg && (
            <span className="hint path">Resolved: {resolved.ffmpeg}</span>
          )}
        </label>

        <label className="stack-label">
          FFprobe path
          <input
            value={draft.ffprobePath}
            placeholder="Leave empty to use bundled FFprobe"
            onChange={(e) =>
              setDraft((d) => ({ ...d, ffprobePath: e.target.value }))
            }
          />
          <span className={tools.ffprobe ? "ok" : "error"}>
            {tools.ffprobe ? "Found" : "Not found"}
          </span>
          {resolved.ffprobe && (
            <span className="hint path">Resolved: {resolved.ffprobe}</span>
          )}
        </label>

        <label className="stack-label">
          Default compress CRF ({draft.compressCrf})
          <input
            type="range"
            min={18}
            max={32}
            value={draft.compressCrf}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                compressCrf: Number(e.target.value),
              }))
            }
          />
        </label>

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

        <div>
          <h2>Game processes</h2>
          <p className="hint">
            Names matched against <code>/proc/*/comm</code> and cmdline (case
            insensitive substring). Example: <code>cs2</code>,{" "}
            <code>dota2</code>.
          </p>
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

        <button
          type="button"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            setMessage(null);
            try {
              await onSave(draft);
              setMessage("Settings saved.");
            } catch (e) {
              setMessage(String(e));
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? "Saving…" : "Save settings"}
        </button>
        {message && <p className="hint">{message}</p>}
      </div>
    </section>
  );
}
