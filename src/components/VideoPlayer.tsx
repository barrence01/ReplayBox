import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { getPlaybackInfo } from "../lib/api";
import type { PlaybackInfo } from "../types";
import { isPlayInterruptedError } from "../lib/videoPlayback";
import {
  SEEK_MAX_MS,
  SEEK_SETTLE_MS,
  applyScrubSeek,
  applyVideoSeek,
  clampToSeekableSec,
  isSeekAtTargetSec,
} from "../lib/videoSeek";

export interface VideoPlayerHandle {
  play: () => Promise<void>;
  pause: () => void;
  seekTo: (ms: number) => void;
  seekAndLock: (ms: number) => void;
  beginScrub: () => void;
  scrubTo: (ms: number) => void;
  endScrubAndLock: (ms: number) => void;
  getCurrentMs: () => number;
  isPaused: () => boolean;
}

interface Props {
  recordingId: string;
  startMs: number;
  endMs: number;
  onTimeUpdate: (ms: number) => void;
  onPlayingChange: (playing: boolean) => void;
  onSeekingChange?: (seeking: boolean) => void;
  onError: (message: string | null) => void;
  onDurationChange?: (ms: number) => void;
  onMissingFile?: () => void;
}

const LOAD_TIMEOUT_MS = 15_000;
const PREPARING_TIMEOUT_MS = 120_000;
const PREPARING_POLL_MS = 500;
const PREPARING_ELAPSED_TICK_MS = 1000;
const SCRUB_SEEK_FALLBACK_MS = 100;
/** Non-zero seek used to warm WebKit demuxer before the first user seek. */
const SEEK_PRIME_OFFSET_SEC = 1;

export const VideoPlayer = forwardRef<VideoPlayerHandle, Props>(
  function VideoPlayer(
    {
      recordingId,
      startMs,
      endMs,
      onTimeUpdate,
      onPlayingChange,
      onSeekingChange,
      onError,
      onDurationChange,
      onMissingFile,
    },
    ref,
  ) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const missingNotified = useRef(false);
    const fallbackLevel = useRef(0);
    const endedNaturally = useRef(false);
    const metadataLoaded = useRef(false);
    const isSeekingRef = useRef(false);
    const isScrubbingRef = useRef(false);
    const interactionLockedRef = useRef(false);
    const lockedSeekRef = useRef(false);
    const seekPrimedRef = useRef(false);
    const primingPhaseRef = useRef<"offset" | "return" | null>(null);
    /** User seek queued before/during priming; applied after return-to-startMs. */
    const postPrimeSeekMsRef = useRef<number | null>(null);
    const wasPlayingBeforeScrubRef = useRef(false);
    const scrubTargetMsRef = useRef<number | null>(null);
    const scrubSeekIdleRef = useRef(true);
    const scrubAppliedMsRef = useRef<number | null>(null);
    const scrubSeekTimeoutRef = useRef<number | null>(null);
    const pendingSeekMsRef = useRef<number | null>(null);
    const seekTargetMsRef = useRef<number | null>(null);
    const seekRetriedRef = useRef(false);
    const seekStartedAtRef = useRef<number | null>(null);
    const queuedLockedSeekMsRef = useRef<number | null>(null);
    const queuedLockedSeekResumeRef = useRef<boolean | undefined>(undefined);
    const resumeAfterSeekRef = useRef(false);
    const loadTimeoutRef = useRef<number | null>(null);
    const seekTimeoutRef = useRef<number | null>(null);
    const preparingPollRef = useRef<number | null>(null);
    const preparingElapsedRef = useRef<number | null>(null);
    const preparingStartedAt = useRef<number | null>(null);
    const [videoSrc, setVideoSrc] = useState("");
    const [playbackMode, setPlaybackMode] = useState<string>("direct");
    const [loading, setLoading] = useState(true);
    const [preparing, setPreparing] = useState(false);
    const [preparingElapsedSec, setPreparingElapsedSec] = useState(0);
    const [seekingUi, setSeekingUi] = useState(false);

    function clearLoadTimeout() {
      if (loadTimeoutRef.current !== null) {
        window.clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
      }
    }

    function clearSeekTimeout() {
      if (seekTimeoutRef.current !== null) {
        window.clearTimeout(seekTimeoutRef.current);
        seekTimeoutRef.current = null;
      }
    }

    function clearPreparingPoll() {
      if (preparingPollRef.current !== null) {
        window.clearInterval(preparingPollRef.current);
        preparingPollRef.current = null;
      }
      if (preparingElapsedRef.current !== null) {
        window.clearInterval(preparingElapsedRef.current);
        preparingElapsedRef.current = null;
      }
      preparingStartedAt.current = null;
      setPreparingElapsedSec(0);
    }

    function clearPlaybackTimers() {
      clearLoadTimeout();
      clearPreparingPoll();
      clearSeekTimeout();
    }

    function clearScrubSeekTimeout() {
      if (scrubSeekTimeoutRef.current !== null) {
        window.clearTimeout(scrubSeekTimeoutRef.current);
        scrubSeekTimeoutRef.current = null;
      }
    }

    function resetScrubSeekState() {
      clearScrubSeekTimeout();
      scrubSeekIdleRef.current = true;
      scrubAppliedMsRef.current = null;
      scrubTargetMsRef.current = null;
    }

    function clampToSelection(ms: number): number {
      return Math.min(Math.max(ms, startMs), endMs);
    }

    function resolveSeekTargetSec(video: HTMLVideoElement, ms: number): number {
      return clampToSeekableSec(video.seekable, clampToSelection(ms) / 1000);
    }

    function setSeekingLocked(locked: boolean) {
      interactionLockedRef.current = locked;
      setSeekingUi(locked);
      onSeekingChange?.(locked);
    }

    function releaseLockedSeek() {
      if (!lockedSeekRef.current) {
        return;
      }
      lockedSeekRef.current = false;
      setSeekingLocked(false);
    }

    function armScrubSeekFallback() {
      clearScrubSeekTimeout();
      scrubSeekTimeoutRef.current = window.setTimeout(() => {
        scrubSeekTimeoutRef.current = null;
        if (!isScrubbingRef.current) {
          return;
        }
        scrubSeekIdleRef.current = true;
        applyScrubSeekIfNeeded();
      }, SCRUB_SEEK_FALLBACK_MS);
    }

    function applyScrubSeekIfNeeded() {
      if (!isScrubbingRef.current) {
        return;
      }

      const video = videoRef.current;
      const targetMs = scrubTargetMsRef.current;
      if (!video || targetMs === null || video.readyState < 1) {
        return;
      }

      if (
        scrubAppliedMsRef.current !== null &&
        Math.abs(targetMs - scrubAppliedMsRef.current) <= 1
      ) {
        scrubSeekIdleRef.current = true;
        return;
      }

      const targetSec = resolveSeekTargetSec(video, targetMs);
      applyScrubSeek(video, targetSec);
      scrubAppliedMsRef.current = targetMs;
      scrubSeekIdleRef.current = false;
      armScrubSeekFallback();
    }

    function handleScrubSeeked() {
      clearScrubSeekTimeout();
      const targetMs = scrubTargetMsRef.current;
      if (
        targetMs !== null &&
        scrubAppliedMsRef.current !== null &&
        Math.abs(targetMs - scrubAppliedMsRef.current) > 1
      ) {
        applyScrubSeekIfNeeded();
        return;
      }
      scrubSeekIdleRef.current = true;
    }

    function finishSeek() {
      clearSeekTimeout();
      isSeekingRef.current = false;
      pendingSeekMsRef.current = null;
      seekTargetMsRef.current = null;
      seekRetriedRef.current = false;
      seekStartedAtRef.current = null;
      releaseLockedSeek();

      const queuedMs = queuedLockedSeekMsRef.current;
      const queuedResume = queuedLockedSeekResumeRef.current;
      if (queuedMs !== null) {
        queuedLockedSeekMsRef.current = null;
        queuedLockedSeekResumeRef.current = undefined;
        startLockedSeek(queuedMs, queuedResume);
      }
    }

    function reportPlayError(error: unknown) {
      if (!isPlayInterruptedError(error)) {
        onError(`Playback failed: ${String(error)}`);
      }
    }

    function completeSeek(resumePlayback: boolean) {
      const video = videoRef.current;
      if (!video) {
        finishSeek();
        return;
      }

      if (primingPhaseRef.current === "offset") {
        clearSeekTimeout();
        isSeekingRef.current = false;
        pendingSeekMsRef.current = null;
        seekTargetMsRef.current = null;
        seekRetriedRef.current = false;
        seekStartedAtRef.current = null;
        primingPhaseRef.current = "return";
        startLockedSeek(startMs, false, { supersedeQueue: true });
        return;
      }

      if (primingPhaseRef.current === "return") {
        primingPhaseRef.current = null;
        seekPrimedRef.current = true;
        const postPrimeMs = postPrimeSeekMsRef.current;
        postPrimeSeekMsRef.current = null;
        finishSeek();
        if (postPrimeMs !== null) {
          seekTo(postPrimeMs);
          return;
        }
        onTimeUpdate(clampToSelection(startMs));
        return;
      }

      const wasLocked = lockedSeekRef.current;
      finishSeek();
      const ms = video.currentTime * 1000;
      if (ms < startMs) {
        if (wasLocked) {
          lockedSeekRef.current = true;
          setSeekingLocked(true);
        }
        seekTo(startMs);
        return;
      }
      seekPrimedRef.current = true;
      onTimeUpdate(clampToSelection(ms));

      if (resumePlayback) {
        resumeAfterSeekRef.current = false;
        void video.play().catch(reportPlayError);
      }
    }

    function failSeek() {
      const video = videoRef.current;
      const intendedMs = seekTargetMsRef.current;
      const postPrimeMs = postPrimeSeekMsRef.current;
      resumeAfterSeekRef.current = false;
      if (primingPhaseRef.current !== null) {
        primingPhaseRef.current = null;
        seekPrimedRef.current = true;
        postPrimeSeekMsRef.current = null;
      }
      finishSeek();
      if (postPrimeMs !== null) {
        seekTo(postPrimeMs);
        return;
      }
      if (intendedMs !== null) {
        onTimeUpdate(clampToSelection(intendedMs));
        return;
      }
      if (video) {
        onTimeUpdate(clampToSelection(video.currentTime * 1000));
      }
    }

    function settleSeek(fromTimeout = false) {
      const video = videoRef.current;
      if (!video) {
        finishSeek();
        return;
      }

      if (seekTargetMsRef.current === null) {
        completeSeek(resumeAfterSeekRef.current);
        return;
      }

      const targetSec = resolveSeekTargetSec(video, seekTargetMsRef.current);
      const atTarget = isSeekAtTargetSec(video.currentTime, targetSec);
      if (atTarget) {
        if (video.seeking) {
          const startedAt = seekStartedAtRef.current ?? Date.now();
          if (Date.now() - startedAt >= SEEK_MAX_MS) {
            completeSeek(resumeAfterSeekRef.current);
            return;
          }
          if (fromTimeout) {
            armSeekTimeout();
          }
          return;
        }
        completeSeek(resumeAfterSeekRef.current);
        return;
      }

      if (!fromTimeout) {
        if (!seekRetriedRef.current) {
          seekRetriedRef.current = true;
          applyVideoSeek(video, targetSec);
        }
        return;
      }

      const startedAt = seekStartedAtRef.current ?? Date.now();
      if (Date.now() - startedAt >= SEEK_MAX_MS) {
        failSeek();
        return;
      }

      applyVideoSeek(video, targetSec);
      armSeekTimeout();
    }

    function armSeekTimeout() {
      clearSeekTimeout();
      seekTimeoutRef.current = window.setTimeout(() => {
        seekTimeoutRef.current = null;
        if (isSeekingRef.current) {
          settleSeek(true);
        }
      }, SEEK_SETTLE_MS);
    }

    function applyLockedVideoSeek(
      video: HTMLVideoElement,
      targetMs: number,
      resumePlayback: boolean,
    ) {
      const targetSec = resolveSeekTargetSec(video, targetMs);
      if (
        Math.abs(video.currentTime - targetSec) < 0.001 &&
        !video.seeking
      ) {
        completeSeek(resumePlayback);
        return;
      }

      armSeekTimeout();
      applyVideoSeek(video, targetSec);
    }

    function beginVideoSeek(video: HTMLVideoElement, targetMs: number) {
      const wasPlaying = !video.paused;
      resumeAfterSeekRef.current = wasPlaying;
      if (wasPlaying) {
        video.pause();
      }
      applyLockedVideoSeek(video, targetMs, wasPlaying);
    }

    function startLockedSeek(
      ms: number,
      resumePlayback?: boolean,
      options?: { supersedeQueue?: boolean },
    ) {
      const clamped = clampToSelection(ms);
      if (options?.supersedeQueue) {
        queuedLockedSeekMsRef.current = null;
        queuedLockedSeekResumeRef.current = undefined;
      } else if (interactionLockedRef.current) {
        queuedLockedSeekMsRef.current = clamped;
        queuedLockedSeekResumeRef.current = resumePlayback;
        return;
      }

      lockedSeekRef.current = true;
      setSeekingLocked(true);
      pendingSeekMsRef.current = clamped;
      seekTargetMsRef.current = clamped;
      seekRetriedRef.current = false;
      seekStartedAtRef.current = Date.now();
      isSeekingRef.current = true;

      const video = videoRef.current;
      if (video && video.readyState >= 1) {
        if (resumePlayback === undefined) {
          beginVideoSeek(video, clamped);
          return;
        }

        resumeAfterSeekRef.current = resumePlayback;
        applyLockedVideoSeek(video, clamped, resumePlayback);
        return;
      }

      if (resumePlayback !== undefined) {
        resumeAfterSeekRef.current = resumePlayback;
      } else if (video) {
        resumeAfterSeekRef.current = !video.paused;
        video.pause();
      }
    }

    function seekTo(ms: number) {
      const clamped = clampToSelection(ms);
      pendingSeekMsRef.current = clamped;
      seekTargetMsRef.current = clamped;
      seekRetriedRef.current = false;
      seekStartedAtRef.current = Date.now();
      isSeekingRef.current = true;

      const video = videoRef.current;
      if (video && video.readyState >= 1) {
        beginVideoSeek(video, clamped);
      }
    }

    function seekAndLock(ms: number) {
      startLockedSeek(ms);
    }

    function beginScrub() {
      clearScrubSeekTimeout();
      if (isSeekingRef.current) {
        finishSeek();
      }
      if (primingPhaseRef.current !== null) {
        primingPhaseRef.current = null;
        seekPrimedRef.current = true;
        postPrimeSeekMsRef.current = null;
      }
      isScrubbingRef.current = true;
      scrubTargetMsRef.current = null;
      scrubSeekIdleRef.current = true;
      scrubAppliedMsRef.current = null;

      const video = videoRef.current;
      if (video) {
        wasPlayingBeforeScrubRef.current = !video.paused;
        video.pause();
      } else {
        wasPlayingBeforeScrubRef.current = false;
      }
    }

    function scrubTo(ms: number) {
      const clamped = clampToSelection(ms);
      scrubTargetMsRef.current = clamped;
      onTimeUpdate(clamped);

      if (scrubSeekIdleRef.current) {
        applyScrubSeekIfNeeded();
      }
    }

    function endScrubAndLock(ms: number) {
      const clamped = clampToSelection(ms);
      clearScrubSeekTimeout();
      resetScrubSeekState();
      isScrubbingRef.current = false;

      const resume = wasPlayingBeforeScrubRef.current;
      wasPlayingBeforeScrubRef.current = false;

      startLockedSeek(clamped, resume, { supersedeQueue: true });
    }

    function handleSeeked() {
      if (isSeekingRef.current) {
        settleSeek();
        return;
      }
      if (isScrubbingRef.current) {
        handleScrubSeeked();
      }
    }

    function armLoadTimeout() {
      clearLoadTimeout();
      metadataLoaded.current = false;
      loadTimeoutRef.current = window.setTimeout(() => {
        if (!metadataLoaded.current) {
          void handleLoadTimeout();
        }
      }, LOAD_TIMEOUT_MS);
    }

    function applyPlaybackInfo(info: PlaybackInfo) {
      setPlaybackMode(info.mode);
      if (info.mode === "preparing") {
        setPreparing(true);
        setLoading(true);
        setVideoSrc("");
        onError(null);
        startPreparingPoll();
        return;
      }

      clearPreparingPoll();
      setPreparing(false);
      setVideoSrc(info.url);
      setLoading(false);
      onError(null);
      armLoadTimeout();
    }

    function startPreparingPoll() {
      clearPreparingPoll();
      preparingStartedAt.current = Date.now();
      setPreparingElapsedSec(0);
      preparingElapsedRef.current = window.setInterval(() => {
        if (preparingStartedAt.current !== null) {
          setPreparingElapsedSec(
            Math.floor((Date.now() - preparingStartedAt.current) / 1000),
          );
        }
      }, PREPARING_ELAPSED_TICK_MS);
      preparingPollRef.current = window.setInterval(() => {
        if (
          preparingStartedAt.current !== null &&
          Date.now() - preparingStartedAt.current > PREPARING_TIMEOUT_MS
        ) {
          clearPreparingPoll();
          setPreparing(false);
          setLoading(false);
          onError("Preview preparation timed out. Try again or check replaybox.log.");
          return;
        }
        void pollPreparing();
      }, PREPARING_POLL_MS);
    }

    async function pollPreparing() {
      try {
        const info = await getPlaybackInfo(recordingId);
        if (info.mode !== "preparing") {
          applyPlaybackInfo(info);
        }
      } catch (e) {
        clearPreparingPoll();
        setPreparing(false);
        setLoading(false);
        onError(`Preview preparation failed: ${String(e)}`);
      }
    }

    async function requestFallback(level: 1 | 2) {
      if (fallbackLevel.current >= level) return;
      fallbackLevel.current = level;
      setLoading(true);
      clearPlaybackTimers();
      try {
        const info = await getPlaybackInfo(recordingId, {
          forceFallback: true,
          fallbackLevel: level,
        });
        applyPlaybackInfo(info);
      } catch (e) {
        onError(`Playback fallback failed: ${String(e)}`);
        setLoading(false);
        setPreparing(false);
      }
    }

    async function handleLoadTimeout() {
      if (playbackMode === "direct" && fallbackLevel.current < 1) {
        await requestFallback(1);
        return;
      }
      if (playbackMode === "cache" && fallbackLevel.current < 2) {
        await requestFallback(2);
        return;
      }
      onError(
        `Video playback timed out (${playbackMode}). Check that the file exists and the media server is running.`,
      );
    }

    useEffect(() => {
      missingNotified.current = false;
      fallbackLevel.current = 0;
      endedNaturally.current = false;
      metadataLoaded.current = false;
      isSeekingRef.current = false;
      isScrubbingRef.current = false;
      interactionLockedRef.current = false;
      lockedSeekRef.current = false;
      seekPrimedRef.current = false;
      primingPhaseRef.current = null;
      postPrimeSeekMsRef.current = null;
      wasPlayingBeforeScrubRef.current = false;
      scrubTargetMsRef.current = null;
      resetScrubSeekState();
      pendingSeekMsRef.current = null;
      seekTargetMsRef.current = null;
      seekRetriedRef.current = false;
      seekStartedAtRef.current = null;
      queuedLockedSeekMsRef.current = null;
      queuedLockedSeekResumeRef.current = undefined;
      resumeAfterSeekRef.current = false;
      setSeekingUi(false);
      setLoading(true);
      setPreparing(false);
      setVideoSrc("");
      clearPlaybackTimers();

      let cancelled = false;
      (async () => {
        try {
          const info = await getPlaybackInfo(recordingId);
          if (!cancelled) {
            applyPlaybackInfo(info);
          }
        } catch (e) {
          if (!cancelled) {
            onError(`Media server unavailable: ${String(e)}`);
            setLoading(false);
          }
        }
      })();

      return () => {
        cancelled = true;
        clearPlaybackTimers();
        clearScrubSeekTimeout();
      };
    }, [recordingId, onError]);

    useImperativeHandle(ref, () => ({
      play: async () => {
        const video = videoRef.current;
        if (!video || interactionLockedRef.current) return;
        if (!video.paused) return;

        endedNaturally.current = false;
        const ms = video.currentTime * 1000;
        if (ms < startMs || ms >= endMs) {
          seekTo(startMs);
          if (isSeekingRef.current) {
            await new Promise<void>((resolve) => {
              const onSeeked = () => {
                video.removeEventListener("seeked", onSeeked);
                resolve();
              };
              video.addEventListener("seeked", onSeeked);
            });
          }
        }

        try {
          await video.play();
        } catch (e) {
          reportPlayError(e);
        }
      },
      pause: () => {
        videoRef.current?.pause();
      },
      seekTo,
      seekAndLock,
      beginScrub,
      scrubTo,
      endScrubAndLock,
      getCurrentMs: () => {
        const video = videoRef.current;
        return video ? video.currentTime * 1000 : 0;
      },
      isPaused: () => {
        const video = videoRef.current;
        return !video || video.paused;
      },
    }));

    function handleTimeUpdate() {
      const video = videoRef.current;
      if (!video || isSeekingRef.current || isScrubbingRef.current) return;

      const ms = video.currentTime * 1000;
      if (!video.paused && ms >= endMs) {
        video.pause();
        endedNaturally.current = true;
        onTimeUpdate(startMs);
        return;
      }
      if (ms > endMs) {
        seekTo(endMs);
        return;
      }
      if (ms < startMs) {
        seekTo(startMs);
        return;
      }
      onTimeUpdate(ms);
    }

    function handleEnded() {
      const video = videoRef.current;
      if (!video) return;
      video.pause();
      endedNaturally.current = true;
      onTimeUpdate(clampToSelection(startMs));
    }

    function handleVideoError() {
      if (endedNaturally.current) return;

      if (playbackMode === "direct" && fallbackLevel.current < 1) {
        void requestFallback(1);
        return;
      }
      if (playbackMode === "cache" && fallbackLevel.current < 2) {
        void requestFallback(2);
        return;
      }

      onError(
        `Video playback failed (${playbackMode}). Check that the file exists and the media server is running.`,
      );
      if (missingNotified.current) return;
      missingNotified.current = true;
      onMissingFile?.();
    }

    const videoPreload = videoSrc && !preparing ? "auto" : "metadata";

    return (
      <div className="video-player">
        <video
          ref={videoRef}
          key={videoSrc}
          src={videoSrc || undefined}
          preload={videoPreload}
          playsInline
          onClick={() => {
            const video = videoRef.current;
            if (!video || interactionLockedRef.current) return;
            if (video.paused) {
              void video.play().catch(reportPlayError);
            } else {
              video.pause();
            }
          }}
          onLoadedMetadata={() => {
            metadataLoaded.current = true;
            clearLoadTimeout();
            onError(null);
            const video = videoRef.current;
            if (video && Number.isFinite(video.duration)) {
              onDurationChange?.(video.duration * 1000);
            }
            if (isScrubbingRef.current) {
              seekPrimedRef.current = true;
              return;
            }
            if (lockedSeekRef.current && pendingSeekMsRef.current !== null) {
              const clamped = pendingSeekMsRef.current;
              const resume = resumeAfterSeekRef.current;
              seekTargetMsRef.current = clamped;
              seekRetriedRef.current = false;
              seekStartedAtRef.current = Date.now();
              isSeekingRef.current = true;
              if (video && video.readyState >= 1) {
                applyLockedVideoSeek(video, clamped, resume);
              }
              return;
            }
            if (seekPrimedRef.current) {
              seekTo(pendingSeekMsRef.current ?? startMs);
              return;
            }
            const primeMs = clampToSelection(
              startMs + SEEK_PRIME_OFFSET_SEC * 1000,
            );
            if (Math.abs(primeMs - startMs) < 1) {
              seekPrimedRef.current = true;
              seekTo(pendingSeekMsRef.current ?? startMs);
              return;
            }
            postPrimeSeekMsRef.current = pendingSeekMsRef.current;
            primingPhaseRef.current = "offset";
            startLockedSeek(primeMs, false);
          }}
          onPlay={() => onPlayingChange(true)}
          onPause={() => onPlayingChange(false)}
          onTimeUpdate={handleTimeUpdate}
          onSeeked={handleSeeked}
          onEnded={handleEnded}
          onError={handleVideoError}
        />
        {loading && !preparing && (
          <p className="video-player__status muted">Loading video…</p>
        )}
        {preparing && (
          <p className="video-player__status muted">
            Preparing preview… ({preparingElapsedSec}s)
          </p>
        )}
        {seekingUi && !loading && !preparing && (
          <div className="video-player__seek-overlay" aria-live="polite">
            Seeking…
          </div>
        )}
      </div>
    );
  },
);
