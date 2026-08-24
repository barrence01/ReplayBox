import { useRef, useState } from "react";
import { formatTimestamp } from "../lib/api";
import {
  effectiveDurationMs,
  hitTestHandle,
  msFromPointer,
  playheadMsFromPointer,
  type TimelineHitTarget,
} from "../lib/timelinePosition";

const DRAG_THRESHOLD_PX = 4;

type DragMode = "playhead" | "start" | "end";

interface Props {
  durationMs: number;
  startMs: number;
  endMs: number;
  currentMs: number;
  disabled?: boolean;
  onStartChange: (ms: number) => void;
  onEndChange: (ms: number) => void;
  onStartCommit: (ms: number) => void;
  onEndCommit: (ms: number) => void;
  onSeekClick: (ms: number) => void;
  onScrubStart: () => void;
  onScrub: (ms: number) => void;
  onScrubEnd: (ms: number) => void;
}

/**
 * Time-based trim timeline (PTS / wall-clock ms).
 * Does not use frame indices — required for VFR recordings.
 */
export function Timeline({
  durationMs,
  startMs,
  endMs,
  currentMs,
  disabled = false,
  onStartChange,
  onEndChange,
  onStartCommit,
  onEndCommit,
  onSeekClick,
  onScrubStart,
  onScrub,
  onScrubEnd,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const pointerActiveRef = useRef(false);
  const draggingRef = useRef(false);
  const dragModeRef = useRef<DragMode>("playhead");
  const startXRef = useRef(0);
  const [scrubbing, setScrubbing] = useState(false);
  const duration = effectiveDurationMs(durationMs);
  const startPct = (startMs / duration) * 100;
  const endPct = (endMs / duration) * 100;
  const playPct = (currentMs / duration) * 100;

  function playheadMsFromEvent(clientX: number): number {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) {
      return currentMs;
    }
    return playheadMsFromPointer(clientX, rect, duration, startMs, endMs);
  }

  function trimMsFromEvent(clientX: number): number {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) {
      return dragModeRef.current === "end" ? endMs : startMs;
    }
    return msFromPointer(clientX, rect, duration);
  }

  function clampStartMs(value: number): number {
    return Math.min(Math.max(value, 0), endMs - 1);
  }

  function clampEndMs(value: number): number {
    return Math.max(Math.min(value, duration), startMs + 1);
  }

  function hitTarget(clientX: number): TimelineHitTarget {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) {
      return "track";
    }
    return hitTestHandle(clientX, rect, duration, startMs, endMs, currentMs);
  }

  function releasePointer(target: HTMLDivElement, pointerId: number) {
    if (target.hasPointerCapture?.(pointerId)) {
      target.releasePointerCapture(pointerId);
    }
  }

  function finishPointer(e: React.PointerEvent<HTMLDivElement>) {
    if (!pointerActiveRef.current) {
      return;
    }

    const mode = dragModeRef.current;
    pointerActiveRef.current = false;
    releasePointer(e.currentTarget, e.pointerId);

    if (mode === "start") {
      draggingRef.current = false;
      setScrubbing(false);
      onStartCommit(clampStartMs(trimMsFromEvent(e.clientX)));
      return;
    }

    if (mode === "end") {
      draggingRef.current = false;
      setScrubbing(false);
      onEndCommit(clampEndMs(trimMsFromEvent(e.clientX)));
      return;
    }

    const ms = playheadMsFromEvent(e.clientX);
    if (draggingRef.current) {
      draggingRef.current = false;
      setScrubbing(false);
      onScrubEnd(ms);
      return;
    }

    onSeekClick(ms);
  }

  function maybeStartPlayheadDrag(clientX: number) {
    if (draggingRef.current) {
      return;
    }
    if (Math.abs(clientX - startXRef.current) <= DRAG_THRESHOLD_PX) {
      return;
    }
    draggingRef.current = true;
    setScrubbing(true);
    onScrubStart();
    onScrub(playheadMsFromEvent(clientX));
  }

  function applyTrimDrag(clientX: number) {
    if (!draggingRef.current) {
      draggingRef.current = true;
      setScrubbing(true);
    }
    if (dragModeRef.current === "start") {
      onStartChange(clampStartMs(trimMsFromEvent(clientX)));
      return;
    }
    onEndChange(clampEndMs(trimMsFromEvent(clientX)));
  }

  return (
    <div className="timeline">
      <div className="timeline__labels">
        <span>{formatTimestamp(0)}</span>
        <span>{formatTimestamp(duration)}</span>
      </div>

      <div
        ref={trackRef}
        className={[
          "timeline__track",
          scrubbing ? "timeline__track--scrubbing" : "",
          disabled ? "timeline__track--locked" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        role="slider"
        aria-label="Timeline playhead"
        aria-valuemin={startMs}
        aria-valuemax={endMs}
        aria-valuenow={Math.round(currentMs)}
        aria-valuetext={formatTimestamp(currentMs)}
        aria-disabled={disabled || undefined}
        onPointerDown={(e) => {
          if (disabled || e.button !== 0) {
            return;
          }
          e.preventDefault();
          if (typeof e.currentTarget.setPointerCapture === "function") {
            e.currentTarget.setPointerCapture(e.pointerId);
          }
          pointerActiveRef.current = true;
          draggingRef.current = false;
          startXRef.current = e.clientX;

          const target = hitTarget(e.clientX);
          if (target === "start") {
            dragModeRef.current = "start";
            return;
          }
          if (target === "end") {
            dragModeRef.current = "end";
            return;
          }
          dragModeRef.current = "playhead";
        }}
        onPointerMove={(e) => {
          if (!pointerActiveRef.current) {
            return;
          }
          if (dragModeRef.current === "start" || dragModeRef.current === "end") {
            applyTrimDrag(e.clientX);
            return;
          }
          maybeStartPlayheadDrag(e.clientX);
          if (draggingRef.current) {
            onScrub(playheadMsFromEvent(e.clientX));
          }
        }}
        onPointerUp={(e) => {
          finishPointer(e);
        }}
        onPointerCancel={(e) => {
          finishPointer(e);
        }}
      >
        <div
          className="timeline__selection"
          style={{ left: `${startPct}%`, width: `${endPct - startPct}%` }}
        />
        <div
          className="timeline__handle timeline__handle--start"
          style={{ left: `${startPct}%` }}
          aria-hidden="true"
        />
        <div
          className="timeline__handle timeline__handle--end"
          style={{ left: `${endPct}%` }}
          aria-hidden="true"
        />
        <div
          className="timeline__playhead"
          style={{ left: `${playPct}%` }}
          aria-hidden="true"
        />
      </div>

      <div className="timeline__trim-labels">
        <span>Start {formatTimestamp(startMs)}</span>
        <span>End {formatTimestamp(endMs)}</span>
      </div>
    </div>
  );
}
