import { formatTimestamp } from "../lib/api";

interface Props {
  durationMs: number;
  startMs: number;
  endMs: number;
  currentMs: number;
  onStartChange: (ms: number) => void;
  onEndChange: (ms: number) => void;
  onSeek: (ms: number) => void;
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
  onStartChange,
  onEndChange,
  onSeek,
}: Props) {
  const duration = Math.max(durationMs, 1);
  const startPct = (startMs / duration) * 100;
  const endPct = (endMs / duration) * 100;
  const playPct = (currentMs / duration) * 100;

  return (
    <div className="timeline">
      <div className="timeline__labels">
        <span>{formatTimestamp(0)}</span>
        <span>{formatTimestamp(duration)}</span>
      </div>

      <div
        className="timeline__track"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const ratio = Math.min(
            1,
            Math.max(0, (e.clientX - rect.left) / rect.width),
          );
          onSeek(ratio * duration);
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
            onChange={(e) => {
              const v = Number(e.target.value);
              onStartChange(Math.min(v, endMs - 1));
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
            onChange={(e) => {
              const v = Number(e.target.value);
              onEndChange(Math.max(v, startMs + 1));
            }}
          />
          <span>{formatTimestamp(endMs)}</span>
        </label>
      </div>
    </div>
  );
}
