import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { VideoPlayer, type VideoPlayerHandle } from "../components/VideoPlayer";
import { SEEK_HARD_MAX_MS, SEEK_MAX_MS, SEEK_SETTLE_MS, HDD_SEEK_GRACE_MS } from "../lib/videoSeek";

const getPlaybackInfoMock = vi.fn();
const prioritizePreviewForRecordingMock = vi.fn();
const logPlaybackMock = vi.fn();

vi.mock("../lib/api", () => ({
  getPlaybackInfo: (...args: unknown[]) => getPlaybackInfoMock(...args),
  prioritizePreviewForRecording: (...args: unknown[]) =>
    prioritizePreviewForRecordingMock(...args),
  logPlayback: (...args: unknown[]) => logPlaybackMock(...args),
}));

/** Finish WebKit demuxer priming after loadedmetadata applied the offset seek. */
function completeSeekPrime(
  video: HTMLVideoElement,
  getSec: () => number,
  setSec: (sec: number) => void,
  startSec = 0,
) {
  setSec(getSec());
  act(() => {
    video.dispatchEvent(new Event("seeked"));
  });
  setSec(startSec);
  act(() => {
    video.dispatchEvent(new Event("seeked"));
  });
}

describe("VideoPlayer", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  beforeEach(() => {
    getPlaybackInfoMock.mockReset();
    prioritizePreviewForRecordingMock.mockReset();
    prioritizePreviewForRecordingMock.mockResolvedValue({ id: "job-1" });
    logPlaybackMock.mockReset();

    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      value: vi.fn().mockResolvedValue(undefined),
    });
    Object.defineProperty(HTMLMediaElement.prototype, "pause", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLMediaElement.prototype, "load", {
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

  it("releases video element on unmount", async () => {
    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "direct",
    });

    const { container, unmount } = render(
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
      expect(container.querySelector("video")?.getAttribute("src")).toBe(
        "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      );
    });

    const video = container.querySelector("video")!;
    unmount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(video.getAttribute("src")).toBeNull();
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalled();
  });

  it("requests stream copy fallback after direct error", async () => {
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

  it("requests stream copy fallback when play fails in direct mode", async () => {
    getPlaybackInfoMock
      .mockResolvedValueOnce({
        url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
        mode: "direct",
      })
      .mockResolvedValueOnce({
        url: "",
        mode: "preparing",
      });

    const playMock = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockRejectedValue(new Error("playback failed"));

    const onError = vi.fn();
    const ref = createRef<VideoPlayerHandle>();
    const { container } = render(
      <VideoPlayer
        ref={ref}
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

    await act(async () => {
      await ref.current?.play();
    });

    await waitFor(() => {
      expect(getPlaybackInfoMock).toHaveBeenCalledWith("rec-1", {
        forceFallback: true,
        fallbackLevel: 1,
      });
    });

    expect(onError).not.toHaveBeenCalledWith(
      expect.stringContaining("Playback failed"),
    );

    playMock.mockRestore();
  });

  it("does not report errors when video error follows play fallback", async () => {
    getPlaybackInfoMock
      .mockResolvedValueOnce({
        url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
        mode: "direct",
      })
      .mockResolvedValueOnce({
        url: "",
        mode: "preparing",
        previewStrategy: "stream_copy",
        previewInplace: true,
      });

    const playMock = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockRejectedValue(new DOMException("not supported", "NotSupportedError"));

    const onError = vi.fn();
    const ref = createRef<VideoPlayerHandle>();
    const { container } = render(
      <VideoPlayer
        ref={ref}
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

    await act(async () => {
      await ref.current?.play();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    video.dispatchEvent(new Event("error"));

    await waitFor(() => {
      expect(getPlaybackInfoMock).toHaveBeenCalledWith("rec-1", {
        forceFallback: true,
        fallbackLevel: 1,
      });
    });

    expect(onError).not.toHaveBeenCalledWith(
      expect.stringContaining("Playback failed"),
    );
    expect(onError).not.toHaveBeenCalledWith(
      expect.stringContaining("Video playback failed"),
    );

    playMock.mockRestore();
  });

  it("shows optimizing recording while preparing in-place stream copy", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getPlaybackInfoMock
      .mockResolvedValueOnce({
        url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
        mode: "direct",
      })
      .mockResolvedValueOnce({
        url: "",
        mode: "preparing",
        previewStrategy: "stream_copy",
        previewInplace: true,
        queueStatus: "processing",
        startedAt: new Date().toISOString(),
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
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    video.dispatchEvent(new Event("error"));

    await waitFor(() => {
      expect(container.textContent).toContain("Optimizing recording");
    });

    vi.useRealTimers();
  });

  it("applies direct mode after in-place stream copy completes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getPlaybackInfoMock
      .mockResolvedValueOnce({
        url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
        mode: "direct",
      })
      .mockResolvedValueOnce({
        url: "",
        mode: "preparing",
        previewStrategy: "stream_copy",
        previewInplace: true,
      })
      .mockResolvedValueOnce({
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
      expect(container.querySelector("video")).toBeTruthy();
    });

    const video = container.querySelector("video") as HTMLVideoElement;
    video.dispatchEvent(new Event("error"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    await waitFor(() => {
      const next = container.querySelector("video");
      expect(next?.getAttribute("src")).toBe(
        "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      );
    });

    vi.useRealTimers();
  });

  it("cascades from cache stream copy to transcode on error", async () => {
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

  it("ignores preparing poll results after recordingId changes", async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    getPlaybackInfoMock.mockImplementation((id: string) => {
      if (id === "rec-old") {
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve({
        url: "http://127.0.0.1:1/media?path=%2Fnew.mp4",
        mode: "direct",
      });
    });

    const onError = vi.fn();
    const { container, rerender } = render(
      <VideoPlayer
        recordingId="rec-old"
        startMs={0}
        endMs={1000}
        onTimeUpdate={() => undefined}
        onPlayingChange={() => undefined}
        onError={onError}
      />,
    );

    rerender(
      <VideoPlayer
        recordingId="rec-new"
        startMs={0}
        endMs={1000}
        onTimeUpdate={() => undefined}
        onPlayingChange={() => undefined}
        onError={onError}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")?.getAttribute("src")).toBe(
        "http://127.0.0.1:1/media?path=%2Fnew.mp4",
      );
    });

    resolveFirst?.({
      url: "http://127.0.0.1:1/media?path=%2Fold.mp4",
      mode: "direct",
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector("video")?.getAttribute("src")).toBe(
      "http://127.0.0.1:1/media?path=%2Fnew.mp4",
    );
  });

  it("shows elapsed from backend startedAt while preparing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    getPlaybackInfoMock.mockResolvedValue({
      url: "",
      mode: "preparing",
      queueStatus: "processing",
      queuedAt: "2024-01-01T00:00:00.000Z",
      startedAt: "2024-01-01T00:00:00.000Z",
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
      expect(container.textContent).toContain("Preparing preview… (00:00)");
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(container.textContent).toContain("Preparing preview… (00:03)");
  });

  it("shows encoding message while preparing a transcode preview", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    getPlaybackInfoMock.mockResolvedValue({
      url: "",
      mode: "preparing",
      queueStatus: "processing",
      queuedAt: "2024-01-01T00:00:00.000Z",
      startedAt: "2024-01-01T00:00:00.000Z",
      previewStrategy: "transcode",
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
      expect(container.textContent).toContain("Encoding preview… (00:00)");
    });
  });

  it("shows preparing file message while stream copying", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    getPlaybackInfoMock.mockResolvedValue({
      url: "",
      mode: "preparing",
      queueStatus: "processing",
      queuedAt: "2024-01-01T00:00:00.000Z",
      startedAt: "2024-01-01T00:00:00.000Z",
      previewStrategy: "stream_copy",
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
      expect(container.textContent).toContain("Preparing file… (00:00)");
    });
  });

  it("shows waiting in queue status with position", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2024-01-01T00:01:00.000Z"));
    getPlaybackInfoMock.mockResolvedValue({
      url: "",
      mode: "preparing",
      queueStatus: "queued",
      queuedAt: "2024-01-01T00:00:50.000Z",
      queuePosition: 2,
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
      expect(container.textContent).toContain("Waiting in queue · #2 (00:10)");
    });
    expect(container.querySelector(".video-player__process-next")).toBeTruthy();
  });

  it("hides process next when queued at front", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2024-01-01T00:01:00.000Z"));
    getPlaybackInfoMock.mockResolvedValue({
      url: "",
      mode: "preparing",
      queueStatus: "queued",
      queuedAt: "2024-01-01T00:00:50.000Z",
      queuePosition: 1,
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
      expect(container.textContent).toContain("Waiting in queue · #1 (00:10)");
    });
    expect(container.querySelector(".video-player__process-next")).toBeNull();
  });

  it("hides process next while preview is processing", async () => {
    getPlaybackInfoMock.mockResolvedValue({
      url: "",
      mode: "preparing",
      queueStatus: "processing",
      queuedAt: "2024-01-01T00:00:50.000Z",
      startedAt: "2024-01-01T00:00:50.000Z",
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
      expect(container.textContent).toContain("Preparing preview");
    });
    expect(container.querySelector(".video-player__process-next")).toBeNull();
  });

  it("process next promotes the queued preview and refreshes playback info", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2024-01-01T00:01:00.000Z"));
    getPlaybackInfoMock
      .mockResolvedValueOnce({
        url: "",
        mode: "preparing",
        queueStatus: "queued",
        queuedAt: "2024-01-01T00:00:50.000Z",
        queuePosition: 2,
      })
      .mockResolvedValue({
        url: "",
        mode: "preparing",
        queueStatus: "queued",
        queuedAt: "2024-01-01T00:00:50.000Z",
        queuePosition: 1,
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
      expect(container.querySelector(".video-player__process-next")).toBeTruthy();
    });

    const button = container.querySelector(
      ".video-player__process-next",
    ) as HTMLButtonElement;
    await act(async () => {
      button.click();
    });

    await waitFor(() => {
      expect(prioritizePreviewForRecordingMock).toHaveBeenCalledWith("rec-1");
    });
    await waitFor(() => {
      expect(container.querySelector(".video-player__process-next")).toBeNull();
      expect(container.textContent).toContain("Waiting in queue · #1");
    });
  });

  it("keeps elapsed when remounted with same startedAt", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2024-01-01T00:00:05.000Z"));
    getPlaybackInfoMock.mockResolvedValue({
      url: "",
      mode: "preparing",
      queueStatus: "processing",
      queuedAt: "2024-01-01T00:00:00.000Z",
      startedAt: "2024-01-01T00:00:00.000Z",
    });

    const { container, unmount } = render(
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
      expect(container.textContent).toContain("Preparing preview… (00:05)");
    });
    expect(container.textContent).not.toContain("Preparing preview… (00:00)");

    unmount();
    const second = render(
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
      expect(second.container.textContent).toContain("Preparing preview… (00:05)");
    });
  });

  it("updates from queued to processing on poll", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2024-01-01T00:01:00.000Z"));
    getPlaybackInfoMock
      .mockResolvedValueOnce({
        url: "",
        mode: "preparing",
        queueStatus: "queued",
        queuedAt: "2024-01-01T00:00:50.000Z",
        queuePosition: 1,
      })
      .mockResolvedValue({
        url: "",
        mode: "preparing",
        queueStatus: "processing",
        queuedAt: "2024-01-01T00:00:50.000Z",
        startedAt: "2024-01-01T00:01:00.000Z",
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
      expect(container.textContent).toContain("Waiting in queue · #1 (00:10)");
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    await waitFor(() => {
      expect(container.textContent).toContain("Preparing preview…");
    });
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

  it("follows actual time when a seek is ignored while playing", async () => {
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
    let paused = false;
    let pauseSticks = false;
    const order: string[] = [];
    const pause = vi.fn(() => {
      order.push("pause");
      if (pauseSticks) {
        paused = true;
      }
    });
    Object.defineProperty(video, "pause", { configurable: true, value: pause });
    Object.defineProperty(video, "paused", {
      configurable: true,
      get: () => paused,
    });
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "seeking", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 120 },
    });
    let currentTimeSec = 1.2;
    const assignedSec: number[] = [];
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTimeSec,
      set: (value: number) => {
        order.push("currentTime");
        assignedSec.push(value);
      },
    });

    ref.current?.seekAndLock(8000);
    expect(order).toEqual(["pause"]);
    expect(assignedSec).toEqual([]);

    onTimeUpdate.mockClear();
    currentTimeSec = 1.5;
    video.dispatchEvent(new Event("timeupdate"));
    expect(onTimeUpdate).toHaveBeenCalledWith(1500);
    expect(onTimeUpdate).not.toHaveBeenCalledWith(8000);

    pauseSticks = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEEK_SETTLE_MS + 1);
    });

    expect(order).toEqual(["pause", "pause", "currentTime"]);
    expect(assignedSec).toEqual([8]);
  });

  it("does not follow timeupdate while the engine is seeking", async () => {
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
    Object.defineProperty(video, "paused", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "seeking", {
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
      value: 1,
    });

    ref.current?.seekAndLock(5000);
    onTimeUpdate.mockClear();
    video.dispatchEvent(new Event("timeupdate"));
    expect(onTimeUpdate).not.toHaveBeenCalled();
  });

  it("assigns currentTime only after pause settles when playback was running", async () => {
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
    let paused = false;
    const order: string[] = [];
    const pause = vi.fn(() => {
      order.push("pause");
      paused = true;
    });
    Object.defineProperty(video, "pause", { configurable: true, value: pause });
    Object.defineProperty(video, "paused", {
      configurable: true,
      get: () => paused,
    });
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "seeking", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    const assignedSec: number[] = [];
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => 0,
      set: (value: number) => {
        order.push("currentTime");
        assignedSec.push(value);
      },
    });

    ref.current?.seekAndLock(2500);
    expect(order).toEqual(["pause"]);
    expect(assignedSec).toEqual([]);

    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(order).toEqual(["pause", "currentTime"]);
    expect(assignedSec).toEqual([2.5]);
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

    // Priming seeks to +1s first; finish it before the pending user seek applies.
    expect(currentTimeSec).toBe(1);
    completeSeekPrime(
      video,
      () => currentTimeSec,
      (sec) => {
        currentTimeSec = sec;
      },
    );
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

    const video = container.querySelector("video") as HTMLVideoElement;
    act(() => {
      video.dispatchEvent(new Event("loadeddata"));
    });

    await waitFor(() => {
      expect(video.getAttribute("preload")).toBe("metadata");
    });
  });

  it("arms pending seek when readyState is below HAVE_METADATA", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
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
    Object.defineProperty(video, "readyState", { configurable: true, value: 0 });
    Object.defineProperty(video, "seeking", {
      configurable: true,
      get: () => false,
    });
    let currentTimeSec = 0;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTimeSec,
      set: (value: number) => {
        currentTimeSec = value;
      },
    });

    ref.current?.seekAndLock(8000);
    expect(onSeekingChange).toHaveBeenCalledWith(true);
    expect(currentTimeSec).toBe(0);
    expect(logPlaybackMock).toHaveBeenCalledWith(
      "info",
      "seek.pending",
      expect.objectContaining({ reason: "awaiting_media" }),
    );

    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    Object.defineProperty(video, "duration", { configurable: true, value: 10 });
    act(() => {
      video.dispatchEvent(new Event("loadedmetadata"));
    });

    expect(currentTimeSec).toBe(1);
    completeSeekPrime(
      video,
      () => currentTimeSec,
      (sec) => {
        currentTimeSec = sec;
      },
    );
    expect(currentTimeSec).toBe(8);
    expect(logPlaybackMock).toHaveBeenCalledWith(
      "info",
      "seek.apply",
      expect.objectContaining({ via: "currentTime" }),
    );
  });

  it("keeps mid-file locked seek target when seekable is still a tiny early range", async () => {
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
        endMs={120_000}
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
    Object.defineProperty(video, "seeking", {
      configurable: true,
      get: () => false,
    });
    let seekableEnd = 0.05;
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: {
        get length() {
          return 1;
        },
        start: () => 0,
        end: () => seekableEnd,
      },
    });
    let currentTimeSec = 0;
    const assignedSec: number[] = [];
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTimeSec,
      set: (value: number) => {
        assignedSec.push(value);
        currentTimeSec = value;
      },
    });
    Object.defineProperty(video, "duration", { configurable: true, value: 120 });
    video.dispatchEvent(new Event("loadedmetadata"));

    // Tiny early range must not receive currentTime for prime (1s) or mid-file.
    expect(assignedSec).toEqual([]);
    expect(logPlaybackMock).toHaveBeenCalledWith(
      "info",
      "seek.pending",
      expect.objectContaining({ reason: "awaiting_seekable" }),
    );

    ref.current?.seekAndLock(8000);
    expect(assignedSec).toEqual([]);
    expect(onSeekingChange).toHaveBeenLastCalledWith(true);

    seekableEnd = 120;
    act(() => {
      video.dispatchEvent(new Event("progress"));
    });
    expect(assignedSec[0]).toBe(1);

    completeSeekPrime(
      video,
      () => currentTimeSec,
      (sec) => {
        currentTimeSec = sec;
      },
    );
    expect(assignedSec).toContain(8);

    act(() => {
      video.dispatchEvent(new Event("seeked"));
    });
    expect(onSeekingChange).toHaveBeenLastCalledWith(false);
    expect(onTimeUpdate).toHaveBeenCalledWith(8000);
  });

  it("defers first locked seek until seekable covers the target", async () => {
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
        endMs={120_000}
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
    Object.defineProperty(video, "seeking", {
      configurable: true,
      get: () => false,
    });
    // Skip priming by using empty seekable until HAVE_FUTURE_DATA escape is unused;
    // mark primed via scrub abort after a no-op metadata load without coverage.
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 0.05 },
    });
    Object.defineProperty(video, "duration", { configurable: true, value: 120 });
    let currentTimeSec = 0;
    const assignedSec: number[] = [];
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTimeSec,
      set: (value: number) => {
        assignedSec.push(value);
        currentTimeSec = value;
      },
    });

    act(() => {
      video.dispatchEvent(new Event("loadedmetadata"));
    });
    ref.current?.beginScrub();
    ref.current?.endScrubAndLock(0);
    currentTimeSec = 0;
    act(() => {
      video.dispatchEvent(new Event("seeked"));
    });

    assignedSec.length = 0;
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 0.05 },
    });

    ref.current?.seekAndLock(30_000);
    expect(assignedSec).toEqual([]);
    expect(onSeekingChange).toHaveBeenLastCalledWith(true);
    expect(logPlaybackMock).toHaveBeenCalledWith(
      "info",
      "seek.pending",
      expect.objectContaining({ reason: "awaiting_seekable" }),
    );

    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 120 },
    });
    act(() => {
      video.dispatchEvent(new Event("progress"));
    });
    expect(assignedSec).toEqual([30]);
  });

  it("queues user seek during demuxer priming and applies after return", async () => {
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
    Object.defineProperty(video, "seeking", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    Object.defineProperty(video, "duration", { configurable: true, value: 10 });
    let currentTimeSec = 0;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTimeSec,
      set: (value: number) => {
        currentTimeSec = value;
      },
    });

    act(() => {
      video.dispatchEvent(new Event("loadedmetadata"));
    });
    expect(currentTimeSec).toBe(1);

    ref.current?.seekAndLock(8000);
    expect(currentTimeSec).toBe(1);
    expect(logPlaybackMock).toHaveBeenCalledWith(
      "info",
      "seek.prime",
      expect.objectContaining({ phase: "queued", postPrimeMs: 8000 }),
    );

    completeSeekPrime(
      video,
      () => currentTimeSec,
      (sec) => {
        currentTimeSec = sec;
      },
    );
    expect(currentTimeSec).toBe(8);

    act(() => {
      video.dispatchEvent(new Event("seeked"));
    });
    expect(onSeekingChange).toHaveBeenLastCalledWith(false);
    expect(onTimeUpdate).toHaveBeenCalledWith(8000);
  });

  it("finishes demuxer priming when WebKit leaves seeking true at the prime target", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "direct",
    });

    const onSeekingChange = vi.fn();
    const onTimeUpdate = vi.fn();
    const ref = createRef<VideoPlayerHandle>();
    const { container, queryByText } = render(
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
    Object.defineProperty(video, "readyState", { configurable: true, value: 4 });
    Object.defineProperty(video, "seeking", {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 286 },
    });
    Object.defineProperty(video, "duration", { configurable: true, value: 286 });
    Object.defineProperty(video, "paused", {
      configurable: true,
      get: () => true,
    });
    let currentTimeSec = 0;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTimeSec,
      set: (value: number) => {
        currentTimeSec = value;
      },
    });

    act(() => {
      video.dispatchEvent(new Event("loadedmetadata"));
    });
    expect(currentTimeSec).toBe(1);
    // Silent prime: no Seeking overlay while warming the demuxer.
    expect(queryByText("Seeking…")).toBeNull();

    // seeked never fires; watchdog must accept at-target despite seeking=true.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEEK_SETTLE_MS);
    });
    expect(currentTimeSec).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEEK_SETTLE_MS);
    });
    expect(logPlaybackMock).toHaveBeenCalledWith(
      "info",
      "seek.prime",
      expect.objectContaining({ phase: "done" }),
    );

    ref.current?.seekAndLock(8000);
    expect(currentTimeSec).toBe(8);
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
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "seeking", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    let stuckTimeSec = 0;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => stuckTimeSec,
      set: () => undefined,
    });
    Object.defineProperty(video, "duration", { configurable: true, value: 10 });
    // Clear load timeout / mark primed without leaving an in-flight prime seek.
    ref.current?.beginScrub();
    video.dispatchEvent(new Event("loadedmetadata"));
    ref.current?.endScrubAndLock(0);
    stuckTimeSec = 0;
    act(() => {
      video.dispatchEvent(new Event("seeked"));
    });
    stuckTimeSec = 1;

    onTimeUpdate.mockClear();
    onSeekingChange.mockClear();
    // Use seekAndLock so UI lock + snap path are exercised (seekTo does not lock UI).
    ref.current?.seekAndLock(5000);
    expect(onTimeUpdate).not.toHaveBeenCalled();
    expect(onSeekingChange).toHaveBeenCalledWith(true);

    onTimeUpdate.mockClear();
    video.dispatchEvent(new Event("timeupdate"));
    expect(onTimeUpdate).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEEK_MAX_MS + 500);
    });

    expect(onSeekingChange).toHaveBeenLastCalledWith(false);
    // Snap reports where the element actually is, not the missed target.
    expect(onTimeUpdate).toHaveBeenCalledWith(1000);
    expect(onTimeUpdate).not.toHaveBeenCalledWith(5000);

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

  it("endScrubAndLock uses currentTime for locked seek", async () => {
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
    Object.defineProperty(video, "seeking", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    let currentTimeSec = 0;
    const assignedSec: number[] = [];
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTimeSec,
      set: (value: number) => {
        assignedSec.push(value);
      },
    });

    ref.current?.beginScrub();
    ref.current?.scrubTo(5000);
    expect(fastSeek).toHaveBeenCalledTimes(1);
    fastSeek.mockClear();

    ref.current?.endScrubAndLock(5000);
    expect(fastSeek).not.toHaveBeenCalled();
    expect(assignedSec).toEqual([5]);
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
      vi.advanceTimersByTime(SEEK_SETTLE_MS);
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

  it("accepts at-target seek on the second poll while seeking stays true", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

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
    const order: string[] = [];
    const play = vi.fn(() => {
      order.push("play");
      return Promise.resolve();
    });
    Object.defineProperty(video, "play", { configurable: true, value: play });
    let paused = false;
    Object.defineProperty(video, "pause", {
      configurable: true,
      value: vi.fn(() => {
        paused = true;
      }),
    });
    Object.defineProperty(video, "paused", {
      configurable: true,
      get: () => paused,
    });
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "seeking", {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    let currentTimeSec = 5;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTimeSec,
      set: (value: number) => {
        order.push("currentTime");
        currentTimeSec = value;
      },
    });

    ref.current?.beginScrub();
    video.dispatchEvent(new Event("loadedmetadata"));
    paused = false;
    ref.current?.endScrubAndLock(5000);

    act(() => {
      vi.advanceTimersByTime(SEEK_SETTLE_MS);
    });
    expect(onSeekingChange).toHaveBeenLastCalledWith(true);
    expect(play).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEEK_SETTLE_MS);
    });

    expect(onSeekingChange).toHaveBeenLastCalledWith(false);
    expect(play).toHaveBeenCalledTimes(1);
    expect(order.indexOf("play")).toBeGreaterThan(order.indexOf("currentTime"));
    expect(order.filter((step) => step === "currentTime").length).toBeGreaterThan(1);
    expect(order.lastIndexOf("currentTime")).toBeLessThan(order.indexOf("play"));
  });

  it("logs a repeated settle wait once and reports waitPolls on complete", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

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
    Object.defineProperty(video, "seeking", {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => 5,
      set: () => undefined,
    });

    logPlaybackMock.mockClear();
    ref.current?.beginScrub();
    video.dispatchEvent(new Event("loadedmetadata"));
    ref.current?.endScrubAndLock(5000);

    act(() => {
      vi.advanceTimersByTime(SEEK_SETTLE_MS);
    });
    act(() => {
      vi.advanceTimersByTime(SEEK_SETTLE_MS);
    });

    const stuckLogs = logPlaybackMock.mock.calls.filter(
      (call) =>
        call[1] === "seek.settle" &&
        (call[2] as { detail?: string }).detail === "seeking_flag_stuck",
    );
    expect(stuckLogs).toHaveLength(1);
    expect(logPlaybackMock).toHaveBeenCalledWith(
      "info",
      "seek.settle",
      expect.objectContaining({
        reason: "complete",
        waitPolls: 1,
        seekingStillTrue: true,
        nudged: true,
      }),
    );
    expect(onSeekingChange).toHaveBeenLastCalledWith(false);
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
    let reportedSec = 0;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => reportedSec,
      set: () => {
        // Locked seek uses fastSeek; currentTime must not be assigned here.
      },
    });

    ref.current?.beginScrub();
    ref.current?.scrubTo(5000);
    expect(fastSeek).toHaveBeenCalledWith(5);

    onSeekingChange.mockClear();
    onTimeUpdate.mockClear();

    ref.current?.endScrubAndLock(5000);

    expect(onSeekingChange).toHaveBeenLastCalledWith(true);
    expect(fastSeek).toHaveBeenCalled();
    expect(reportedSec).toBe(0);

    act(() => {
      video.dispatchEvent(new Event("seeked"));
    });

    expect(onSeekingChange).toHaveBeenLastCalledWith(true);
    expect(onTimeUpdate).not.toHaveBeenCalled();

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
    Object.defineProperty(video, "seeking", {
      configurable: true,
      get: () => false,
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

    ref.current?.seekAndLock(2500);
    expect(assignedSec).toBe(2.5);

    act(() => {
      video.dispatchEvent(new Event("seeked"));
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
    Object.defineProperty(video, "seeking", {
      configurable: true,
      get: () => false,
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

    ref.current?.seekAndLock(2500);
    expect(assignedSec).toBe(2.5);

    act(() => {
      vi.advanceTimersByTime(SEEK_SETTLE_MS);
    });
    expect(assignedSec).toBe(2.5);
    expect(onSeekingChange).toHaveBeenLastCalledWith(true);

    reportedSec = 2.5;
    act(() => {
      video.dispatchEvent(new Event("seeked"));
    });

    expect(onSeekingChange).toHaveBeenLastCalledWith(false);
    expect(onTimeUpdate).toHaveBeenCalledWith(2500);
  });

  it("seekAndLock retries currentTime after HDD grace (no immediate abort)", async () => {
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
    const fastSeek = vi.fn();
    Object.defineProperty(video, "fastSeek", {
      configurable: true,
      value: fastSeek,
    });
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "seeking", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    let currentTimeSec = 0;
    const assignedSec: number[] = [];
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTimeSec,
      set: (value: number) => {
        assignedSec.push(value);
      },
    });

    ref.current?.seekAndLock(2500);
    expect(fastSeek).not.toHaveBeenCalled();
    expect(assignedSec).toEqual([2.5]);
    expect(onSeekingChange).toHaveBeenCalledWith(true);

    act(() => {
      video.dispatchEvent(new Event("seeked"));
    });
    // Premature off-target seeked must not re-issue immediately (HDD).
    expect(assignedSec).toEqual([2.5]);
    expect(onSeekingChange).toHaveBeenLastCalledWith(true);
    expect(onTimeUpdate).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(SEEK_SETTLE_MS);
    });
    // Still within HDD grace — no second assignment yet.
    expect(assignedSec).toEqual([2.5]);

    act(() => {
      vi.advanceTimersByTime(HDD_SEEK_GRACE_MS);
    });
    expect(assignedSec).toEqual([2.5, 2.5]);

    currentTimeSec = 2.5;
    act(() => {
      video.dispatchEvent(new Event("seeked"));
    });

    expect(onSeekingChange).toHaveBeenLastCalledWith(false);
    expect(onTimeUpdate).toHaveBeenCalledWith(2500);
  });

  it("snapSeek reports actual time after wall-clock timeout (no remux)", async () => {
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
    Object.defineProperty(video, "seeking", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    let currentTimeSec = 0;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTimeSec,
      set: () => undefined,
    });
    Object.defineProperty(video, "duration", { configurable: true, value: 10 });
    // Clear load timeout / mark primed without leaving an in-flight prime seek.
    ref.current?.beginScrub();
    video.dispatchEvent(new Event("loadedmetadata"));
    ref.current?.endScrubAndLock(0);
    currentTimeSec = 0;
    act(() => {
      video.dispatchEvent(new Event("seeked"));
    });
    currentTimeSec = 1.2;

    ref.current?.seekAndLock(8000);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEEK_MAX_MS + 500);
    });

    expect(onTimeUpdate).toHaveBeenCalledWith(1200);
    expect(onTimeUpdate).not.toHaveBeenCalledWith(8000);
    expect(getPlaybackInfoMock).not.toHaveBeenCalledWith("rec-1", {
      forceFallback: true,
      fallbackLevel: expect.anything(),
    });
  });

  it("respects HDD grace while video.seeking before retrying locked seek", async () => {
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
    const fastSeek = vi.fn();
    Object.defineProperty(video, "fastSeek", {
      configurable: true,
      value: fastSeek,
    });
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    let seeking = true;
    Object.defineProperty(video, "seeking", {
      configurable: true,
      get: () => seeking,
    });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    let currentTimeSec = 0;
    const assignedSec: number[] = [];
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTimeSec,
      set: (value: number) => {
        assignedSec.push(value);
      },
    });

    ref.current?.seekAndLock(8000);
    expect(fastSeek).not.toHaveBeenCalled();
    expect(assignedSec).toEqual([8]);
    expect(onSeekingChange).toHaveBeenCalledWith(true);

    act(() => {
      vi.advanceTimersByTime(HDD_SEEK_GRACE_MS + SEEK_SETTLE_MS);
    });
    // Still seeking — must not re-issue.
    expect(assignedSec).toEqual([8]);
    expect(onSeekingChange).toHaveBeenLastCalledWith(true);

    seeking = false;
    act(() => {
      vi.advanceTimersByTime(SEEK_SETTLE_MS);
    });
    expect(assignedSec).toEqual([8, 8]);

    currentTimeSec = 8;
    act(() => {
      video.dispatchEvent(new Event("seeked"));
    });

    expect(onSeekingChange).toHaveBeenLastCalledWith(false);
    expect(onTimeUpdate).toHaveBeenCalledWith(8000);
  });

  it("does not request stream copy fallback when locked seek times out in direct mode", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    getPlaybackInfoMock.mockResolvedValue({
      url: "http://127.0.0.1:1/media?path=%2Fclip.mp4",
      mode: "direct",
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
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "seeking", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    let reportedSec = 0;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => reportedSec,
      set: () => undefined,
    });

    getPlaybackInfoMock.mockClear();
    Object.defineProperty(video, "duration", { configurable: true, value: 10 });
    // Clear load timeout / mark primed without leaving an in-flight prime seek.
    ref.current?.beginScrub();
    video.dispatchEvent(new Event("loadedmetadata"));
    ref.current?.endScrubAndLock(0);
    reportedSec = 0;
    act(() => {
      video.dispatchEvent(new Event("seeked"));
    });
    reportedSec = 1.2;
    ref.current?.seekAndLock(8000);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEEK_MAX_MS + 500);
    });

    expect(onSeekingChange).toHaveBeenLastCalledWith(false);
    expect(onTimeUpdate).toHaveBeenCalledWith(1200);
    expect(onTimeUpdate).not.toHaveBeenCalledWith(8000);
    expect(getPlaybackInfoMock).not.toHaveBeenCalled();
    expect(logPlaybackMock).toHaveBeenCalledWith(
      "warn",
      "seek.settle",
      expect.objectContaining({ reason: "snap" }),
    );
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
    Object.defineProperty(video, "seeking", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    let currentTimeSec = 0;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTimeSec,
      set: () => undefined,
    });
    Object.defineProperty(video, "duration", { configurable: true, value: 10 });
    // Clear load timeout / mark primed without leaving an in-flight prime seek.
    ref.current?.beginScrub();
    video.dispatchEvent(new Event("loadedmetadata"));
    ref.current?.endScrubAndLock(0);
    currentTimeSec = 0;
    act(() => {
      video.dispatchEvent(new Event("seeked"));
    });
    // Stay at 0 while seeking to 2.5s — never reaches target.
    currentTimeSec = 0;

    ref.current?.seekAndLock(2500);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEEK_MAX_MS + 500);
    });

    expect(onSeekingChange).toHaveBeenLastCalledWith(false);
    expect(onTimeUpdate).toHaveBeenLastCalledWith(0);
    expect(onTimeUpdate).not.toHaveBeenCalledWith(2500);
    expect(logPlaybackMock).toHaveBeenCalledWith(
      "warn",
      "seek.settle",
      expect.objectContaining({ reason: "snap" }),
    );
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

  it("reports actual playhead position when locked seek times out", async () => {
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
    Object.defineProperty(video, "seeking", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    let currentTimeSec = 0;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTimeSec,
      set: () => undefined,
    });
    Object.defineProperty(video, "duration", { configurable: true, value: 10 });
    // Clear load timeout / mark primed without leaving an in-flight prime seek.
    ref.current?.beginScrub();
    video.dispatchEvent(new Event("loadedmetadata"));
    ref.current?.endScrubAndLock(0);
    currentTimeSec = 0;
    act(() => {
      video.dispatchEvent(new Event("seeked"));
    });
    currentTimeSec = 1;

    ref.current?.seekAndLock(8000);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEEK_MAX_MS + 500);
    });

    expect(onSeekingChange).toHaveBeenLastCalledWith(false);
    expect(onTimeUpdate).toHaveBeenLastCalledWith(1000);
  });

  it("completes locked seek when currentTime lands within LOCKED_SEEK_TOLERANCE_SEC", async () => {
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
    const fastSeek = vi.fn();
    Object.defineProperty(video, "fastSeek", {
      configurable: true,
      value: fastSeek,
    });
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "seeking", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    let currentTimeSec = 0;
    const assignedSec: number[] = [];
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTimeSec,
      set: (value: number) => {
        assignedSec.push(value);
      },
    });

    ref.current?.seekAndLock(5000);
    expect(fastSeek).not.toHaveBeenCalled();
    expect(assignedSec).toEqual([5]);

    currentTimeSec = 4.85;
    act(() => {
      video.dispatchEvent(new Event("seeked"));
    });

    expect(onSeekingChange).toHaveBeenLastCalledWith(false);
    expect(onTimeUpdate).toHaveBeenCalledWith(4850);
    expect(assignedSec).toEqual([5]);
  });

  it("does not re-issue seek on premature off-target seeked (HDD)", async () => {
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
        endMs={120_000}
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
    Object.defineProperty(video, "seeking", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 120 },
    });
    let currentTimeSec = 44.522;
    const assignedSec: number[] = [];
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTimeSec,
      set: (value: number) => {
        assignedSec.push(value);
      },
    });

    ref.current?.seekAndLock(77_421);
    expect(fastSeek).not.toHaveBeenCalled();
    expect(assignedSec).toEqual([77.421]);

    // Premature seeked with unchanged currentTime must not abort/retry immediately.
    act(() => {
      video.dispatchEvent(new Event("seeked"));
    });
    expect(assignedSec).toEqual([77.421]);
    expect(onSeekingChange).toHaveBeenLastCalledWith(true);

    act(() => {
      video.dispatchEvent(new Event("seeked"));
    });
    expect(assignedSec).toEqual([77.421]);

    act(() => {
      vi.advanceTimersByTime(SEEK_SETTLE_MS);
    });
    // Still within HDD grace.
    expect(assignedSec).toEqual([77.421]);

    act(() => {
      vi.advanceTimersByTime(HDD_SEEK_GRACE_MS);
    });
    expect(assignedSec).toEqual([77.421, 77.421]);

    currentTimeSec = 77.421;
    act(() => {
      video.dispatchEvent(new Event("seeked"));
    });

    expect(onSeekingChange).toHaveBeenLastCalledWith(false);
    expect(onTimeUpdate).toHaveBeenCalledWith(77_421);
    expect(assignedSec).toEqual([77.421, 77.421]);
  });

  it("completes locked seek at target on the next poll if seeking stays true", async () => {
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
    Object.defineProperty(video, "seeking", {
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
    Object.defineProperty(video, "duration", { configurable: true, value: 10 });
    // Avoid demuxer priming so this test isolates at-target + seeking timeout.
    ref.current?.seekAndLock(2500);
    currentTimeSec = 2.5;
    act(() => {
      video.dispatchEvent(new Event("seeked"));
    });
    expect(onSeekingChange).toHaveBeenLastCalledWith(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEEK_SETTLE_MS * 2);
    });

    expect(onSeekingChange).toHaveBeenLastCalledWith(false);
    expect(onTimeUpdate).toHaveBeenCalledWith(2501);
  });

  it("does not soft-snap while video.seeking past SEEK_MAX_MS", async () => {
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
    let seeking = false;
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "seeking", {
      configurable: true,
      get: () => seeking,
    });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 10 },
    });
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => 0,
      set: () => undefined,
    });
    Object.defineProperty(video, "duration", { configurable: true, value: 10 });
    ref.current?.beginScrub();
    video.dispatchEvent(new Event("loadedmetadata"));
    ref.current?.endScrubAndLock(0);
    act(() => {
      video.dispatchEvent(new Event("seeked"));
    });
    onSeekingChange.mockClear();
    onTimeUpdate.mockClear();

    seeking = true;
    ref.current?.seekAndLock(8000);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEEK_MAX_MS + SEEK_SETTLE_MS);
    });

    expect(onSeekingChange).toHaveBeenLastCalledWith(true);
    expect(onTimeUpdate).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        SEEK_HARD_MAX_MS - SEEK_MAX_MS + SEEK_SETTLE_MS,
      );
    });

    expect(onSeekingChange).toHaveBeenLastCalledWith(false);
    expect(onTimeUpdate).toHaveBeenCalledWith(0);
    expect(onTimeUpdate).not.toHaveBeenCalledWith(8000);
  });

  it("play waits for locked seek settle before returning (no short seeked timeout)", async () => {
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
        startMs={1000}
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
    let paused = true;
    Object.defineProperty(video, "paused", {
      configurable: true,
      get: () => paused,
    });
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "seeking", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 20 },
    });
    let currentTimeSec = 5;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTimeSec,
      set: () => undefined,
    });
    Object.defineProperty(video, "duration", { configurable: true, value: 20 });
    // Skip demuxer priming; land inside the trim so we can then move outside.
    ref.current?.beginScrub();
    video.dispatchEvent(new Event("loadedmetadata"));
    ref.current?.endScrubAndLock(5000);
    currentTimeSec = 5;
    act(() => {
      video.dispatchEvent(new Event("seeked"));
    });
    // Outside trim window so play() must seek to startMs first.
    currentTimeSec = 0;
    play.mockClear();
    paused = true;

    let playFinished = false;
    await act(async () => {
      const p = ref.current!.play().then(() => {
        playFinished = true;
      });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(play).not.toHaveBeenCalled();
      // Off-target seeked must not resume play early.
      video.dispatchEvent(new Event("seeked"));
      await vi.advanceTimersByTimeAsync(SEEK_SETTLE_MS);
      expect(play).not.toHaveBeenCalled();
      expect(playFinished).toBe(false);

      currentTimeSec = 1;
      video.dispatchEvent(new Event("seeked"));
      await p;
    });

    expect(playFinished).toBe(true);
    expect(play).toHaveBeenCalled();
  });

  it("scrubTo does not clamp mid-file target to a tiny early seekable range", async () => {
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
    const fastSeek = vi.fn();
    Object.defineProperty(video, "fastSeek", {
      configurable: true,
      value: fastSeek,
    });
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 0.05 },
    });
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      writable: true,
      value: 0,
    });

    ref.current?.beginScrub();
    ref.current?.scrubTo(8000);

    expect(onTimeUpdate).toHaveBeenCalledWith(8000);
    expect(fastSeek).not.toHaveBeenCalled();
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
    vi.useFakeTimers({ shouldAdvanceTime: true });

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
    expect(fastSeek).not.toHaveBeenCalled();
    // Priming applies +1s; scrub aborts priming without requiring seeked.
    expect(currentTimeSec).toBe(1);

    onTimeUpdate.mockClear();
    onSeekingChange.mockClear();
    fastSeek.mockClear();

    ref.current?.beginScrub();
    ref.current?.scrubTo(5000);
    expect(fastSeek).toHaveBeenCalledWith(5);
    // Scrub uses fastSeek; currentTime may still reflect the aborted prime offset.
    expect(currentTimeSec).toBe(1);

    fastSeek.mockClear();
    ref.current?.endScrubAndLock(5000);
    expect(fastSeek).not.toHaveBeenCalled();
    expect(currentTimeSec).toBe(5);
    expect(onSeekingChange).toHaveBeenLastCalledWith(true);

    // Stale off-target seeked must not complete; wait for HDD grace before re-seek.
    currentTimeSec = 0;
    act(() => {
      video.dispatchEvent(new Event("seeked"));
    });
    expect(onSeekingChange).toHaveBeenLastCalledWith(true);
    expect(currentTimeSec).toBe(0);
    expect(onTimeUpdate).not.toHaveBeenCalledWith(0);

    act(() => {
      vi.advanceTimersByTime(SEEK_SETTLE_MS);
    });
    expect(currentTimeSec).toBe(0);

    act(() => {
      vi.advanceTimersByTime(HDD_SEEK_GRACE_MS);
    });
    expect(currentTimeSec).toBe(5);

    act(() => {
      video.dispatchEvent(new Event("seeked"));
    });

    await waitFor(() => {
      expect(onSeekingChange).toHaveBeenLastCalledWith(false);
    });
    expect(onTimeUpdate).toHaveBeenLastCalledWith(5000);
  });
});
