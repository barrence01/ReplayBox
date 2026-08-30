import { useMemo } from "react";
import type { Recording } from "../types";
import { RecordingGrid } from "../components/RecordingGrid";
import {
  isWithinLast24Hours,
  recordingActivityAt,
} from "../lib/sessionFilter";

interface Props {
  allRecordings: Recording[];
  nowMs?: number;
  catalogSyncing?: boolean;
  onOpen: (recording: Recording) => void;
}

export function SessionView({
  allRecordings,
  nowMs = Date.now(),
  catalogSyncing = false,
  onOpen,
}: Props) {
  const sessionRecordings = useMemo(
    () =>
      allRecordings.filter((r) =>
        isWithinLast24Hours(recordingActivityAt(r), nowMs),
      ),
    [allRecordings, nowMs],
  );

  return (
    <section className="view">
      <header className="view__header">
        <div>
          <h1>Session</h1>
          <p>Recordings from the last 24 hours.</p>
        </div>
        {catalogSyncing ? (
          <span className="view__refresh-status" aria-live="polite">
            Updating…
          </span>
        ) : null}
      </header>

      <RecordingGrid
        recordings={sessionRecordings}
        emptyMessage="No recordings in the last 24 hours."
        onOpen={onOpen}
      />
    </section>
  );
}
