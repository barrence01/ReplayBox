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

/** Assign currentTime; used for locked-seek retries after the initial fastSeek. */
export function applyVideoSeek(video: HTMLVideoElement, targetSec: number): void {
  video.currentTime = targetSec;
}

/** fastSeek when available for lower-latency / painted frames (WebKitGTK paused). */
export function applyScrubSeek(video: HTMLVideoElement, targetSec: number): void {
  if (typeof video.fastSeek === "function") {
    video.fastSeek(targetSec);
    return;
  }
  video.currentTime = targetSec;
}

/**
 * Settle / retry interval for locked seeks. Sized so HDD / WebKitGTK
 * range seeks are not aborted by rapid re-issues of currentTime.
 */
export const SEEK_SETTLE_MS = 750;
/** Caps retry loops when seeked fires repeatedly off-target. */
export const LOCKED_SEEK_MAX_ATTEMPTS = 10;
/** Absolute wall-clock timeout for a locked seek (HDD-friendly). */
export const SEEK_MAX_MS = 10_000;
/**
 * Tolerance for locked seeks. Matches v0.1.1; fastSeek often lands on nearby
 * keyframes (~0.2s).
 */
export const LOCKED_SEEK_TOLERANCE_SEC = 0.2;
/** Coarse tolerance used to skip a redundant seekAndLock call. */
export const SCRUB_SEEK_TOLERANCE_SEC = 1.5;

export function isSeekAtTargetSec(
  currentSec: number,
  targetSec: number,
  toleranceSec = LOCKED_SEEK_TOLERANCE_SEC,
): boolean {
  return Math.abs(currentSec - targetSec) <= toleranceSec;
}
