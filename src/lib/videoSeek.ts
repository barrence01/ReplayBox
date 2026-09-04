/** Clamp a target time to the nearest point inside the media seekable ranges. */
export function clampToSeekableSec(
  seekable: Pick<TimeRanges, "length" | "start" | "end">,
  targetSec: number,
): number {
  if (seekable.length === 0) {
    return targetSec;
  }

  for (let i = 0; i < seekable.length; i++) {
    const start = seekable.start(i);
    const end = seekable.end(i);
    if (targetSec >= start && targetSec <= end) {
      return targetSec;
    }
    if (targetSec < start) {
      return start;
    }
  }

  return seekable.end(seekable.length - 1);
}

/** Assign currentTime; avoids fastSeek, which fires seeked early on WebKitGTK. */
export function applyVideoSeek(video: HTMLVideoElement, targetSec: number): void {
  video.currentTime = targetSec;
}

/** fastSeek when available for lower-latency frames. */
export function applyScrubSeek(video: HTMLVideoElement, targetSec: number): void {
  if (typeof video.fastSeek === "function") {
    video.fastSeek(targetSec);
    return;
  }
  video.currentTime = targetSec;
}

/** Settle window for locked seeks; sized for ~5400 RPM HDD/WebKitGTK range seeks. */
export const SEEK_SETTLE_MS = 2000;
export const LOCKED_SEEK_MAX_ATTEMPTS = 5;
/** Max wall-clock time for a locked seek before giving up. */
export const SEEK_MAX_MS =
  LOCKED_SEEK_MAX_ATTEMPTS * SEEK_SETTLE_MS + SEEK_SETTLE_MS;
/** Accept nearby keyframes from fastSeek (game recordings often key every ~2s). */
export const SEEK_TOLERANCE_SEC = 1.5;

export function isSeekAtTargetSec(
  currentSec: number,
  targetSec: number,
  toleranceSec = SEEK_TOLERANCE_SEC,
): boolean {
  return Math.abs(currentSec - targetSec) <= toleranceSec;
}
