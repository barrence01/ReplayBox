import { useMemo } from "react";
import type { Recording } from "../types";
import { RecordingGrid } from "../components/RecordingGrid";

interface Props {
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

export function SessionView({ allRecordings, onOpen }: Props) {
  const todayRecordings = useMemo(
    () => allRecordings.filter((r) => isLocalToday(recordingDayKey(r))),
    [allRecordings],
  );

  return (
    <section className="view">
      <header className="view__header">
        <div>
          <h1>Session</h1>
          <p>Recordings from today.</p>
        </div>
      </header>

      <RecordingGrid
        recordings={todayRecordings}
        emptyMessage="No recordings from today."
        onOpen={onOpen}
      />
    </section>
  );
}
