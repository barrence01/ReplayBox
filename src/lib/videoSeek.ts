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

/**
 * Locked-seek target resolution. Unlike {@link clampToSeekableSec}, never pulls
 * a mid-file target down to a tiny early buffer range (e.g. [0, 0.05]).
 * Returns the intended time until seekable actually covers it.
 */
export function resolveLockedSeekTargetSec(
  seekable: Pick<TimeRanges, "length" | "start" | "end">,
  targetSec: number,
): number {
  if (seekable.length === 0) {
    return targetSec;
  }
  for (let i = 0; i < seekable.length; i++) {
    if (targetSec >= seekable.start(i) && targetSec <= seekable.end(i)) {
      return targetSec;
    }
  }
  return targetSec;
}

/** True when seekable ranges already include the target (safe to assign currentTime). */
export function seekableCoversSec(
  seekable: Pick<TimeRanges, "length" | "start" | "end">,
  targetSec: number,
): boolean {
  if (seekable.length === 0) {
    return false;
  }
  for (let i = 0; i < seekable.length; i++) {
    if (targetSec >= seekable.start(i) && targetSec <= seekable.end(i)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether it is safe to assign currentTime for a locked seek.
 * Waits for seekable coverage when only a tiny early range exists (HDD / progressive HTTP).
 * Escape: empty seekable + HAVE_FUTURE_DATA — some WebKit builds report empty seekable when ready.
 */
export function canApplyLockedSeek(
  video: Pick<HTMLVideoElement, "readyState" | "seekable">,
  targetSec: number,
): boolean {
  if (video.readyState < 1) {
    return false;
  }
  if (seekableCoversSec(video.seekable, targetSec)) {
    return true;
  }
  if (
    video.seekable.length === 0 &&
    video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA
  ) {
    return true;
  }
  return false;
}

/** Assign currentTime; used for locked seeks (precise positioning). */
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
 * Poll interval while a locked seek is in flight. Short enough to notice
 * settle, long enough not to spam currentTime on HDD range seeks.
 */
export const SEEK_SETTLE_MS = 750;
/**
 * Minimum wall-clock wait before re-issuing currentTime while seeking/off-target.
 * Sized for HDD spin-up / WebKitGTK range seeks (~2–3s).
 */
export const HDD_SEEK_GRACE_MS = 4_000;
/** Caps how many currentTime assignments a locked seek may make. */
export const LOCKED_SEEK_MAX_ATTEMPTS = 10;
/** Absolute wall-clock timeout for a locked seek (HDD-friendly). Snap, do not remux. */
export const SEEK_MAX_MS = 25_000;
/**
 * Tolerance for locked seeks. currentTime often lands on nearby keyframes (~0.2s).
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
