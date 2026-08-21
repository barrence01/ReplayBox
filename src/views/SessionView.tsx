import { useState } from "react";
import type { Recording, Session } from "../types";
import { RecordingGrid } from "../components/RecordingGrid";

interface Props {
  session: Session | null;
  sessionRecordings: Recording[];
  allRecordings: Recording[];
  onOpen: (recording: Recording) => void;
}

export function SessionView({
  session,
  sessionRecordings,
  allRecordings,
  onOpen,
}: Props) {
  const [tab, setTab] = useState<"session" | "all">("session");

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
            className={tab === "all" ? "active" : ""}
            onClick={() => setTab("all")}
          >
            All recordings ({allRecordings.length})
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
          recordings={allRecordings}
          emptyMessage="Library is empty."
          onOpen={onOpen}
        />
      )}
    </section>
  );
}
