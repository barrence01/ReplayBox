import { useMemo, useState } from "react";
import type { Recording, Session } from "../types";
import { RecordingGrid } from "../components/RecordingGrid";

interface Props {
  session: Session | null;
  sessionRecordings: Recording[];
  allRecordings: Recording[];
  onOpen: (recording: Recording) => void;
}

function recordingDayKey(recording: Recording): string {
  return recording.modifiedAt ?? recording.createdAt ?? recording.indexedAt;
}

function isLocalToday(iso: string): boolean {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

export function SessionView({
  session,
  sessionRecordings,
  allRecordings,
  onOpen,
}: Props) {
  const [tab, setTab] = useState<"session" | "today">("session");

  const todayRecordings = useMemo(
    () => allRecordings.filter((r) => isLocalToday(recordingDayKey(r))),
    [allRecordings],
  );

  return (
    <section className="view">
      <header className="view__header">
        <div>
          <h1>Session</h1>
          <p>
            {session
              ? `Game: ${session.gameProcess ?? "unknown"}${
                  session.endedAt ? " · ended" : " · active"
                }`
              : "No recent game session. Clips appear here when a watched game closes."}
          </p>
        </div>
        <div className="tabs">
          <button
            type="button"
            className={tab === "session" ? "active" : ""}
            onClick={() => setTab("session")}
          >
            Session clips ({sessionRecordings.length})
          </button>
          <button
            type="button"
            className={tab === "today" ? "active" : ""}
            onClick={() => setTab("today")}
          >
            Today ({todayRecordings.length})
          </button>
        </div>
      </header>

      {tab === "session" ? (
        <RecordingGrid
          recordings={sessionRecordings}
          emptyMessage="No clips were captured during this session."
          onOpen={onOpen}
        />
      ) : (
        <RecordingGrid
          recordings={todayRecordings}
          emptyMessage="No recordings from today."
          onOpen={onOpen}
        />
      )}
    </section>
  );
}
