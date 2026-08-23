import { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Recording } from "../types";

interface Props {
  recordings: Recording[];
  currentId: string;
  onOpen: (recording: Recording) => void;
}

/** Scroll `el` into view inside `container` only — does not move ancestor scrollers. */
export function scrollChildIntoContainer(
  container: HTMLElement,
  el: HTMLElement,
) {
  const c = container.getBoundingClientRect();
  const e = el.getBoundingClientRect();
  if (e.bottom > c.bottom) {
    container.scrollTop += e.bottom - c.bottom;
  } else if (e.top < c.top) {
    container.scrollTop -= c.top - e.top;
  }
}

export function FolderRecordingList({
  recordings,
  currentId,
  onOpen,
}: Props) {
  const listRef = useRef<HTMLUListElement | null>(null);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const list = listRef.current;
    const active = activeRef.current;
    if (!list || !active) return;
    scrollChildIntoContainer(list, active);
  }, [currentId, recordings]);

  if (recordings.length === 0) {
    return <p className="hint">No recordings in this folder.</p>;
  }

  return (
    <ul ref={listRef} className="folder-recording-list">
      {recordings.map((recording) => {
        const thumb = recording.thumbnailPath
          ? convertFileSrc(recording.thumbnailPath)
          : null;
        const active = recording.id === currentId;

        return (
          <li key={recording.id}>
            <button
              type="button"
              ref={active ? activeRef : undefined}
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
