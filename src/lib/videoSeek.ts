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

export const SEEK_SETTLE_MS = 500;
export const SEEK_TOLERANCE_SEC = 0.05;

export function isSeekAtTargetSec(
  currentSec: number,
  targetSec: number,
  toleranceSec = SEEK_TOLERANCE_SEC,
): boolean {
  return Math.abs(currentSec - targetSec) <= toleranceSec;
}
