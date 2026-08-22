import { useMemo } from "react";
import type { Recording } from "../types";
import { RecordingGrid } from "../components/RecordingGrid";
import {
  isWithinLast24Hours,
  recordingActivityAt,
} from "../lib/sessionFilter";

interface Props {
  allRecordings: Recording[];
  onOpen: (recording: Recording) => void;
}

export function SessionView({ allRecordings, onOpen }: Props) {
  const sessionRecordings = useMemo(
    () =>
      allRecordings.filter((r) =>
        isWithinLast24Hours(recordingActivityAt(r)),
      ),
    [allRecordings],
  );

  return (
    <section className="view">
      <header className="view__header">
        <div>
          <h1>Session</h1>
          <p>Recordings from the last 24 hours.</p>
        </div>
      </header>

      <RecordingGrid
        recordings={sessionRecordings}
        emptyMessage="No recordings in the last 24 hours."
        onOpen={onOpen}
      />
    </section>
  );
}
