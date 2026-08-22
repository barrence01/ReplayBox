import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  cancelJob,
  cancelPreviewJob,
  checkTools,
  clearFinishedJobs,
  clearFinishedPreviewJobs,
  dismissJob,
  dismissPreviewJob,
  getRecording,
  getSettings,
  listJobs,
  listPreviewJobs,
  listRecordings,
  rescanLibrary,
  scanFolder,
  updateSettings,
} from "./lib/api";
import { mergeJob } from "./lib/queueHelpers";
import type {
  CatalogScanFinished,
  CatalogScanStarted,
  JobStatus,
  Recording,
  Settings,
  ViewId,
} from "./types";
import { LibraryView } from "./views/LibraryView";
import { SessionView } from "./views/SessionView";
import { EditorView } from "./views/EditorView";
import { SettingsView } from "./views/SettingsView";
import { QueuesView } from "./views/QueuesView";
import { JobBar } from "./components/JobBar";
import { recordingsInExactDir } from "./lib/libraryFolders";
import { pickNeighborRecording } from "./lib/nextRecordingAfterDelete";
import { sortRecordings } from "./lib/sortRecordings";
import "./App.css";

type ReturnView = Exclude<ViewId, "editor">;

function App() {
  const [view, setView] = useState<ViewId>("library");
  const [returnView, setReturnView] = useState<ReturnView>("library");
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [selected, setSelected] = useState<Recording | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [tools, setTools] = useState({ ffmpeg: false, ffprobe: false });
  const [banner, setBanner] = useState<string | null>(null);
  const [editJobs, setEditJobs] = useState<JobStatus[]>([]);
  const [previewJobs, setPreviewJobs] = useState<JobStatus[]>([]);
  const [fullScanning, setFullScanning] = useState(false);
  const [folderScanningPath, setFolderScanningPath] = useState<string | null>(
    null,
  );

  const refreshLibrary = useCallback(async () => {
    const list = await listRecordings();
    setRecordings(list);
  }, []);

  const refreshQueues = useCallback(async () => {
    try {
      const [edit, preview] = await Promise.all([listJobs(), listPreviewJobs()]);
      setEditJobs(edit);
      setPreviewJobs(preview);
    } catch {
      /* queues may be unavailable during early boot */
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [s, t] = await Promise.all([getSettings(), checkTools()]);
        setSettings(s);
        setTools({ ffmpeg: t[0], ffprobe: t[1] });
        await refreshLibrary();
        await refreshQueues();
      } catch (e) {
        setBanner(String(e));
      }
    })();
  }, [refreshLibrary, refreshQueues]);

  useEffect(() => {
    const unsubs: Array<() => void> = [];

    listen("catalog-updated", () => {
      void refreshLibrary();
      if (selected) {
        void getRecording(selected.id).then((r) => {
          if (r) setSelected(r);
        });
      }
    }).then((u) => unsubs.push(u));

    listen<CatalogScanStarted>("catalog-scan-started", (e) => {
      if (e.payload.kind === "full") {
        setFullScanning(true);
      } else if (e.payload.folderPath) {
        setFolderScanningPath(e.payload.folderPath);
      }
    }).then((u) => unsubs.push(u));

    listen<CatalogScanFinished>("catalog-scan-finished", (e) => {
      if (e.payload.kind === "full") {
        setFullScanning(false);
      } else if (e.payload.folderPath) {
        setFolderScanningPath((current) =>
          current === e.payload.folderPath ? null : current,
        );
      }
      if (e.payload.status === "error" && e.payload.message) {
        setBanner(e.payload.message);
      }
    }).then((u) => unsubs.push(u));

    listen<JobStatus>("job-updated", (e) => {
      setEditJobs((prev) => mergeJob(prev, e.payload));
    }).then((u) => unsubs.push(u));

    listen<JobStatus>("job-progress", (e) => {
      setEditJobs((prev) => mergeJob(prev, e.payload));
    }).then((u) => unsubs.push(u));

    listen<JobStatus>("preview-updated", (e) => {
      setPreviewJobs((prev) => mergeJob(prev, e.payload));
    }).then((u) => unsubs.push(u));

    return () => {
      unsubs.forEach((u) => u());
    };
  }, [refreshLibrary, selected]);

  useEffect(() => {
    if (view === "queues") {
      void refreshQueues();
    }
  }, [view, refreshQueues]);

  function openRecording(recording: Recording) {
    if (view !== "editor") {
      setReturnView(view);
    }
    setSelected(recording);
    setView("editor");
  }

  function leaveEditor() {
    setSelected(null);
    setView(returnView);
  }

  const folderRecordings = useMemo(() => {
    if (!selected) return [];
    return sortRecordings(
      recordingsInExactDir(recordings, selected.dir),
      "newest",
    );
  }, [recordings, selected]);

  return (
    <div className="app">
      <nav className="nav">
        <div className="brand">ReplayBox</div>
        <button
          type="button"
          className={view === "library" ? "active" : ""}
          onClick={() => setView("library")}
        >
          Library
        </button>
        <button
          type="button"
          className={view === "session" ? "active" : ""}
          onClick={() => setView("session")}
        >
          Session
        </button>
        <button
          type="button"
          className={view === "queues" ? "active" : ""}
          onClick={() => setView("queues")}
        >
          Queues
        </button>
        <button
          type="button"
          className={view === "settings" ? "active" : ""}
          onClick={() => setView("settings")}
        >
          Settings
        </button>
      </nav>

      <div className="app__top">
        <JobBar
          editJobs={editJobs}
          previewJobs={previewJobs}
          onOpenQueues={() => setView("queues")}
        />

        {banner && (
          <div className="banner">
            <span>{banner}</span>
            <button type="button" onClick={() => setBanner(null)}>
              Dismiss
            </button>
          </div>
        )}

        {!tools.ffmpeg || !tools.ffprobe ? (
          <div className="banner banner--warn">
            FFmpeg/FFprobe missing. Install them or set paths in Settings.
          </div>
        ) : null}
      </div>

      <main className="main">
        {view === "library" && settings && (
          <LibraryView
            watchDir={settings.watchDir}
            recordings={recordings}
            onOpen={openRecording}
            fullScanning={fullScanning}
            folderScanningPath={folderScanningPath}
            onRescan={async () => {
              try {
                await rescanLibrary();
              } catch (e) {
                setBanner(String(e));
              }
            }}
            onScanFolder={async (folderPath) => {
              try {
                await scanFolder(folderPath);
              } catch (e) {
                setBanner(String(e));
              }
            }}
          />
        )}
        {view === "library" && !settings && (
          <p className="empty-state">Loading settings…</p>
        )}
        {view === "session" && (
          <SessionView allRecordings={recordings} onOpen={openRecording} />
        )}
        {view === "queues" && (
          <QueuesView
            editJobs={editJobs}
            previewJobs={previewJobs}
            onCancelEdit={async (id) => {
              try {
                await cancelJob(id);
                await refreshQueues();
              } catch (e) {
                setBanner(String(e));
              }
            }}
            onCancelPreview={async (id) => {
              try {
                await cancelPreviewJob(id);
                await refreshQueues();
              } catch (e) {
                setBanner(String(e));
              }
            }}
            onDismissEdit={async (id) => {
              try {
                await dismissJob(id);
                setEditJobs((prev) => prev.filter((j) => j.id !== id));
              } catch (e) {
                setBanner(String(e));
              }
            }}
            onDismissPreview={async (id) => {
              try {
                await dismissPreviewJob(id);
                setPreviewJobs((prev) => prev.filter((j) => j.id !== id));
              } catch (e) {
                setBanner(String(e));
              }
            }}
            onClearEditFinished={async () => {
              try {
                await clearFinishedJobs();
                await refreshQueues();
              } catch (e) {
                setBanner(String(e));
              }
            }}
            onClearPreviewFinished={async () => {
              try {
                await clearFinishedPreviewJobs();
                await refreshQueues();
              } catch (e) {
                setBanner(String(e));
              }
            }}
          />
        )}
        {view === "editor" && selected && (
          <EditorView
            recording={selected}
            folderRecordings={folderRecordings}
            preferNvenc={settings?.preferNvenc ?? true}
            editJobs={editJobs}
            onJobStarted={(job) => {
              setEditJobs((prev) => mergeJob(prev, job));
            }}
            onBack={leaveEditor}
            onOpen={openRecording}
            onDeleted={() => {
              const neighbor = pickNeighborRecording(
                folderRecordings,
                selected.id,
              );
              if (neighbor) {
                openRecording(neighbor);
              } else {
                leaveEditor();
              }
              void refreshLibrary();
              setBanner("Recording deleted.");
            }}
            onMissingFile={async () => {
              try {
                await rescanLibrary();
              } catch {
                /* rescan may fail if ffprobe missing; catalog-updated still fires on finish */
              }
              leaveEditor();
              setBanner(
                "That recording is missing on disk. The library was refreshed.",
              );
            }}
          />
        )}
        {view === "settings" && settings && (
          <SettingsView
            settings={settings}
            tools={tools}
            onSave={async (next) => {
              const saved = await updateSettings(next);
              setSettings(saved);
              const t = await checkTools();
              setTools({ ffmpeg: t[0], ffprobe: t[1] });
            }}
          />
        )}
      </main>
    </div>
  );
}

export default App;
