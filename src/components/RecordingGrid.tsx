import type { Recording } from "../types";
import { RecordingCard } from "./RecordingCard";

interface Props {
  recordings: Recording[];
  emptyMessage?: string;
  onOpen: (recording: Recording) => void;
}

export function RecordingGrid({
  recordings,
  emptyMessage = "No recordings found.",
  onOpen,
}: Props) {
  if (recordings.length === 0) {
    return <p className="empty-state">{emptyMessage}</p>;
  }

  return (
    <div className="recording-grid">
      {recordings.map((r) => (
        <RecordingCard key={r.id} recording={r} onOpen={onOpen} />
      ))}
    </div>
  );
}
