import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCatalogSync } from "./hooks/useCatalogSync";
import { useTauriEvent } from "./hooks/useTauriEvent";
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
  updateSettings,
} from "./lib/api";
import { mergeJob } from "./lib/queueHelpers";
import {
  loadRecordingsCache,
  saveRecordingsCache,
} from "./lib/recordingsCache";
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
import { AboutView } from "./views/AboutView";
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
  const [deltaSyncing, setDeltaSyncing] = useState(false);
  const [folderScanningPath, setFolderScanningPath] = useState<string | null>(
    null,
  );
  const [trayHidden, setTrayHidden] = useState(false);
  const [sessionNowMs, setSessionNowMs] = useState(() => Date.now());

  const watchDirRef = useRef<string | null>(null);
  useEffect(() => {
    watchDirRef.current = settings?.watchDir ?? null;
  }, [settings?.watchDir]);

  const libraryReadyRef = useRef(libraryReady);
  useEffect(() => {
    libraryReadyRef.current = libraryReady;
  }, [libraryReady]);

  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  const persistRecordings = useCallback((list: Recording[]) => {
    setRecordings(list);
    setSessionNowMs(Date.now());
    const watchDir = watchDirRef.current;
    if (watchDir) {
      saveRecordingsCache(watchDir, list);
    }
  }, []);

  const refreshLibrary = useCallback(async () => {
    const list = await listRecordings();
    persistRecordings(list);
  }, [persistRecordings]);

  const refreshQueues = useCallback(async () => {
    try {
      const [edit, preview] = await Promise.all([listJobs(), listPreviewJobs()]);
      setEditJobs(edit);
      setPreviewJobs(preview);
    } catch {
      /* queues may be unavailable during early boot */
    }
  }, []);

  const markSyncFinishedRef = useRef<(() => void) | null>(null);

  const { catalogSyncing, syncFromTray, syncFolder, markSyncFinished } =
    useCatalogSync({
      view,
      watchDir: settings?.watchDir ?? null,
      onRecordings: persistRecordings,
      deltaSyncing,
      fullScanning,
      trayHidden,
      onPersistCache: (list) => {
        const watchDir = watchDirRef.current;
        if (watchDir) {
          saveRecordingsCache(watchDir, list);
        }
      },
    });

  useEffect(() => {
    markSyncFinishedRef.current = markSyncFinished;
  }, [markSyncFinished]);

  const goToHome = useCallback(() => {
    setSelected(null);
    setReturnView(HOME_VIEW);
    setView(HOME_VIEW);
    setLibraryResetKey((k) => k + 1);
  }, []);

  const purgeUiForTray = useCallback(() => {
    setTrayHidden(true);
    goToHome();
    const patch = trayPurgePatch();
    setEditJobs(patch.editJobs);
    setPreviewJobs(patch.previewJobs);
  }, [goToHome]);

  const hydrateUiFromTray = useCallback(() => {
    setTrayHidden(false);
    goToHome();
    syncFromTray();
    void refreshQueues();
  }, [goToHome, refreshQueues, syncFromTray]);

  const navigateTo = useCallback((next: ReturnView) => {
    if (next !== "queues") {
      setSelected(null);
    }
    setView(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, t] = await Promise.all([getSettings(), checkTools()]);
        if (cancelled) {
          return;
        }
        setSettings(s);
        watchDirRef.current = s.watchDir;
        setTools({ ffmpeg: t[0], ffprobe: t[1] });

        const cached = loadRecordingsCache(s.watchDir);
        if (cached && cached.length > 0) {
          setRecordings(cached);
          setLibraryReady(true);
        }

        const list = await listRecordings();
        if (cancelled) {
          return;
        }
        persistRecordings(list);
        setLibraryReady(true);
        await refreshQueues();
      } catch (e) {
        if (cancelled) {
          return;
        }
        setBanner(String(e));
        setLibraryReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [persistRecordings, refreshQueues]);

  const catalogDebounceRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (catalogDebounceRef.current !== null) {
        window.clearTimeout(catalogDebounceRef.current);
      }
    };
  }, []);

  useTauriEvent("catalog-updated", () => {
    if (!libraryReadyRef.current) {
      return;
    }
    if (catalogDebounceRef.current !== null) {
      window.clearTimeout(catalogDebounceRef.current);
    }
    catalogDebounceRef.current = window.setTimeout(() => {
      void refreshLibrary();
      const current = selectedRef.current;
      if (!current) {
        return;
      }
      const requestedId = current.id;
      void getRecording(requestedId).then((r) => {
        if (r && selectedRef.current?.id === requestedId) {
          setSelected(r);
        }
      });
    }, 200);
  });

  useTauriEvent<CatalogScanStarted>("catalog-scan-started", (e) => {
    if (e.payload.kind === "full") {
      setFullScanning(true);
    } else if (e.payload.kind === "delta") {
      setDeltaSyncing(true);
    }
    if (e.payload.folderPath) {
      setFolderScanningPath(e.payload.folderPath);
    }
  });

  useTauriEvent<CatalogScanFinished>("catalog-scan-finished", (e) => {
    if (e.payload.kind === "full") {
      setFullScanning(false);
    } else if (e.payload.kind === "delta") {
      setDeltaSyncing(false);
      markSyncFinishedRef.current?.();
      setSessionNowMs(Date.now());
    }
    if (e.payload.folderPath) {
      setFolderScanningPath((current) =>
        current === e.payload.folderPath ? null : current,
      );
    }
    if (e.payload.status === "error" && e.payload.message) {
      setBanner(e.payload.message);
    }
  });

  useTauriEvent<JobStatus>("job-updated", (e) => {
    setEditJobs((prev) => mergeJob(prev, e.payload));
  });

  useTauriEvent<JobStatus>("job-progress", (e) => {
    setEditJobs((prev) => mergeJob(prev, e.payload));
  });

  useTauriEvent<JobStatus>("preview-updated", (e) => {
    setPreviewJobs((prev) => mergeJob(prev, e.payload));
  });

  useTauriEvent("app-to-tray", () => {
    purgeUiForTray();
  });

  useTauriEvent("app-from-tray", () => {
    hydrateUiFromTray();
  });

  useEffect(() => {
    if (view === "queues") {
      void refreshQueues();
    }
  }, [view, refreshQueues]);

  function openRecording(recording: Recording) {
    if (view !== "editor") {
      setReturnView(view as ReturnView);
    }
    setSelected(recording);
    setView("editor");
    void refreshQueues();
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
        <button
          type="button"
          className={view === "about" ? "active" : ""}
          onClick={() => navigateTo("about")}
        >
          About
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
            catalogSyncing={catalogSyncing}
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
            onScanFolder={(folderPath) => {
              syncFolder(folderPath);
            }}
          />
        )}
        {view === "library" && (!settings || !libraryReady) && (
          <p className="empty-state">Loading library…</p>
        )}
        {view === "session" && (
          <SessionView
            allRecordings={recordings}
            nowMs={sessionNowMs}
            catalogSyncing={catalogSyncing}
            onOpen={openRecording}
          />
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
            preferHardwareEncoding={settings?.preferHardwareEncoding ?? true}
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
              watchDirRef.current = saved.watchDir;
              const t = await checkTools();
              setTools({ ffmpeg: t[0], ffprobe: t[1] });
            }}
          />
        )}
        {view === "about" && <AboutView />}
      </main>
    </div>
  );
}

export default App;
