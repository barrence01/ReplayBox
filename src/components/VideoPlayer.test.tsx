import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { VideoPlayer, type VideoPlayerHandle } from "../components/VideoPlayer";

const getPlaybackInfoMock = vi.fn();

vi.mock("../lib/api", () => ({
  getPlaybackInfo: (...args: unknown[]) => getPlaybackInfoMock(...args),
}));

describe("VideoPlayer", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  beforeEach(() => {
    getPlaybackInfoMock.mockReset();

    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      value: vi.fn().mockResolvedValue(undefined),
    });
    Object.defineProperty(HTMLMediaElement.prototype, "pause", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("loads direct playback url on mount", async () => {
    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "direct",
    });

    const { container } = render(
      <VideoPlayer
        recordingId="rec-1"
        startMs={0}
        endMs={1000}
        onTimeUpdate={() => undefined}
        onPlayingChange={() => undefined}
        onError={() => undefined}
      />,
    );

    await waitFor(() => {
      const video = container.querySelector("video");
      expect(video?.getAttribute("src")).toBe(
        "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      );
    });

    expect(getPlaybackInfoMock).toHaveBeenCalledWith("rec-1");
  });

  it("requests cache remux fallback after direct error", async () => {
    getPlaybackInfoMock
      .mockResolvedValueOnce({
        url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
        mode: "direct",
      })
      .mockResolvedValueOnce({
        url: "",
        mode: "preparing",
      })
      .mockResolvedValueOnce({
        url: "http://127.0.0.1:1/media?path=%2Fcache%2Fclip.mp4",
        mode: "cache",
      });

    const onError = vi.fn();
    const { container } = render(
      <VideoPlayer
        recordingId="rec-1"
        startMs={0}
        endMs={1000}
        onTimeUpdate={() => undefined}
        onPlayingChange={() => undefined}
        onError={onError}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    video.dispatchEvent(new Event("error"));

    await waitFor(() => {
      expect(getPlaybackInfoMock).toHaveBeenCalledWith("rec-1", {
        forceFallback: true,
        fallbackLevel: 1,
      });
    });

    expect(onError).toHaveBeenCalledWith(null);
  });

  it("cascades from cache remux to transcode on error", async () => {
    getPlaybackInfoMock
      .mockResolvedValueOnce({
        url: "http://127.0.0.1:1/media?path=%2Fcache%2Fclip.mp4",
        mode: "cache",
      })
      .mockResolvedValueOnce({
        url: "",
        mode: "preparing",
      });

    const onError = vi.fn();
    const { container } = render(
      <VideoPlayer
        recordingId="rec-1"
        startMs={0}
        endMs={1000}
        onTimeUpdate={() => undefined}
        onPlayingChange={() => undefined}
        onError={onError}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    video.dispatchEvent(new Event("error"));

    await waitFor(() => {
      expect(getPlaybackInfoMock).toHaveBeenCalledWith("rec-1", {
        forceFallback: true,
        fallbackLevel: 2,
      });
    });

    expect(onError).toHaveBeenCalledWith(null);
  });

  it("onEnded does not report playback error", async () => {
    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fcache%2Fclip.mp4",
      mode: "cache",
    });

    const onError = vi.fn();
    const onTimeUpdate = vi.fn();
    const { container } = render(
      <VideoPlayer
        recordingId="rec-1"
        startMs={0}
        endMs={1000}
        onTimeUpdate={onTimeUpdate}
        onPlayingChange={() => undefined}
        onError={onError}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    video.dispatchEvent(new Event("ended"));

    expect(onError).not.toHaveBeenCalledWith(
      expect.stringContaining("Video playback failed"),
    );
    expect(onTimeUpdate).toHaveBeenCalledWith(0);
  });

  it("polls preparing until cache is ready", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getPlaybackInfoMock
      .mockResolvedValueOnce({
        url: "",
        mode: "preparing",
      })
      .mockResolvedValueOnce({
        url: "",
        mode: "preparing",
      })
      .mockResolvedValueOnce({
        url: "http://127.0.0.1:1/media?path=%2Fcache%2Fclip.mp4",
        mode: "cache",
      });

    const { container } = render(
      <VideoPlayer
        recordingId="rec-1"
        startMs={0}
        endMs={1000}
        onTimeUpdate={() => undefined}
        onPlayingChange={() => undefined}
        onError={() => undefined}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    await waitFor(() => {
      const video = container.querySelector("video");
      expect(video?.getAttribute("src")).toBe(
        "http://127.0.0.1:1/media?path=%2Fcache%2Fclip.mp4",
      );
    });

    expect(getPlaybackInfoMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("shows elapsed seconds while preparing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getPlaybackInfoMock.mockResolvedValue({
      url: "",
      mode: "preparing",
    });

    const { container } = render(
      <VideoPlayer
        recordingId="rec-1"
        startMs={0}
        endMs={1000}
        onTimeUpdate={() => undefined}
        onPlayingChange={() => undefined}
        onError={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(container.textContent).toContain("Preparing preview… (0s)");
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(container.textContent).toContain("Preparing preview… (3s)");
  });

  it("stops poll when getPlaybackInfo throws", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getPlaybackInfoMock
      .mockResolvedValueOnce({
        url: "",
        mode: "preparing",
      })
      .mockRejectedValueOnce(new Error("Preview preparation failed: boom"));

    const onError = vi.fn();
    render(
      <VideoPlayer
        recordingId="rec-1"
        startMs={0}
        endMs={1000}
        onTimeUpdate={() => undefined}
        onPlayingChange={() => undefined}
        onError={onError}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(
        expect.stringContaining("Preview preparation failed"),
      );
    });

    const callsAfterError = getPlaybackInfoMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(getPlaybackInfoMock.mock.calls.length).toBe(callsAfterError);
  });

  it("does not revert seek when timeupdate fires with stale time during seek", async () => {
    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "cache",
    });

    const onTimeUpdate = vi.fn();
    const ref = createRef<VideoPlayerHandle>();
    const { container } = render(
      <VideoPlayer
        ref={ref}
        recordingId="rec-1"
        startMs={0}
        endMs={10_000}
        onTimeUpdate={onTimeUpdate}
        onPlayingChange={() => undefined}
        onError={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      writable: true,
      value: 1,
    });

    onTimeUpdate.mockClear();
    ref.current?.seekTo(5000);
    expect(onTimeUpdate).not.toHaveBeenCalled();

    Object.defineProperty(video, "currentTime", {
      configurable: true,
      writable: true,
      value: 1,
    });
    video.dispatchEvent(new Event("timeupdate"));
    expect(onTimeUpdate).not.toHaveBeenCalled();
  });

  it("syncs UI to actual video time on seeked", async () => {
    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "cache",
    });

    const onTimeUpdate = vi.fn();
    const ref = createRef<VideoPlayerHandle>();
    const { container } = render(
      <VideoPlayer
        ref={ref}
        recordingId="rec-1"
        startMs={0}
        endMs={10_000}
        onTimeUpdate={onTimeUpdate}
        onPlayingChange={() => undefined}
        onError={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      writable: true,
      value: 0,
    });

    onTimeUpdate.mockClear();
    ref.current?.seekTo(500);
    expect(onTimeUpdate).not.toHaveBeenCalled();

    Object.defineProperty(video, "currentTime", {
      configurable: true,
      writable: true,
      value: 0.48,
    });
    video.dispatchEvent(new Event("seeked"));

    expect(onTimeUpdate).toHaveBeenLastCalledWith(480);
  });

  it("applies pending seek after metadata loads", async () => {
    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "cache",
    });

    const onTimeUpdate = vi.fn();
    const ref = createRef<VideoPlayerHandle>();
    const { container } = render(
      <VideoPlayer
        ref={ref}
        recordingId="rec-1"
        startMs={0}
        endMs={10_000}
        onTimeUpdate={onTimeUpdate}
        onPlayingChange={() => undefined}
        onError={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "readyState", { configurable: true, value: 0 });
    Object.defineProperty(video, "paused", {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(video, "seeking", {
      configurable: true,
      get: () => false,
    });

    onTimeUpdate.mockClear();
    ref.current?.seekTo(500);
    expect(onTimeUpdate).not.toHaveBeenCalled();

    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    let currentTimeSec = 0;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTimeSec,
      set: (value: number) => {
        currentTimeSec = value;
      },
    });
    video.dispatchEvent(new Event("loadedmetadata"));

    // Seek priming warms demuxer at +1s before applying the pending user seek.
    expect(currentTimeSec).toBe(1);

    video.dispatchEvent(new Event("seeked"));
    expect(currentTimeSec).toBe(0);

    video.dispatchEvent(new Event("seeked"));
    expect(currentTimeSec).toBe(0.5);
  });

  it("uses preload auto when video src is ready", async () => {
    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "cache",
    });

    const { container } = render(
      <VideoPlayer
        recordingId="rec-1"
        startMs={0}
        endMs={1000}
        onTimeUpdate={() => undefined}
        onPlayingChange={() => undefined}
        onError={() => undefined}
      />,
    );

    await waitFor(() => {
      const video = container.querySelector("video");
      expect(video?.getAttribute("preload")).toBe("auto");
    });
  });

  it("waits for target when seeked fires before currentTime updates", async () => {
    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "cache",
    });

    const onTimeUpdate = vi.fn();
    const ref = createRef<VideoPlayerHandle>();
    const { container } = render(
      <VideoPlayer
        ref={ref}
        recordingId="rec-1"
        startMs={0}
        endMs={10_000}
        onTimeUpdate={onTimeUpdate}
        onPlayingChange={() => undefined}
        onError={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    let currentTimeSec = 1;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTimeSec,
      set: () => undefined,
    });

    onTimeUpdate.mockClear();
    ref.current?.seekTo(5000);
    expect(onTimeUpdate).not.toHaveBeenCalled();

    video.dispatchEvent(new Event("seeked"));
    expect(onTimeUpdate).not.toHaveBeenCalled();

    currentTimeSec = 5;
    video.dispatchEvent(new Event("seeked"));

    expect(onTimeUpdate).toHaveBeenLastCalledWith(5000);
  });

  it("does not report AbortError when resume play is interrupted", async () => {
    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "cache",
    });

    const onError = vi.fn();
    const ref = createRef<VideoPlayerHandle>();
    const { container } = render(
      <VideoPlayer
        ref={ref}
        recordingId="rec-1"
        startMs={0}
        endMs={10_000}
        onTimeUpdate={() => undefined}
        onPlayingChange={() => undefined}
        onError={onError}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    onError.mockClear();

    const video = container.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "paused", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      writable: true,
      value: 1,
    });
    Object.defineProperty(video, "play", {
      configurable: true,
      value: vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError")),
    });

    ref.current?.seekTo(5000);
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      writable: true,
      value: 5,
    });
    video.dispatchEvent(new Event("seeked"));

    await waitFor(() => {
      expect(video.play).toHaveBeenCalled();
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("clears seeking state when seeked event never fires", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "cache",
    });

    const onTimeUpdate = vi.fn();
    const ref = createRef<VideoPlayerHandle>();
    const { container } = render(
      <VideoPlayer
        ref={ref}
        recordingId="rec-1"
        startMs={0}
        endMs={10_000}
        onTimeUpdate={onTimeUpdate}
        onPlayingChange={() => undefined}
        onError={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    let stuckTimeSec = 1;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => stuckTimeSec,
      set: () => undefined,
    });

    onTimeUpdate.mockClear();
    ref.current?.seekTo(5000);
    expect(onTimeUpdate).not.toHaveBeenCalled();

    onTimeUpdate.mockClear();
    video.dispatchEvent(new Event("timeupdate"));
    expect(onTimeUpdate).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2600);
    });

    expect(onTimeUpdate).toHaveBeenCalledWith(5000);

    onTimeUpdate.mockClear();
    video.dispatchEvent(new Event("timeupdate"));
    expect(onTimeUpdate).toHaveBeenCalledWith(1000);
  });

  it("reports video duration on loaded metadata", async () => {
    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "cache",
    });

    const onDurationChange = vi.fn();
    const { container } = render(
      <VideoPlayer
        recordingId="rec-1"
        startMs={0}
        endMs={10_000}
        onTimeUpdate={() => undefined}
        onPlayingChange={() => undefined}
        onError={() => undefined}
        onDurationChange={onDurationChange}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "duration", {
      configurable: true,
      value: 12.5,
    });
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    video.dispatchEvent(new Event("loadedmetadata"));

    expect(onDurationChange).toHaveBeenCalledWith(12_500);
  });

  it("beginScrub pauses playing video", async () => {
    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "cache",
    });

    const ref = createRef<VideoPlayerHandle>();
    const { container } = render(
      <VideoPlayer
        ref={ref}
        recordingId="rec-1"
        startMs={0}
        endMs={10_000}
        onTimeUpdate={() => undefined}
        onPlayingChange={() => undefined}
        onError={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "paused", {
      configurable: true,
      get: () => false,
    });

    ref.current?.beginScrub();
    expect(video.pause).toHaveBeenCalled();
  });

  it("scrubTo updates time immediately", async () => {
    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "cache",
    });

    const onTimeUpdate = vi.fn();
    const ref = createRef<VideoPlayerHandle>();
    const { container } = render(
      <VideoPlayer
        ref={ref}
        recordingId="rec-1"
        startMs={0}
        endMs={10_000}
        onTimeUpdate={onTimeUpdate}
        onPlayingChange={() => undefined}
        onError={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      writable: true,
      value: 0,
    });

    onTimeUpdate.mockClear();
    ref.current?.beginScrub();
    ref.current?.scrubTo(2500);

    expect(onTimeUpdate).toHaveBeenCalledWith(2500);
  });

  it("endScrubAndLock resumes playback when scrub started while playing", async () => {
    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "cache",
    });

    const onTimeUpdate = vi.fn();
    const ref = createRef<VideoPlayerHandle>();
    const { container } = render(
      <VideoPlayer
        ref={ref}
        recordingId="rec-1"
        startMs={0}
        endMs={10_000}
        onTimeUpdate={onTimeUpdate}
        onPlayingChange={() => undefined}
        onError={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      writable: true,
      value: 0,
    });

    let paused = false;
    Object.defineProperty(video, "paused", {
      configurable: true,
      get: () => paused,
    });

    ref.current?.beginScrub();
    expect(video.pause).toHaveBeenCalled();
    paused = true;

    ref.current?.endScrubAndLock(5000);

    Object.defineProperty(video, "currentTime", {
      configurable: true,
      writable: true,
      value: 5,
    });
    video.dispatchEvent(new Event("seeked"));

    await waitFor(() => {
      expect(video.play).toHaveBeenCalled();
    });
  });

  it("endScrubAndLock does not resume when scrub started while paused", async () => {
    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "cache",
    });

    const ref = createRef<VideoPlayerHandle>();
    const { container } = render(
      <VideoPlayer
        ref={ref}
        recordingId="rec-1"
        startMs={0}
        endMs={10_000}
        onTimeUpdate={() => undefined}
        onPlayingChange={() => undefined}
        onError={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "paused", {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      writable: true,
      value: 0,
    });

    ref.current?.beginScrub();
    ref.current?.endScrubAndLock(5000);

    Object.defineProperty(video, "currentTime", {
      configurable: true,
      writable: true,
      value: 5,
    });
    video.dispatchEvent(new Event("seeked"));

    expect(video.play).not.toHaveBeenCalled();
  });

  it("ignores timeupdate while scrubbing", async () => {
    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "cache",
    });

    const onTimeUpdate = vi.fn();
    const ref = createRef<VideoPlayerHandle>();
    const { container } = render(
      <VideoPlayer
        ref={ref}
        recordingId="rec-1"
        startMs={0}
        endMs={10_000}
        onTimeUpdate={onTimeUpdate}
        onPlayingChange={() => undefined}
        onError={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      writable: true,
      value: 1,
    });

    ref.current?.beginScrub();
    ref.current?.scrubTo(3000);
    onTimeUpdate.mockClear();

    video.dispatchEvent(new Event("timeupdate"));
    expect(onTimeUpdate).not.toHaveBeenCalled();
  });

  it("seekAndLock toggles onSeekingChange until seek settles", async () => {
    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "cache",
    });

    const onSeekingChange = vi.fn();
    const ref = createRef<VideoPlayerHandle>();
    const { container } = render(
      <VideoPlayer
        ref={ref}
        recordingId="rec-1"
        startMs={0}
        endMs={10_000}
        onTimeUpdate={() => undefined}
        onPlayingChange={() => undefined}
        onSeekingChange={onSeekingChange}
        onError={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      writable: true,
      value: 0,
    });

    ref.current?.seekAndLock(2500);
    expect(onSeekingChange).toHaveBeenCalledWith(true);

    Object.defineProperty(video, "currentTime", {
      configurable: true,
      writable: true,
      value: 2.5,
    });
    video.dispatchEvent(new Event("seeked"));

    await waitFor(() => {
      expect(onSeekingChange).toHaveBeenLastCalledWith(false);
    });
  });

  it("seekAndLock queues a second seek while locked", async () => {
    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "cache",
    });

    const ref = createRef<VideoPlayerHandle>();
    const { container } = render(
      <VideoPlayer
        ref={ref}
        recordingId="rec-1"
        startMs={0}
        endMs={10_000}
        onTimeUpdate={() => undefined}
        onPlayingChange={() => undefined}
        onError={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    let currentTimeSec = 0;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTimeSec,
      set: (value: number) => {
        currentTimeSec = value;
      },
    });

    ref.current?.seekAndLock(2500);
    ref.current?.seekAndLock(8000);

    expect(currentTimeSec).toBe(2.5);
  });

  it("scrubTo does not trigger onSeekingChange", async () => {
    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "cache",
    });

    const onSeekingChange = vi.fn();
    const ref = createRef<VideoPlayerHandle>();
    const { container } = render(
      <VideoPlayer
        ref={ref}
        recordingId="rec-1"
        startMs={0}
        endMs={10_000}
        onTimeUpdate={() => undefined}
        onPlayingChange={() => undefined}
        onSeekingChange={onSeekingChange}
        onError={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      writable: true,
      value: 0,
    });

    ref.current?.beginScrub();
    ref.current?.scrubTo(3000);

    expect(onSeekingChange).not.toHaveBeenCalled();
  });

  it("scrubTo uses fastSeek when available", async () => {
    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "cache",
    });

    const ref = createRef<VideoPlayerHandle>();
    const { container } = render(
      <VideoPlayer
        ref={ref}
        recordingId="rec-1"
        startMs={0}
        endMs={10_000}
        onTimeUpdate={() => undefined}
        onPlayingChange={() => undefined}
        onError={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    const fastSeek = vi.fn();
    Object.defineProperty(video, "fastSeek", {
      configurable: true,
      value: fastSeek,
    });
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      writable: true,
      value: 0,
    });

    ref.current?.beginScrub();
    ref.current?.scrubTo(2500);

    expect(fastSeek).toHaveBeenCalledWith(2.5);
  });

  it("seeked during scrub applies coalesced target", async () => {
    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "cache",
    });

    const ref = createRef<VideoPlayerHandle>();
    const { container } = render(
      <VideoPlayer
        ref={ref}
        recordingId="rec-1"
        startMs={0}
        endMs={10_000}
        onTimeUpdate={() => undefined}
        onPlayingChange={() => undefined}
        onError={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    const fastSeek = vi.fn();
    Object.defineProperty(video, "fastSeek", {
      configurable: true,
      value: fastSeek,
    });
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      writable: true,
      value: 0,
    });

    ref.current?.beginScrub();
    ref.current?.scrubTo(1000);
    ref.current?.scrubTo(8000);

    expect(fastSeek).toHaveBeenCalledTimes(1);
    expect(fastSeek).toHaveBeenLastCalledWith(1);

    video.dispatchEvent(new Event("seeked"));

    expect(fastSeek).toHaveBeenCalledTimes(2);
    expect(fastSeek).toHaveBeenLastCalledWith(8);
  });

  it("endScrubAndLock uses precise seek without fastSeek", async () => {
    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "cache",
    });

    const ref = createRef<VideoPlayerHandle>();
    const { container } = render(
      <VideoPlayer
        ref={ref}
        recordingId="rec-1"
        startMs={0}
        endMs={10_000}
        onTimeUpdate={() => undefined}
        onPlayingChange={() => undefined}
        onError={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    const fastSeek = vi.fn();
    Object.defineProperty(video, "fastSeek", {
      configurable: true,
      value: fastSeek,
    });
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "paused", {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    let currentTimeSec = 0;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTimeSec,
      set: (value: number) => {
        currentTimeSec = value;
      },
    });

    ref.current?.beginScrub();
    ref.current?.scrubTo(5000);
    expect(fastSeek).toHaveBeenCalledTimes(1);
    fastSeek.mockClear();

    ref.current?.endScrubAndLock(5000);
    expect(fastSeek).not.toHaveBeenCalled();
    expect(currentTimeSec).toBe(5);
  });

  it("endScrubAndLock early-completes when already near target", async () => {
    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "cache",
    });

    const onSeekingChange = vi.fn();
    const ref = createRef<VideoPlayerHandle>();
    const { container } = render(
      <VideoPlayer
        ref={ref}
        recordingId="rec-1"
        startMs={0}
        endMs={10_000}
        onTimeUpdate={() => undefined}
        onPlayingChange={() => undefined}
        onSeekingChange={onSeekingChange}
        onError={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    const fastSeek = vi.fn();
    Object.defineProperty(video, "fastSeek", {
      configurable: true,
      value: fastSeek,
    });
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "paused", {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(video, "seeking", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    let currentTimeSec = 5.0005;
    const assigned: number[] = [];
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTimeSec,
      set: (value: number) => {
        currentTimeSec = value;
        assigned.push(value);
      },
    });

    ref.current?.beginScrub();
    ref.current?.scrubTo(5000);
    expect(fastSeek).toHaveBeenCalledWith(5);
    expect(assigned).toEqual([]);

    onSeekingChange.mockClear();

    ref.current?.endScrubAndLock(5000);

    expect(onSeekingChange).toHaveBeenLastCalledWith(false);
    expect(assigned).toEqual([]);
    expect(currentTimeSec).toBe(5.0005);
  });

  it("does not complete locked seek while video.seeking is true", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "cache",
    });

    const onSeekingChange = vi.fn();
    const onTimeUpdate = vi.fn();
    const ref = createRef<VideoPlayerHandle>();
    const { container } = render(
      <VideoPlayer
        ref={ref}
        recordingId="rec-1"
        startMs={0}
        endMs={10_000}
        onTimeUpdate={onTimeUpdate}
        onPlayingChange={() => undefined}
        onSeekingChange={onSeekingChange}
        onError={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "paused", {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    let currentTimeSec = 0;
    let seeking = false;
    Object.defineProperty(video, "seeking", {
      configurable: true,
      get: () => seeking,
    });
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTimeSec,
      set: (value: number) => {
        currentTimeSec = value;
        seeking = true;
      },
    });

    ref.current?.beginScrub();
    ref.current?.scrubTo(5000);
    currentTimeSec = 5;
    seeking = true;

    onSeekingChange.mockClear();
    onTimeUpdate.mockClear();

    ref.current?.endScrubAndLock(5000);
    expect(onSeekingChange).toHaveBeenLastCalledWith(true);

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(onSeekingChange).toHaveBeenLastCalledWith(true);
    expect(onTimeUpdate).not.toHaveBeenCalledWith(5000);

    seeking = false;
    currentTimeSec = 5;
    act(() => {
      video.dispatchEvent(new Event("seeked"));
    });

    expect(onSeekingChange).toHaveBeenLastCalledWith(false);
    expect(onTimeUpdate).toHaveBeenCalledWith(5000);
  });

  it("endScrubAndLock stays locked until settle confirms target", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "cache",
    });

    const onSeekingChange = vi.fn();
    const onTimeUpdate = vi.fn();
    const ref = createRef<VideoPlayerHandle>();
    const { container } = render(
      <VideoPlayer
        ref={ref}
        recordingId="rec-1"
        startMs={0}
        endMs={10_000}
        onTimeUpdate={onTimeUpdate}
        onPlayingChange={() => undefined}
        onSeekingChange={onSeekingChange}
        onError={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    const fastSeek = vi.fn((value: number) => {
      assignedSec = value;
    });
    Object.defineProperty(video, "fastSeek", {
      configurable: true,
      value: fastSeek,
    });
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "paused", {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    let assignedSec = 0;
    let reportedSec = 0;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => reportedSec,
      set: (value: number) => {
        assignedSec = value;
      },
    });

    ref.current?.beginScrub();
    ref.current?.scrubTo(5000);

    onSeekingChange.mockClear();
    onTimeUpdate.mockClear();

    ref.current?.endScrubAndLock(5000);

    expect(onSeekingChange).toHaveBeenLastCalledWith(true);
    expect(assignedSec).toBe(5);
    expect(reportedSec).toBe(0);

    act(() => {
      video.dispatchEvent(new Event("seeked"));
    });

    expect(onSeekingChange).toHaveBeenLastCalledWith(true);
    expect(onTimeUpdate).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(onSeekingChange).toHaveBeenLastCalledWith(true);
    expect(onTimeUpdate).not.toHaveBeenCalled();
    expect(reportedSec).toBe(0);

    reportedSec = 5;
    act(() => {
      video.dispatchEvent(new Event("seeked"));
    });

    expect(onSeekingChange).toHaveBeenLastCalledWith(false);
    expect(onTimeUpdate).toHaveBeenCalledWith(5000);
  });

  it("does not treat stale seeked as success before reaching target", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "cache",
    });

    const onSeekingChange = vi.fn();
    const onTimeUpdate = vi.fn();
    const ref = createRef<VideoPlayerHandle>();
    const { container } = render(
      <VideoPlayer
        ref={ref}
        recordingId="rec-1"
        startMs={0}
        endMs={10_000}
        onTimeUpdate={onTimeUpdate}
        onPlayingChange={() => undefined}
        onSeekingChange={onSeekingChange}
        onError={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    let assignedSec = 0;
    let reportedSec = 0;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => reportedSec,
      set: (value: number) => {
        assignedSec = value;
      },
    });

    ref.current?.seekAndLock(2500);

    act(() => {
      video.dispatchEvent(new Event("seeked"));
    });

    expect(onSeekingChange).toHaveBeenLastCalledWith(true);
    expect(onTimeUpdate).not.toHaveBeenCalled();
    expect(assignedSec).toBe(2.5);

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(onSeekingChange).toHaveBeenLastCalledWith(true);
    expect(onTimeUpdate).not.toHaveBeenCalled();
    expect(assignedSec).toBe(2.5);
    expect(reportedSec).toBe(0);
  });

  it("retries locked seek on timeout until target is reached", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "cache",
    });

    const onSeekingChange = vi.fn();
    const onTimeUpdate = vi.fn();
    const ref = createRef<VideoPlayerHandle>();
    const { container } = render(
      <VideoPlayer
        ref={ref}
        recordingId="rec-1"
        startMs={0}
        endMs={10_000}
        onTimeUpdate={onTimeUpdate}
        onPlayingChange={() => undefined}
        onSeekingChange={onSeekingChange}
        onError={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    let currentTimeSec = 0;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTimeSec,
      set: (value: number) => {
        currentTimeSec = value;
      },
    });

    ref.current?.seekAndLock(2500);

    act(() => {
      video.dispatchEvent(new Event("seeked"));
      vi.advanceTimersByTime(500);
    });

    currentTimeSec = 2.5;
    act(() => {
      video.dispatchEvent(new Event("seeked"));
    });

    expect(onSeekingChange).toHaveBeenLastCalledWith(false);
    expect(onTimeUpdate).toHaveBeenCalledWith(2500);
  });

  it("runs queued seek after the first locked seek completes", async () => {
    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "cache",
    });

    const ref = createRef<VideoPlayerHandle>();
    const { container } = render(
      <VideoPlayer
        ref={ref}
        recordingId="rec-1"
        startMs={0}
        endMs={10_000}
        onTimeUpdate={() => undefined}
        onPlayingChange={() => undefined}
        onError={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    let currentTimeSec = 0;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTimeSec,
      set: (value: number) => {
        currentTimeSec = value;
      },
    });

    ref.current?.seekAndLock(2500);
    ref.current?.seekAndLock(8000);

    currentTimeSec = 2.5;
    video.dispatchEvent(new Event("seeked"));

    await waitFor(() => {
      expect(currentTimeSec).toBe(8);
    });
  });

  it("gives up locked seek after max wall-clock time", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "cache",
    });

    const onSeekingChange = vi.fn();
    const onTimeUpdate = vi.fn();
    const ref = createRef<VideoPlayerHandle>();
    const { container } = render(
      <VideoPlayer
        ref={ref}
        recordingId="rec-1"
        startMs={0}
        endMs={10_000}
        onTimeUpdate={onTimeUpdate}
        onPlayingChange={() => undefined}
        onSeekingChange={onSeekingChange}
        onError={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => 0,
      set: () => undefined,
    });

    ref.current?.seekAndLock(2500);

    act(() => {
      vi.advanceTimersByTime(2600);
    });

    expect(onSeekingChange).toHaveBeenLastCalledWith(false);
    expect(onTimeUpdate).toHaveBeenCalledWith(2500);
    expect(onTimeUpdate).not.toHaveBeenLastCalledWith(0);
  });

  it("endScrubAndLock supersedes an active locked seek", async () => {
    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "cache",
    });

    const onSeekingChange = vi.fn();
    const ref = createRef<VideoPlayerHandle>();
    const { container } = render(
      <VideoPlayer
        ref={ref}
        recordingId="rec-1"
        startMs={0}
        endMs={10_000}
        onTimeUpdate={() => undefined}
        onPlayingChange={() => undefined}
        onSeekingChange={onSeekingChange}
        onError={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    let currentTimeSec = 0;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTimeSec,
      set: (value: number) => {
        currentTimeSec = value;
      },
    });

    ref.current?.seekAndLock(2500);
    expect(onSeekingChange).toHaveBeenLastCalledWith(true);

    ref.current?.endScrubAndLock(8000);
    expect(onSeekingChange).toHaveBeenCalledWith(true);
    expect(currentTimeSec).toBe(8);
  });

  it("preserves intended playhead position when locked seek times out", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "cache",
    });

    const onSeekingChange = vi.fn();
    const onTimeUpdate = vi.fn();
    const ref = createRef<VideoPlayerHandle>();
    const { container } = render(
      <VideoPlayer
        ref={ref}
        recordingId="rec-1"
        startMs={0}
        endMs={10_000}
        onTimeUpdate={onTimeUpdate}
        onPlayingChange={() => undefined}
        onSeekingChange={onSeekingChange}
        onError={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => 1,
      set: () => undefined,
    });

    ref.current?.seekAndLock(8000);

    act(() => {
      vi.advanceTimersByTime(2600);
    });

    expect(onSeekingChange).toHaveBeenLastCalledWith(false);
    expect(onTimeUpdate).toHaveBeenLastCalledWith(8000);
    expect(onTimeUpdate).not.toHaveBeenLastCalledWith(1000);
  });

  it("shows Seeking overlay while locked seek is active", async () => {
    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "cache",
    });

    const ref = createRef<VideoPlayerHandle>();
    const { container, findByText, queryByText } = render(
      <VideoPlayer
        ref={ref}
        recordingId="rec-1"
        startMs={0}
        endMs={10_000}
        onTimeUpdate={() => undefined}
        onPlayingChange={() => undefined}
        onError={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    let currentTimeSec = 0;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTimeSec,
      set: (value: number) => {
        currentTimeSec = value;
      },
    });

    ref.current?.seekAndLock(2500);
    expect(await findByText("Seeking…")).toBeTruthy();

    currentTimeSec = 2.5;
    video.dispatchEvent(new Event("seeked"));

    await waitFor(() => {
      expect(queryByText("Seeking…")).toBeNull();
    });
  });

  it("blocks play while interaction is locked", async () => {
    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "cache",
    });

    const ref = createRef<VideoPlayerHandle>();
    const { container } = render(
      <VideoPlayer
        ref={ref}
        recordingId="rec-1"
        startMs={0}
        endMs={10_000}
        onTimeUpdate={() => undefined}
        onPlayingChange={() => undefined}
        onError={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    const play = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(video, "play", { configurable: true, value: play });
    Object.defineProperty(video, "paused", {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      writable: true,
      value: 0,
    });

    ref.current?.seekAndLock(2500);
    await ref.current?.play();

    expect(play).not.toHaveBeenCalled();
  });

  it("beginScrub clears an active locked seek", async () => {
    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "cache",
    });

    const onSeekingChange = vi.fn();
    const ref = createRef<VideoPlayerHandle>();
    const { container } = render(
      <VideoPlayer
        ref={ref}
        recordingId="rec-1"
        startMs={0}
        endMs={10_000}
        onTimeUpdate={() => undefined}
        onPlayingChange={() => undefined}
        onSeekingChange={onSeekingChange}
        onError={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "paused", {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      writable: true,
      value: 0,
    });

    ref.current?.seekAndLock(2500);
    expect(onSeekingChange).toHaveBeenLastCalledWith(true);

    ref.current?.beginScrub();
    expect(onSeekingChange).toHaveBeenLastCalledWith(false);
  });

  it("scrub fallback timeout applies coalesced target", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "cache",
    });

    const ref = createRef<VideoPlayerHandle>();
    const { container } = render(
      <VideoPlayer
        ref={ref}
        recordingId="rec-1"
        startMs={0}
        endMs={10_000}
        onTimeUpdate={() => undefined}
        onPlayingChange={() => undefined}
        onError={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    const fastSeek = vi.fn();
    Object.defineProperty(video, "fastSeek", {
      configurable: true,
      value: fastSeek,
    });
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      writable: true,
      value: 0,
    });

    ref.current?.beginScrub();
    ref.current?.scrubTo(1000);
    ref.current?.scrubTo(8000);

    expect(fastSeek).toHaveBeenCalledTimes(1);
    expect(fastSeek).toHaveBeenLastCalledWith(1);

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(fastSeek).toHaveBeenCalledTimes(2);
    expect(fastSeek).toHaveBeenLastCalledWith(8);
  });

  it("skips initial seekTo when metadata loads during first scrub", async () => {
    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "cache",
    });

    const onTimeUpdate = vi.fn();
    const onSeekingChange = vi.fn();
    const ref = createRef<VideoPlayerHandle>();
    const { container } = render(
      <VideoPlayer
        ref={ref}
        recordingId="rec-1"
        startMs={0}
        endMs={10_000}
        onTimeUpdate={onTimeUpdate}
        onPlayingChange={() => undefined}
        onSeekingChange={onSeekingChange}
        onError={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "readyState", { configurable: true, value: 0 });
    Object.defineProperty(video, "paused", {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(video, "duration", {
      configurable: true,
      value: 10,
    });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    let currentTimeSec = 0;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTimeSec,
      set: (value: number) => {
        currentTimeSec = value;
      },
    });

    ref.current?.beginScrub();
    ref.current?.scrubTo(5000);
    expect(onTimeUpdate).toHaveBeenCalledWith(5000);

    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    video.dispatchEvent(new Event("loadedmetadata"));

    expect(currentTimeSec).toBe(0);

    ref.current?.endScrubAndLock(5000);
    expect(currentTimeSec).toBe(5);
    expect(onSeekingChange).toHaveBeenCalledWith(true);

    currentTimeSec = 5;
    video.dispatchEvent(new Event("seeked"));

    await waitFor(() => {
      expect(onSeekingChange).toHaveBeenLastCalledWith(false);
    });
    expect(onTimeUpdate).toHaveBeenLastCalledWith(5000);
  });

  it("ignores stale seeked from load seek cancelled by first scrub", async () => {
    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "cache",
    });

    const onTimeUpdate = vi.fn();
    const onSeekingChange = vi.fn();
    const ref = createRef<VideoPlayerHandle>();
    const { container } = render(
      <VideoPlayer
        ref={ref}
        recordingId="rec-1"
        startMs={0}
        endMs={10_000}
        onTimeUpdate={onTimeUpdate}
        onPlayingChange={() => undefined}
        onSeekingChange={onSeekingChange}
        onError={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    const fastSeek = vi.fn();
    Object.defineProperty(video, "fastSeek", {
      configurable: true,
      value: fastSeek,
    });
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "paused", {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(video, "seeking", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, "duration", {
      configurable: true,
      value: 10,
    });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    let currentTimeSec = 0;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTimeSec,
      set: (value: number) => {
        currentTimeSec = value;
      },
    });

    video.dispatchEvent(new Event("loadedmetadata"));
    // Priming seek starts at +1s; scrub cancels it before it settles.
    expect(currentTimeSec).toBe(1);

    onTimeUpdate.mockClear();
    onSeekingChange.mockClear();

    ref.current?.beginScrub();
    ref.current?.scrubTo(5000);
    // fastSeek previews without settling currentTime; lock seek must stay open.
    expect(fastSeek).toHaveBeenCalledWith(5);
    expect(currentTimeSec).toBe(1);

    ref.current?.endScrubAndLock(5000);
    expect(currentTimeSec).toBe(5);
    expect(onSeekingChange).toHaveBeenLastCalledWith(true);

    currentTimeSec = 0;
    video.dispatchEvent(new Event("seeked"));
    expect(onSeekingChange).toHaveBeenLastCalledWith(true);
    expect(onTimeUpdate).not.toHaveBeenCalledWith(0);

    currentTimeSec = 5;
    video.dispatchEvent(new Event("seeked"));

    await waitFor(() => {
      expect(onSeekingChange).toHaveBeenLastCalledWith(false);
    });
    expect(onTimeUpdate).toHaveBeenLastCalledWith(5000);
  });
});
