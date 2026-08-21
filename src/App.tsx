import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  cancelJob,
  checkTools,
  drainDaemonEvents,
  getRecording,
  getSettings,
  listRecordings,
  listSessionRecordings,
  rescanLibrary,
  updateSettings,
} from "./lib/api";
import type {
  DaemonEvent,
  JobStatus,
  Recording,
  Session,
  SessionEndedEvent,
  Settings,
  ViewId,
} from "./types";
import { LibraryView } from "./views/LibraryView";
import { SessionView } from "./views/SessionView";
import { EditorView } from "./views/EditorView";
import { SettingsView } from "./views/SettingsView";
import { JobBar } from "./components/JobBar";
import { recordingsInExactDir } from "./lib/libraryFolders";
import { sortRecordings } from "./lib/sortRecordings";
import "./App.css";

function App() {
  const [view, setView] = useState<ViewId>("library");
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [sessionRecordings, setSessionRecordings] = useState<Recording[]>([]);
  const [selected, setSelected] = useState<Recording | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [tools, setTools] = useState({ ffmpeg: false, ffprobe: false });
  const [banner, setBanner] = useState<string | null>(null);
  const [job, setJob] = useState<JobStatus | null>(null);

  const refreshLibrary = useCallback(async () => {
    const list = await listRecordings();
    setRecordings(list);
  }, []);

  const refreshSessionClips = useCallback(async (sessionId: string) => {
    const list = await listSessionRecordings(sessionId);
    setSessionRecordings(list);
  }, []);

  const handleDaemonEvent = useCallback(
    (event: DaemonEvent) => {
      if (event.type === "catalogUpdated") {
        void refreshLibrary();
        return;
      }
      if (event.type === "sessionStarted") {
        setSession(event.session);
        setBanner(
          `Game session started: ${event.session.gameProcess ?? "game"}`,
        );
        return;
      }
      if (event.type === "sessionEnded") {
        setSession(event.session);
        void refreshSessionClips(event.session.id);
        setView("session");
        setBanner(
          `Game closed — ${event.recordingCount} clip(s) in this session.`,
        );
      }
    },
    [refreshLibrary, refreshSessionClips],
  );

  useEffect(() => {
    (async () => {
      try {
        const [s, t] = await Promise.all([getSettings(), checkTools()]);
        setSettings(s);
        setTools({ ffmpeg: t[0], ffprobe: t[1] });
        await refreshLibrary();
      } catch (e) {
        setBanner(String(e));
      }
    })();
  }, [refreshLibrary]);

  useEffect(() => {
    const unsubs: Array<() => void> = [];

    listen("catalog-updated", () => {
      void refreshLibrary();
      if (session) {
        void refreshSessionClips(session.id);
      }
      if (selected) {
        void getRecording(selected.id).then((r) => {
          if (r) setSelected(r);
        });
      }
    }).then((u) => unsubs.push(u));

    listen<Session>("session-started", (e) => {
      setSession(e.payload);
      setBanner(`Game session started: ${e.payload.gameProcess ?? "game"}`);
    }).then((u) => unsubs.push(u));

    listen<SessionEndedEvent>("session-ended", (e) => {
      setSession(e.payload.session);
      void refreshSessionClips(e.payload.session.id);
      setView("session");
      setBanner(
        `Game closed — ${e.payload.recordingCount} clip(s) in this session.`,
      );
    }).then((u) => unsubs.push(u));

    listen<JobStatus>("job-progress", (e) => {
      setJob(e.payload);
    }).then((u) => unsubs.push(u));

    return () => {
      unsubs.forEach((u) => u());
    };
  }, [refreshLibrary, refreshSessionClips, session, selected]);

  useEffect(() => {
    if (!settings?.backgroundServiceEnabled) return;
    const id = window.setInterval(() => {
      void drainDaemonEvents()
        .then((events) => {
          for (const event of events) {
            handleDaemonEvent(event);
            if (event.type === "catalogUpdated" && session) {
              void refreshSessionClips(session.id);
            }
            if (event.type === "catalogUpdated" && selected) {
              void getRecording(selected.id).then((r) => {
                if (r) setSelected(r);
              });
            }
          }
        })
        .catch(() => {});
    }, 2000);
    return () => window.clearInterval(id);
  }, [
    settings?.backgroundServiceEnabled,
    handleDaemonEvent,
    session,
    selected,
    refreshSessionClips,
  ]);

  function openRecording(recording: Recording) {
    setSelected(recording);
    setView("editor");
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
          className={view === "settings" ? "active" : ""}
          onClick={() => setView("settings")}
        >
          Settings
        </button>
      </nav>

      <JobBar
        job={job}
        onCancel={async (id) => {
          try {
            await cancelJob(id);
          } catch (e) {
            setBanner(String(e));
          }
        }}
        onDismiss={() => setJob(null)}
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

      <main className="main">
        {view === "library" && settings && (
          <LibraryView
            watchDir={settings.watchDir}
            recordings={recordings}
            onOpen={openRecording}
            onRefresh={refreshLibrary}
            onRescan={async () => {
              await rescanLibrary();
              await refreshLibrary();
            }}
          />
        )}
        {view === "library" && !settings && (
          <p className="empty-state">Loading settings…</p>
        )}
        {view === "session" && (
          <SessionView
            session={session}
            sessionRecordings={sessionRecordings}
            allRecordings={recordings}
            onOpen={openRecording}
          />
        )}
        {view === "editor" && selected && (
          <EditorView
            recording={selected}
            folderRecordings={folderRecordings}
            preferNvenc={settings?.preferNvenc ?? true}
            jobRunning={job?.status === "running"}
            onJobStarted={setJob}
            onBack={() => setView("library")}
            onOpen={openRecording}
            onDeleted={() => {
              setSelected(null);
              setView("library");
              void refreshLibrary();
              setBanner("Recording deleted.");
            }}
            onMissingFile={async () => {
              try {
                await rescanLibrary();
                await refreshLibrary();
              } catch {
                await refreshLibrary();
              }
              setSelected(null);
              setView("library");
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
