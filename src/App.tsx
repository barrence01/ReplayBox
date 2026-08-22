import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  cancelJob,
  cancelPreviewForRecording,
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
import { HOME_VIEW, trayPurgePatch } from "./lib/trayUiState";
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
  const [view, setView] = useState<ViewId>(HOME_VIEW);
  const [returnView, setReturnView] = useState<ReturnView>(HOME_VIEW);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [selected, setSelected] = useState<Recording | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [libraryReady, setLibraryReady] = useState(false);
  const [libraryResetKey, setLibraryResetKey] = useState(0);
  const [tools, setTools] = useState({ ffmpeg: false, ffprobe: false });
  const [banner, setBanner] = useState<string | null>(null);
  const [editJobs, setEditJobs] = useState<JobStatus[]>([]);
  const [previewJobs, setPreviewJobs] = useState<JobStatus[]>([]);
  const [fullScanning, setFullScanning] = useState(false);
  const [folderScanningPath, setFolderScanningPath] = useState<string | null>(
    null,
  );

  const libraryReadyRef = useRef(libraryReady);
  useEffect(() => {
    libraryReadyRef.current = libraryReady;
  }, [libraryReady]);

  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

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

  const releaseEditorResources = useCallback((recordingId: string | null) => {
    if (!recordingId) return;
    void cancelPreviewForRecording(recordingId).catch(() => {
      /* preview may already be gone */
    });
  }, []);

  const goToHome = useCallback(() => {
    setSelected((current) => {
      if (current) {
        releaseEditorResources(current.id);
      }
      return null;
    });
    setReturnView(HOME_VIEW);
    setView(HOME_VIEW);
    setLibraryResetKey((k) => k + 1);
  }, [releaseEditorResources]);

  const purgeUiForTray = useCallback(() => {
    goToHome();
    const patch = trayPurgePatch();
    setLibraryReady(patch.libraryReady);
    setRecordings(patch.recordings);
    setEditJobs(patch.editJobs);
    setPreviewJobs(patch.previewJobs);
  }, [goToHome]);

  const hydrateUiFromTray = useCallback(async () => {
    try {
      const [list] = await Promise.all([listRecordings(), refreshQueues()]);
      setRecordings(list);
      setLibraryReady(true);
    } catch (e) {
      setBanner(String(e));
      setLibraryReady(true);
    }
    goToHome();
  }, [goToHome, refreshQueues]);

  const navigateTo = useCallback(
    (next: ReturnView) => {
      setSelected((current) => {
        if (current) {
          releaseEditorResources(current.id);
        }
        return null;
      });
      setView(next);
    },
    [releaseEditorResources],
  );

  useEffect(() => {
    (async () => {
      try {
        const [s, t, list] = await Promise.all([
          getSettings(),
          checkTools(),
          listRecordings(),
        ]);
        setSettings(s);
        setTools({ ffmpeg: t[0], ffprobe: t[1] });
        setRecordings(list);
        setLibraryReady(true);
        await refreshQueues();
      } catch (e) {
        setBanner(String(e));
        setLibraryReady(true);
      }
    })();
  }, [refreshQueues]);

  useEffect(() => {
    const unsubs: Array<() => void> = [];

    listen("catalog-updated", () => {
      if (!libraryReadyRef.current) {
        return;
      }
      void refreshLibrary();
      const current = selectedRef.current;
      if (current) {
        void getRecording(current.id).then((r) => {
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

    listen("app-to-tray", () => {
      purgeUiForTray();
    }).then((u) => unsubs.push(u));

    listen("app-from-tray", () => {
      void hydrateUiFromTray();
    }).then((u) => unsubs.push(u));

    return () => {
      unsubs.forEach((u) => u());
    };
  }, [refreshLibrary, purgeUiForTray, hydrateUiFromTray]);

  useEffect(() => {
    if (view === "queues") {
      void refreshQueues();
    }
  }, [view, refreshQueues]);

  function openRecording(recording: Recording) {
    if (view !== "editor") {
      setReturnView(view as ReturnView);
    }
    setSelected((current) => {
      if (current && current.id !== recording.id) {
        releaseEditorResources(current.id);
      }
      return recording;
    });
    setView("editor");
  }

  function leaveEditor() {
    setSelected((current) => {
      if (current) {
        releaseEditorResources(current.id);
      }
      return null;
    });
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
          className={view === "session" ? "active" : ""}
          onClick={() => navigateTo("session")}
        >
          Session
        </button>
        <button
          type="button"
          className={view === "library" ? "active" : ""}
          onClick={() => navigateTo("library")}
        >
          Library
        </button>
        <button
          type="button"
          className={view === "queues" ? "active" : ""}
          onClick={() => navigateTo("queues")}
        >
          Queues
        </button>
        <button
          type="button"
          className={view === "settings" ? "active" : ""}
          onClick={() => navigateTo("settings")}
        >
          Settings
        </button>
      </nav>

      <div className="app__top">
        <JobBar
          editJobs={editJobs}
          previewJobs={previewJobs}
          onOpenQueues={() => navigateTo("queues")}
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
        {view === "library" && settings && libraryReady && (
          <LibraryView
            key={libraryResetKey}
            watchDir={settings.watchDir}
            recordings={recordings}
            libraryReady={libraryReady}
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
        {view === "library" && (!settings || !libraryReady) && (
          <p className="empty-state">Loading library…</p>
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
