import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { getPlaybackInfo, logPlayback, prioritizePreviewForRecording } from "../lib/api";
import { formatElapsed } from "../lib/queueHelpers";
import type { PlaybackInfo } from "../types";
import { isPlayInterruptedError } from "../lib/videoPlayback";
import {
  HDD_SEEK_GRACE_MS,
  LOCKED_SEEK_MAX_ATTEMPTS,
  SEEK_MAX_MS,
  SEEK_SETTLE_MS,
  applyScrubSeek,
  applyVideoSeek,
  canApplyLockedSeek,
  clampToSeekableSec,
  isSeekAtTargetSec,
  resolveLockedSeekTargetSec,
  seekableCoversSec,
} from "../lib/videoSeek";

function releaseVideoElement(video: HTMLVideoElement) {
  video.pause();
  video.removeAttribute("src");
  video.load();
}

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
const SEEKED_WAIT_TIMEOUT_MS = 3_000;
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
    const recordingIdRef = useRef(recordingId);
    recordingIdRef.current = recordingId;
    const loadCancelledRef = useRef(false);
    const setVideoRef = useCallback((node: HTMLVideoElement | null) => {
      const prev = videoRef.current;
      videoRef.current = node;
      if (prev && prev !== node) {
        queueMicrotask(() => {
          if (videoRef.current !== prev) {
            releaseVideoElement(prev);
          }
        });
      }
    }, []);
    const missingNotified = useRef(false);
    const fallbackLevel = useRef(0);
    const fallbackInProgressRef = useRef(false);
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
    const seekAttemptRef = useRef(0);
    const seekStartedAtRef = useRef<number | null>(null);
    const lastSeekApplyAtRef = useRef<number | null>(null);
    const queuedLockedSeekMsRef = useRef<number | null>(null);
    const queuedLockedSeekResumeRef = useRef<boolean | undefined>(undefined);
    const resumeAfterSeekRef = useRef(false);
    const pendingSeekAfterFallbackRef = useRef<number | null>(null);
    const requestFallbackRef = useRef<(level: 1 | 2) => Promise<void>>(
      async () => undefined,
    );
    const loadTimeoutRef = useRef<number | null>(null);
    const seekTimeoutRef = useRef<number | null>(null);
    const preparingPollRef = useRef<number | null>(null);
    const preparingElapsedRef = useRef<number | null>(null);
    const preparingMetaRef = useRef<{
      queueStatus: string | null;
      queuedAt: string | null;
      startedAt: string | null;
      queuePosition: number | null;
      previewStrategy: string | null;
      previewInplace: boolean | null;
    }>({
      queueStatus: null,
      queuedAt: null,
      startedAt: null,
      queuePosition: null,
      previewStrategy: null,
      previewInplace: null,
    });
    const [videoSrc, setVideoSrc] = useState("");
    const [playbackMode, setPlaybackMode] = useState<string>("direct");
    const [loading, setLoading] = useState(true);
    const [preparing, setPreparing] = useState(false);
    const [preparingStatusText, setPreparingStatusText] = useState("");
    const [canProcessNext, setCanProcessNext] = useState(false);
    const [seekingUi, setSeekingUi] = useState(false);
    const [hasPaintedFrame, setHasPaintedFrame] = useState(false);

    function seekLogFields(extra: Record<string, unknown> = {}) {
      const video = videoRef.current;
      const seekable =
        video && video.seekable.length > 0
          ? Array.from({ length: video.seekable.length }, (_, i) => [
              video.seekable.start(i),
              video.seekable.end(i),
            ])
          : [];
      return {
        recordingId: recordingIdRef.current,
        playbackMode,
        targetSec:
          seekTargetMsRef.current != null
            ? seekTargetMsRef.current / 1000
            : null,
        currentTime: video?.currentTime ?? null,
        readyState: video?.readyState ?? null,
        seeking: video?.seeking ?? null,
        seekable,
        paused: video?.paused ?? null,
        attempt: seekAttemptRef.current,
        ...extra,
      };
    }

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
      preparingMetaRef.current = {
        queueStatus: null,
        queuedAt: null,
        startedAt: null,
        queuePosition: null,
        previewStrategy: null,
        previewInplace: null,
      };
      setPreparingStatusText("");
      setCanProcessNext(false);
    }

    function preparingAnchorIso(meta: {
      queueStatus: string | null;
      queuedAt: string | null;
      startedAt: string | null;
    }): string | null {
      if (meta.queueStatus === "processing" && meta.startedAt) {
        return meta.startedAt;
      }
      return meta.queuedAt ?? meta.startedAt;
    }

    function shouldSuppressPlaybackError(): boolean {
      if (fallbackInProgressRef.current) {
        return true;
      }
      if (playbackMode === "preparing") {
        return true;
      }
      return playbackMode === "direct" && fallbackLevel.current >= 1;
    }

    function preparingActionLabel(
      previewStrategy: string | null,
      previewInplace: boolean | null,
    ): string {
      if (previewStrategy === "transcode") {
        return "Encoding preview";
      }
      if (previewStrategy === "stream_copy" && previewInplace) {
        return "Optimizing recording";
      }
      if (previewStrategy === "stream_copy") {
        return "Preparing file";
      }
      return "Preparing preview";
    }

    function buildPreparingStatusText(
      meta: {
        queueStatus: string | null;
        queuedAt: string | null;
        startedAt: string | null;
        queuePosition: number | null;
        previewStrategy: string | null;
        previewInplace: boolean | null;
      },
      nowMs: number,
    ): string {
      const elapsed = formatElapsed(preparingAnchorIso(meta), nowMs);
      if (meta.queueStatus === "queued") {
        const pos =
          meta.queuePosition != null ? ` · #${meta.queuePosition}` : "";
        return `Waiting in queue${pos} (${elapsed})`;
      }
      return `${preparingActionLabel(meta.previewStrategy, meta.previewInplace)}… (${elapsed})`;
    }

    function refreshPreparingStatusText() {
      setPreparingStatusText(
        buildPreparingStatusText(preparingMetaRef.current, Date.now()),
      );
    }

    function updatePreparingMeta(info: PlaybackInfo) {
      preparingMetaRef.current = {
        queueStatus: info.queueStatus ?? "processing",
        queuedAt: info.queuedAt ?? null,
        startedAt: info.startedAt ?? null,
        queuePosition: info.queuePosition ?? null,
        previewStrategy: info.previewStrategy ?? null,
        previewInplace: info.previewInplace ?? null,
      };
      const status = preparingMetaRef.current.queueStatus;
      const position = preparingMetaRef.current.queuePosition;
      setCanProcessNext(status === "queued" && (position ?? 0) > 1);
      refreshPreparingStatusText();
    }

    function preparingTimedOut(nowMs: number): boolean {
      const anchor = preparingAnchorIso(preparingMetaRef.current);
      if (!anchor) return false;
      const start = Date.parse(anchor);
      if (Number.isNaN(start)) return false;
      return nowMs - start > PREPARING_TIMEOUT_MS;
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

    function resolveScrubSeekTargetSec(video: HTMLVideoElement, ms: number): number {
      return clampToSeekableSec(video.seekable, clampToSelection(ms) / 1000);
    }

    function resolveSeekTargetSec(video: HTMLVideoElement, ms: number): number {
      return resolveLockedSeekTargetSec(
        video.seekable,
        clampToSelection(ms) / 1000,
      );
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

      const targetSec = resolveScrubSeekTargetSec(video, targetMs);
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
      seekAttemptRef.current = 0;
      seekStartedAtRef.current = null;
      lastSeekApplyAtRef.current = null;
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
      if (isPlayInterruptedError(error)) {
        return;
      }
      if (playbackMode === "direct" && fallbackLevel.current < 1) {
        logPlayback("info", "playback.fallback", seekLogFields({
          reason: "play_failed",
          fallbackLevel: 1,
        }));
        const intended = seekTargetMsRef.current;
        if (intended !== null) {
          pendingSeekAfterFallbackRef.current = intended;
        }
        if (isSeekingRef.current) {
          finishSeek();
        }
        void requestFallbackRef.current(1);
        return;
      }
      if (shouldSuppressPlaybackError()) {
        return;
      }
      onError(`Playback failed: ${String(error)}`);
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
        seekAttemptRef.current = 0;
        seekStartedAtRef.current = null;
        lastSeekApplyAtRef.current = null;
        primingPhaseRef.current = "return";
        logPlayback("info", "seek.prime", seekLogFields({ phase: "return" }));
        startLockedSeek(startMs, false, {
          supersedeQueue: true,
          primeStep: true,
        });
        return;
      }

      if (primingPhaseRef.current === "return") {
        primingPhaseRef.current = null;
        seekPrimedRef.current = true;
        const postPrimeMs = postPrimeSeekMsRef.current;
        postPrimeSeekMsRef.current = null;
        logPlayback("info", "seek.prime", seekLogFields({
          phase: "done",
          postPrimeMs,
        }));
        finishSeek();
        if (postPrimeMs !== null) {
          seekTo(postPrimeMs);
          return;
        }
        onTimeUpdate(clampToSelection(startMs));
        return;
      }

      const wasLocked = lockedSeekRef.current;
      logPlayback("info", "seek.settle", seekLogFields({ reason: "complete" }));
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

    /** Unlock UI and sync the transport clock to the element. Never remux. */
    function snapSeekToActual() {
      const video = videoRef.current;
      const postPrimeMs = postPrimeSeekMsRef.current;
      resumeAfterSeekRef.current = false;
      if (primingPhaseRef.current !== null) {
        primingPhaseRef.current = null;
        seekPrimedRef.current = true;
        postPrimeSeekMsRef.current = null;
      }
      logPlayback("warn", "seek.settle", seekLogFields({ reason: "snap" }));
      finishSeek();
      if (postPrimeMs !== null) {
        seekTo(postPrimeMs);
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
      const startedAt = seekStartedAtRef.current ?? Date.now();
      const elapsed = Date.now() - startedAt;

      if (atTarget) {
        // WebKitGTK often leaves seeking=true after currentTime already landed.
        // Priming must complete immediately; normal seeks wait briefly then accept.
        const stuckSeekingBudgetMs =
          primingPhaseRef.current !== null ? 0 : HDD_SEEK_GRACE_MS;
        if (video.seeking && elapsed < stuckSeekingBudgetMs) {
          logPlayback("info", "seek.settle", seekLogFields({
            reason: "wait",
            detail: "at_target_still_seeking",
          }));
          armSeekTimeout();
          return;
        }
        completeSeek(resumeAfterSeekRef.current);
        return;
      }

      // Off-target seeked: wait for settle timer before retrying (HDD).
      if (!fromTimeout) {
        logPlayback("info", "seek.seeked", seekLogFields({
          onTarget: false,
        }));
        return;
      }

      if (elapsed >= SEEK_MAX_MS) {
        snapSeekToActual();
        return;
      }

      const lastApply = lastSeekApplyAtRef.current ?? startedAt;
      const sinceApply = Date.now() - lastApply;

      // Do not re-issue currentTime while the engine is still seeking,
      // and respect HDD grace after an apply so range seeks are not aborted.
      // Skip grace when currentTime was never assigned (still awaiting seekable).
      if (
        video.seeking ||
        (lastSeekApplyAtRef.current !== null && sinceApply < HDD_SEEK_GRACE_MS)
      ) {
        logPlayback("info", "seek.settle", seekLogFields({
          reason: "wait",
          detail: video.seeking ? "engine_seeking" : "hdd_grace",
          sinceApplyMs: Math.round(sinceApply),
        }));
        armSeekTimeout();
        return;
      }

      if (!canApplyLockedSeek(video, targetSec)) {
        logPlayback("info", "seek.settle", seekLogFields({
          reason: "wait",
          detail: "awaiting_seekable",
        }));
        armSeekTimeout();
        return;
      }

      if (seekAttemptRef.current < LOCKED_SEEK_MAX_ATTEMPTS) {
        seekAttemptRef.current += 1;
        lastSeekApplyAtRef.current = Date.now();
        logPlayback("info", "seek.settle", seekLogFields({
          reason: "retry",
          via: "currentTime",
        }));
        applyVideoSeek(video, targetSec);
        armSeekTimeout();
        return;
      }

      snapSeekToActual();
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
        !video.seeking &&
        seekableCoversSec(video.seekable, targetSec)
      ) {
        completeSeek(resumePlayback);
        return;
      }

      if (!canApplyLockedSeek(video, targetSec)) {
        logPlayback("info", "seek.pending", seekLogFields({
          reason: "awaiting_seekable",
          targetSec,
        }));
        armSeekTimeout();
        return;
      }

      seekAttemptRef.current = 1;
      lastSeekApplyAtRef.current = Date.now();
      armSeekTimeout();
      logPlayback("info", "seek.apply", seekLogFields({
        via: "currentTime",
        attempt: 1,
      }));
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
      options?: { supersedeQueue?: boolean; primeStep?: boolean },
    ) {
      const clamped = clampToSelection(ms);

      // Queue user seeks while demuxer priming is in flight (not internal prime steps).
      if (primingPhaseRef.current !== null && !options?.primeStep) {
        postPrimeSeekMsRef.current = clamped;
        if (resumePlayback !== undefined) {
          resumeAfterSeekRef.current = resumePlayback;
        }
        lockedSeekRef.current = true;
        setSeekingLocked(true);
        logPlayback("info", "seek.prime", seekLogFields({
          phase: "queued",
          postPrimeMs: clamped,
        }));
        return;
      }

      // primeStep must run even when a user lock is already active (pending → postPrime).
      if (options?.supersedeQueue || options?.primeStep) {
        queuedLockedSeekMsRef.current = null;
        queuedLockedSeekResumeRef.current = undefined;
      } else if (interactionLockedRef.current) {
        queuedLockedSeekMsRef.current = clamped;
        queuedLockedSeekResumeRef.current = resumePlayback;
        return;
      }

      lockedSeekRef.current = true;
      // Silent demuxer priming must not flash the Seeking overlay on every open.
      if (options?.primeStep) {
        interactionLockedRef.current = true;
      } else {
        setSeekingLocked(true);
      }
      pendingSeekMsRef.current = clamped;
      seekTargetMsRef.current = clamped;
      seekAttemptRef.current = 0;
      seekStartedAtRef.current = Date.now();
      lastSeekApplyAtRef.current = null;
      isSeekingRef.current = true;
      // Always arm watchdog, including readyState < 1 / preparing.
      armSeekTimeout();

      const video = videoRef.current;
      if (video) {
        const targetSec = resolveSeekTargetSec(video, clamped);
        if (canApplyLockedSeek(video, targetSec)) {
          if (resumePlayback === undefined) {
            beginVideoSeek(video, clamped);
            return;
          }

          resumeAfterSeekRef.current = resumePlayback;
          applyLockedVideoSeek(video, clamped, resumePlayback);
          return;
        }

        logPlayback("info", "seek.pending", seekLogFields({
          reason:
            video.readyState < 1 ? "awaiting_media" : "awaiting_seekable",
          readyState: video.readyState,
        }));
      } else {
        logPlayback("info", "seek.pending", seekLogFields({
          reason: "awaiting_media",
          readyState: null,
        }));
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
      if (primingPhaseRef.current !== null) {
        postPrimeSeekMsRef.current = clamped;
        logPlayback("info", "seek.prime", seekLogFields({
          phase: "queued",
          postPrimeMs: clamped,
        }));
        return;
      }

      pendingSeekMsRef.current = clamped;
      seekTargetMsRef.current = clamped;
      seekAttemptRef.current = 0;
      seekStartedAtRef.current = Date.now();
      lastSeekApplyAtRef.current = null;
      isSeekingRef.current = true;
      armSeekTimeout();

      const video = videoRef.current;
      if (video) {
        const targetSec = resolveSeekTargetSec(video, clamped);
        if (canApplyLockedSeek(video, targetSec)) {
          beginVideoSeek(video, clamped);
          return;
        }
        logPlayback("info", "seek.pending", seekLogFields({
          reason:
            video.readyState < 1 ? "awaiting_media" : "awaiting_seekable",
        }));
        return;
      }
      logPlayback("info", "seek.pending", seekLogFields({
        reason: "awaiting_media",
      }));
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
        const video = videoRef.current;
        if (video && seekTargetMsRef.current !== null) {
          const targetSec = resolveSeekTargetSec(video, seekTargetMsRef.current);
          if (isSeekAtTargetSec(video.currentTime, targetSec)) {
            logPlayback("info", "seek.seeked", seekLogFields({ onTarget: true }));
          }
        }
        settleSeek();
        return;
      }
      if (isScrubbingRef.current) {
        handleScrubSeeked();
      }
    }

    function tryApplyPendingLockedSeek() {
      if (!isSeekingRef.current || isScrubbingRef.current) {
        return;
      }
      const video = videoRef.current;
      const targetMs = pendingSeekMsRef.current ?? seekTargetMsRef.current;
      if (!video || targetMs === null || video.readyState < 1) {
        return;
      }
      if (seekAttemptRef.current > 0 && lastSeekApplyAtRef.current !== null) {
        // Already applied at least once; settleSeek owns retries.
        return;
      }
      const resume = resumeAfterSeekRef.current;
      seekTargetMsRef.current = targetMs;
      applyLockedVideoSeek(video, targetMs, resume);
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
      if (info.mode !== "preparing") {
        fallbackInProgressRef.current = false;
      }
      setPlaybackMode(info.mode);
      if (info.mode === "preparing") {
        setPreparing(true);
        setLoading(true);
        setVideoSrc("");
        onError(null);
        updatePreparingMeta(info);
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
      if (preparingPollRef.current !== null) {
        return;
      }
      preparingElapsedRef.current = window.setInterval(() => {
        refreshPreparingStatusText();
      }, PREPARING_ELAPSED_TICK_MS);
      preparingPollRef.current = window.setInterval(() => {
        if (preparingTimedOut(Date.now())) {
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
      const requestedId = recordingId;
      try {
        const info = await getPlaybackInfo(requestedId);
        if (loadCancelledRef.current || recordingIdRef.current !== requestedId) {
          return;
        }
        if (info.mode !== "preparing") {
          applyPlaybackInfo(info);
        } else {
          updatePreparingMeta(info);
        }
      } catch (e) {
        if (loadCancelledRef.current || recordingIdRef.current !== requestedId) {
          return;
        }
        clearPreparingPoll();
        setPreparing(false);
        setLoading(false);
        onError(`Preview preparation failed: ${String(e)}`);
      }
    }

    async function processNext() {
      const requestedId = recordingId;
      try {
        await prioritizePreviewForRecording(requestedId);
        if (loadCancelledRef.current || recordingIdRef.current !== requestedId) {
          return;
        }
        const info = await getPlaybackInfo(requestedId);
        if (loadCancelledRef.current || recordingIdRef.current !== requestedId) {
          return;
        }
        if (info.mode === "preparing") {
          updatePreparingMeta(info);
        } else {
          applyPlaybackInfo(info);
        }
      } catch (e) {
        if (loadCancelledRef.current || recordingIdRef.current !== requestedId) {
          return;
        }
        onError(`Could not move preview to the front of the queue: ${String(e)}`);
      }
    }

    async function requestFallback(level: 1 | 2) {
      if (fallbackLevel.current >= level) return;
      const intended =
        pendingSeekAfterFallbackRef.current ??
        seekTargetMsRef.current ??
        pendingSeekMsRef.current;
      if (intended !== null) {
        pendingSeekAfterFallbackRef.current = intended;
      }
      const video = videoRef.current;
      if (isSeekingRef.current) {
        if (video) {
          onTimeUpdate(clampToSelection(video.currentTime * 1000));
        }
        finishSeek();
      }
      fallbackLevel.current = level;
      fallbackInProgressRef.current = true;
      setLoading(true);
      setPreparing(true);
      setHasPaintedFrame(false);
      setVideoSrc("");
      onError(null);
      clearPlaybackTimers();
      logPlayback("info", "playback.fallback", {
        recordingId: recordingIdRef.current,
        playbackMode,
        fallbackLevel: level,
        intendedMs: intended,
      });
      const requestedId = recordingId;
      try {
        const info = await getPlaybackInfo(requestedId, {
          forceFallback: true,
          fallbackLevel: level,
        });
        if (loadCancelledRef.current || recordingIdRef.current !== requestedId) {
          fallbackInProgressRef.current = false;
          return;
        }
        applyPlaybackInfo(info);
      } catch (e) {
        fallbackInProgressRef.current = false;
        if (loadCancelledRef.current || recordingIdRef.current !== requestedId) {
          return;
        }
        onError(`Playback fallback failed: ${String(e)}`);
        setLoading(false);
        setPreparing(false);
      }
    }

    requestFallbackRef.current = requestFallback;

    async function handleLoadTimeout() {
      if (playbackMode === "direct" && fallbackLevel.current < 1) {
        logPlayback("info", "playback.fallback", seekLogFields({
          reason: "metadata_timeout",
          fallbackLevel: 1,
        }));
        await requestFallback(1);
        return;
      }
      if (playbackMode === "cache" && fallbackLevel.current < 2) {
        logPlayback("info", "playback.fallback", seekLogFields({
          reason: "metadata_timeout",
          fallbackLevel: 2,
        }));
        await requestFallback(2);
        return;
      }
      if (shouldSuppressPlaybackError()) {
        return;
      }
      onError(
        `Video playback timed out (${playbackMode}). Check that the file exists and the media server is running.`,
      );
    }

    useEffect(() => {
      missingNotified.current = false;
      fallbackLevel.current = 0;
      fallbackInProgressRef.current = false;
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
      seekAttemptRef.current = 0;
      seekStartedAtRef.current = null;
      lastSeekApplyAtRef.current = null;
      queuedLockedSeekMsRef.current = null;
      queuedLockedSeekResumeRef.current = undefined;
      resumeAfterSeekRef.current = false;
      pendingSeekAfterFallbackRef.current = null;
      setSeekingUi(false);
      setLoading(true);
      setPreparing(false);
      setHasPaintedFrame(false);
      setVideoSrc("");
      clearPlaybackTimers();

      loadCancelledRef.current = false;
      let cancelled = false;
      (async () => {
        try {
          const info = await getPlaybackInfo(recordingId);
          if (!cancelled && recordingIdRef.current === recordingId) {
            applyPlaybackInfo(info);
          }
        } catch (e) {
          if (!cancelled && recordingIdRef.current === recordingId) {
            onError(`Media server unavailable: ${String(e)}`);
            setLoading(false);
          }
        }
      })();

      return () => {
        cancelled = true;
        loadCancelledRef.current = true;
        fallbackInProgressRef.current = false;
        clearPlaybackTimers();
        clearScrubSeekTimeout();
      };
    }, [recordingId, onError]);

    useImperativeHandle(ref, () => ({
      play: async () => {
        const video = videoRef.current;
        if (!video || interactionLockedRef.current || isSeekingRef.current) {
          if (interactionLockedRef.current || isSeekingRef.current) {
            logPlayback("info", "seek.blocked_play", seekLogFields());
          }
          return;
        }
        if (!video.paused) return;

        endedNaturally.current = false;
        const ms = video.currentTime * 1000;
        if (ms < startMs || ms >= endMs) {
          seekTo(startMs);
          if (isSeekingRef.current) {
            await new Promise<void>((resolve) => {
              let settled = false;
              const finish = () => {
                if (settled) return;
                settled = true;
                video.removeEventListener("seeked", onSeeked);
                window.clearTimeout(timeoutId);
                resolve();
              };
              const onSeeked = () => finish();
              const timeoutId = window.setTimeout(finish, SEEKED_WAIT_TIMEOUT_MS);
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

      const video = videoRef.current;
      const mediaError = video?.error;
      logPlayback("error", "playback.media_error", seekLogFields({
        code: mediaError?.code ?? null,
        message: mediaError?.message ?? null,
      }));

      // Transient network/abort on HDD: keep the intended seek, reload src.
      if (
        mediaError &&
        (mediaError.code === mediaError.MEDIA_ERR_ABORTED ||
          mediaError.code === mediaError.MEDIA_ERR_NETWORK) &&
        videoSrc &&
        !fallbackInProgressRef.current
      ) {
        const intended =
          seekTargetMsRef.current ??
          pendingSeekMsRef.current ??
          pendingSeekAfterFallbackRef.current;
        if (intended !== null) {
          pendingSeekAfterFallbackRef.current = intended;
        }
        if (isSeekingRef.current) {
          finishSeek();
        }
        const src = videoSrc;
        setVideoSrc("");
        window.setTimeout(() => {
          if (loadCancelledRef.current) return;
          setVideoSrc(src);
          armLoadTimeout();
        }, 0);
        return;
      }

      if (playbackMode === "direct" && fallbackLevel.current < 1) {
        logPlayback("info", "playback.fallback", seekLogFields({
          reason: "video_error",
          fallbackLevel: 1,
        }));
        void requestFallback(1);
        return;
      }
      if (playbackMode === "cache" && fallbackLevel.current < 2) {
        logPlayback("info", "playback.fallback", seekLogFields({
          reason: "video_error",
          fallbackLevel: 2,
        }));
        void requestFallback(2);
        return;
      }
      if (shouldSuppressPlaybackError()) {
        return;
      }

      onError(
        `Video playback failed (${playbackMode}). Check that the file exists and the media server is running.`,
      );
      if (missingNotified.current) return;
      missingNotified.current = true;
      onMissingFile?.();
    }

    const videoPreload =
      videoSrc && !preparing
        ? hasPaintedFrame
          ? "metadata"
          : "auto"
        : "metadata";

    return (
      <div className="video-player">
        <video
          ref={setVideoRef}
          key={videoSrc}
          src={videoSrc || undefined}
          preload={videoPreload}
          playsInline
          onClick={() => {
            const video = videoRef.current;
            if (!video || interactionLockedRef.current || isSeekingRef.current) {
              if (interactionLockedRef.current || isSeekingRef.current) {
                logPlayback("info", "seek.blocked_play", seekLogFields());
              }
              return;
            }
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
            const fallbackSeekMs = pendingSeekAfterFallbackRef.current;
            if (fallbackSeekMs !== null) {
              pendingSeekAfterFallbackRef.current = null;
              seekPrimedRef.current = true;
              startLockedSeek(fallbackSeekMs);
              return;
            }
            if (lockedSeekRef.current && pendingSeekMsRef.current !== null) {
              // User already requested a seek; still warm demuxer first.
              if (!seekPrimedRef.current) {
                const primeMs = clampToSelection(
                  startMs + SEEK_PRIME_OFFSET_SEC * 1000,
                );
                if (Math.abs(primeMs - startMs) >= 1) {
                  postPrimeSeekMsRef.current = pendingSeekMsRef.current;
                  primingPhaseRef.current = "offset";
                  logPlayback("info", "seek.prime", seekLogFields({
                    phase: "offset",
                    primeMs,
                  }));
                  startLockedSeek(primeMs, false, { primeStep: true });
                  return;
                }
                seekPrimedRef.current = true;
              }
              const clamped = pendingSeekMsRef.current;
              const resume = resumeAfterSeekRef.current;
              seekTargetMsRef.current = clamped;
              seekAttemptRef.current = 0;
              seekStartedAtRef.current = Date.now();
              lastSeekApplyAtRef.current = null;
              isSeekingRef.current = true;
              armSeekTimeout();
              if (video) {
                const targetSec = resolveSeekTargetSec(video, clamped);
                if (canApplyLockedSeek(video, targetSec)) {
                  applyLockedVideoSeek(video, clamped, resume);
                } else {
                  logPlayback("info", "seek.pending", seekLogFields({
                    reason: "awaiting_seekable",
                  }));
                }
              }
              return;
            }
            if (seekPrimedRef.current) {
              if (pendingSeekMsRef.current !== null) {
                seekTo(pendingSeekMsRef.current);
              }
              return;
            }
            const primeMs = clampToSelection(
              startMs + SEEK_PRIME_OFFSET_SEC * 1000,
            );
            if (Math.abs(primeMs - startMs) < 1) {
              seekPrimedRef.current = true;
              if (pendingSeekMsRef.current !== null) {
                seekTo(pendingSeekMsRef.current);
              } else if (
                video &&
                Math.abs(video.currentTime * 1000 - startMs) >= 1
              ) {
                seekTo(startMs);
              }
              return;
            }
            postPrimeSeekMsRef.current = pendingSeekMsRef.current;
            primingPhaseRef.current = "offset";
            logPlayback("info", "seek.prime", seekLogFields({
              phase: "offset",
              primeMs,
            }));
            startLockedSeek(primeMs, false, { primeStep: true });
          }}
          onLoadedData={() => {
            setHasPaintedFrame(true);
            tryApplyPendingLockedSeek();
          }}
          onCanPlay={() => {
            tryApplyPendingLockedSeek();
          }}
          onProgress={() => {
            tryApplyPendingLockedSeek();
          }}
          onDurationChange={() => {
            tryApplyPendingLockedSeek();
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
            <span>{preparingStatusText}</span>
            {canProcessNext && (
              <button
                type="button"
                className="video-player__process-next"
                onClick={() => void processNext()}
              >
                Process next
              </button>
            )}
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
