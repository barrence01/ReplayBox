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

    onTimeUpdate.mockClear();
    ref.current?.seekTo(500);
    expect(onTimeUpdate).not.toHaveBeenCalled();

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
    video.dispatchEvent(new Event("loadedmetadata"));

    expect(video.currentTime).toBe(0.5);
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
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(onTimeUpdate).toHaveBeenCalledWith(1000);

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
});
