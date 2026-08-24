interface TrackRect {
  left: number;
  width: number;
}

export type TimelineHitTarget = "start" | "end" | "playhead" | "track";

export const TIMELINE_HANDLE_HIT_PX = 12;

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

function xFromMs(ms: number, rect: TrackRect, durationMs: number): number {
  const duration = effectiveDurationMs(durationMs);
  return rect.left + (ms / duration) * rect.width;
}

export function clampPlayheadMs(
  ms: number,
  startMs: number,
  endMs: number,
): number {
  const safeMs = Number.isFinite(ms) ? ms : startMs;
  return Math.min(Math.max(safeMs, startMs), endMs);
}

export function msFromPointer(
  clientX: number,
  rect: TrackRect,
  durationMs: number,
): number {
  return msFromRatio(pointerRatio(clientX, rect), durationMs);
}

export function playheadMsFromPointer(
  clientX: number,
  rect: TrackRect,
  durationMs: number,
  startMs: number,
  endMs: number,
): number {
  return clampPlayheadMs(
    msFromPointer(clientX, rect, durationMs),
    startMs,
    endMs,
  );
}

export function hitTestHandle(
  clientX: number,
  rect: TrackRect,
  durationMs: number,
  startMs: number,
  endMs: number,
  currentMs: number,
  hitPx = TIMELINE_HANDLE_HIT_PX,
): TimelineHitTarget {
  if (!Number.isFinite(clientX) || !Number.isFinite(rect.width) || rect.width <= 0) {
    return "track";
  }

  const startX = xFromMs(startMs, rect, durationMs);
  const endX = xFromMs(endMs, rect, durationMs);
  const playX = xFromMs(currentMs, rect, durationMs);

  const startDist = Math.abs(clientX - startX);
  const endDist = Math.abs(clientX - endX);
  const candidates: Array<{ target: TimelineHitTarget; distance: number }> = [];
  if (startDist <= hitPx) {
    candidates.push({ target: "start", distance: startDist });
  }
  if (endDist <= hitPx) {
    candidates.push({ target: "end", distance: endDist });
  }
  candidates.sort((a, b) => a.distance - b.distance);

  if (candidates.length > 0) {
    return candidates[0].target;
  }

  if (Math.abs(clientX - playX) <= hitPx) {
    return "playhead";
  }

  return "track";
}
