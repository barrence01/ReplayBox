interface TrackRect {
  left: number;
  width: number;
}

export function effectiveDurationMs(durationMs: number): number {
  return Math.max(durationMs, 1);
}

function pointerRatio(clientX: number, rect: TrackRect): number {
  if (!Number.isFinite(clientX) || !Number.isFinite(rect.width) || rect.width <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
}

function msFromRatio(ratio: number, durationMs: number): number {
  const safeRatio = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  return Math.round(safeRatio * effectiveDurationMs(durationMs));
}

export function clampPlayheadMs(
  ms: number,
  startMs: number,
  endMs: number,
): number {
  const safeMs = Number.isFinite(ms) ? ms : startMs;
  return Math.min(Math.max(safeMs, startMs), endMs);
}

export function playheadMsFromPointer(
  clientX: number,
  rect: TrackRect,
  durationMs: number,
  startMs: number,
  endMs: number,
): number {
  return clampPlayheadMs(
    msFromRatio(pointerRatio(clientX, rect), durationMs),
    startMs,
    endMs,
  );
}
