import { useRef, useState } from "react";
import { formatTimestamp } from "../lib/api";
import {
  effectiveDurationMs,
  playheadMsFromPointer,
} from "../lib/timelinePosition";

const DRAG_THRESHOLD_PX = 4;

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
  const startXRef = useRef(0);
  const [scrubbing, setScrubbing] = useState(false);
  const duration = effectiveDurationMs(durationMs);
  const startPct = (startMs / duration) * 100;
  const endPct = (endMs / duration) * 100;
  const playPct = (currentMs / duration) * 100;

  function msFromEvent(clientX: number): number {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) {
      return currentMs;
    }
    return playheadMsFromPointer(clientX, rect, duration, startMs, endMs);
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

    const ms = msFromEvent(e.clientX);
    pointerActiveRef.current = false;
    releasePointer(e.currentTarget, e.pointerId);

    if (draggingRef.current) {
      draggingRef.current = false;
      setScrubbing(false);
      onScrubEnd(ms);
      return;
    }

    onSeekClick(ms);
  }

  function maybeStartDrag(clientX: number) {
    if (draggingRef.current) {
      return;
    }
    if (Math.abs(clientX - startXRef.current) <= DRAG_THRESHOLD_PX) {
      return;
    }
    draggingRef.current = true;
    setScrubbing(true);
    onScrubStart();
    onScrub(msFromEvent(clientX));
  }

  function clampStartMs(value: number): number {
    return Math.min(value, endMs - 1);
  }

  function clampEndMs(value: number): number {
    return Math.max(value, startMs + 1);
  }

  function commitStart(value: number) {
    onStartCommit(clampStartMs(value));
  }

  function commitEnd(value: number) {
    onEndCommit(clampEndMs(value));
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
        }}
        onPointerMove={(e) => {
          if (!pointerActiveRef.current) {
            return;
          }
          maybeStartDrag(e.clientX);
          if (draggingRef.current) {
            onScrub(msFromEvent(e.clientX));
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
        <div className="timeline__playhead" style={{ left: `${playPct}%` }} />
      </div>

      <div className="timeline__sliders">
        <label>
          Start
          <input
            type="range"
            min={0}
            max={duration}
            step={1}
            value={startMs}
            disabled={disabled}
            onChange={(e) => {
              onStartChange(clampStartMs(Number(e.target.value)));
            }}
            onPointerUp={(e) => {
              commitStart(Number(e.currentTarget.value));
            }}
            onPointerCancel={(e) => {
              commitStart(Number(e.currentTarget.value));
            }}
            onKeyUp={(e) => {
              commitStart(Number(e.currentTarget.value));
            }}
          />
          <span>{formatTimestamp(startMs)}</span>
        </label>
        <label>
          End
          <input
            type="range"
            min={0}
            max={duration}
            step={1}
            value={endMs}
            disabled={disabled}
            onChange={(e) => {
              onEndChange(clampEndMs(Number(e.target.value)));
            }}
            onPointerUp={(e) => {
              commitEnd(Number(e.currentTarget.value));
            }}
            onPointerCancel={(e) => {
              commitEnd(Number(e.currentTarget.value));
            }}
            onKeyUp={(e) => {
              commitEnd(Number(e.currentTarget.value));
            }}
          />
          <span>{formatTimestamp(endMs)}</span>
        </label>
      </div>
    </div>
  );
}
