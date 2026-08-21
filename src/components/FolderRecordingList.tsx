import { convertFileSrc } from "@tauri-apps/api/core";
import type { Recording } from "../types";

interface Props {
  recordings: Recording[];
  currentId: string;
  onOpen: (recording: Recording) => void;
}

export function FolderRecordingList({
  recordings,
  currentId,
  onOpen,
}: Props) {
  if (recordings.length === 0) {
    return <p className="hint">No recordings in this folder.</p>;
  }

  return (
    <ul className="folder-recording-list">
      {recordings.map((recording) => {
        const thumb = recording.thumbnailPath
          ? convertFileSrc(recording.thumbnailPath)
          : null;
        const active = recording.id === currentId;

        return (
          <li key={recording.id}>
            <button
              type="button"
              className={
                active
                  ? "folder-recording-list__item active"
                  : "folder-recording-list__item"
              }
              onClick={() => onOpen(recording)}
              disabled={active}
              title={recording.filename}
            >
              <div className="folder-recording-list__thumb">
                {thumb ? (
                  <img src={thumb} alt="" loading="lazy" />
                ) : (
                  <span className="folder-recording-list__placeholder">
                    No preview
                  </span>
                )}
              </div>
              <span className="folder-recording-list__name">
                {recording.filename}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
