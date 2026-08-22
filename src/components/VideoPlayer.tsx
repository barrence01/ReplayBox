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
  SEEK_SETTLE_MS,
  applyVideoSeek,
  clampToSeekableSec,
  isSeekAtTargetSec,
} from "../lib/videoSeek";

export interface VideoPlayerHandle {
  play: () => Promise<void>;
  pause: () => void;
  seekTo: (ms: number) => void;
  getCurrentMs: () => number;
  isPaused: () => boolean;
}

interface Props {
  recordingId: string;
  startMs: number;
  endMs: number;
  onTimeUpdate: (ms: number) => void;
  onPlayingChange: (playing: boolean) => void;
  onError: (message: string | null) => void;
  onDurationChange?: (ms: number) => void;
  onMissingFile?: () => void;
}

const LOAD_TIMEOUT_MS = 15_000;
const PREPARING_TIMEOUT_MS = 120_000;
const PREPARING_POLL_MS = 500;
const PREPARING_ELAPSED_TICK_MS = 1000;

export const VideoPlayer = forwardRef<VideoPlayerHandle, Props>(
  function VideoPlayer(
    {
      recordingId,
      startMs,
      endMs,
      onTimeUpdate,
      onPlayingChange,
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
    const pendingSeekMsRef = useRef<number | null>(null);
    const seekTargetMsRef = useRef<number | null>(null);
    const seekRetriedRef = useRef(false);
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

    function finishSeek() {
      clearSeekTimeout();
      isSeekingRef.current = false;
      pendingSeekMsRef.current = null;
      seekTargetMsRef.current = null;
      seekRetriedRef.current = false;
    }

    function clampToSelection(ms: number): number {
      return Math.min(Math.max(ms, startMs), endMs);
    }

    function resolveSeekTargetSec(video: HTMLVideoElement, ms: number): number {
      return clampToSeekableSec(video.seekable, clampToSelection(ms) / 1000);
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

      finishSeek();
      const ms = video.currentTime * 1000;
      if (ms < startMs) {
        seekTo(startMs);
        return;
      }
      onTimeUpdate(clampToSelection(ms));

      if (resumePlayback) {
        resumeAfterSeekRef.current = false;
        void video.play().catch(reportPlayError);
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
      if (isSeekAtTargetSec(video.currentTime, targetSec)) {
        completeSeek(resumeAfterSeekRef.current);
        return;
      }

      if (!seekRetriedRef.current) {
        seekRetriedRef.current = true;
        armSeekTimeout();
        applyVideoSeek(video, targetSec);
        return;
      }

      if (!fromTimeout) {
        armSeekTimeout();
        return;
      }

      completeSeek(resumeAfterSeekRef.current);
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

    function beginVideoSeek(video: HTMLVideoElement, targetMs: number) {
      const wasPlaying = !video.paused;
      resumeAfterSeekRef.current = wasPlaying;
      if (wasPlaying) {
        video.pause();
      }

      const targetSec = resolveSeekTargetSec(video, targetMs);

      if (Math.abs(video.currentTime - targetSec) < 0.001) {
        completeSeek(wasPlaying);
        return;
      }

      armSeekTimeout();
      applyVideoSeek(video, targetSec);
    }

    function seekTo(ms: number) {
      const clamped = clampToSelection(ms);
      pendingSeekMsRef.current = clamped;
      seekTargetMsRef.current = clamped;
      seekRetriedRef.current = false;
      isSeekingRef.current = true;

      const video = videoRef.current;
      if (video && video.readyState >= 1) {
        beginVideoSeek(video, clamped);
      }
    }

    function handleSeeked() {
      if (!isSeekingRef.current) return;
      settleSeek();
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
      pendingSeekMsRef.current = null;
      seekTargetMsRef.current = null;
      seekRetriedRef.current = false;
      resumeAfterSeekRef.current = false;
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
      };
    }, [recordingId, onError]);

    useImperativeHandle(ref, () => ({
      play: async () => {
        const video = videoRef.current;
        if (!video) return;
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
      if (!video || isSeekingRef.current) return;

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
            if (!video) return;
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
            seekTo(pendingSeekMsRef.current ?? startMs);
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
      </div>
    );
  },
);
