import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  forwardRef,
  useImperativeHandle,
  type ForwardedRef,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobStatus, Recording } from "../types";
import type { VideoPlayerHandle } from "../components/VideoPlayer";
import { EditorView } from "./EditorView";
import * as api from "../lib/api";

const playerSpies = {
  seekAndLock: vi.fn(),
  beginScrub: vi.fn(),
  scrubTo: vi.fn(),
  endScrubAndLock: vi.fn(),
  play: vi.fn().mockResolvedValue(undefined),
  pause: vi.fn(),
  getCurrentMs: vi.fn(() => 0),
  isPaused: vi.fn(() => true),
};

type PlayerProps = {
  onSeekingChange?: (seeking: boolean) => void;
  onTimeUpdate: (ms: number) => void;
  onPlayingChange: (playing: boolean) => void;
  onError: (message: string | null) => void;
  onDurationChange?: (ms: number) => void;
};

let latestPlayerProps: PlayerProps | null = null;

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
}));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    recordingFileExists: vi.fn().mockResolvedValue(true),
    deleteRecording: vi.fn(),
    startTrim: vi.fn(),
    startCompress: vi.fn(),
    resolveCopyPath: vi.fn(),
  };
});

vi.mock("../components/VideoPlayer", () => {
  const MockVideoPlayer = forwardRef(function MockVideoPlayer(
    props: PlayerProps,
    ref: ForwardedRef<VideoPlayerHandle>,
  ) {
    latestPlayerProps = props;
    useImperativeHandle(ref, () => ({
      play: playerSpies.play,
      pause: playerSpies.pause,
      seekTo: vi.fn(),
      seekAndLock: playerSpies.seekAndLock,
      beginScrub: playerSpies.beginScrub,
      scrubTo: (ms: number) => {
        playerSpies.scrubTo(ms);
        props.onTimeUpdate(ms);
      },
      endScrubAndLock: playerSpies.endScrubAndLock,
      getCurrentMs: playerSpies.getCurrentMs,
      isPaused: playerSpies.isPaused,
    }));
    return <div data-testid="video-player-mock" />;
  });

  return { VideoPlayer: MockVideoPlayer };
});

const recording: Recording = {
  id: "rec-1",
  path: "/recordings/clip.mp4",
  filename: "clip.mp4",
  dir: "/recordings",
  sizeBytes: 1024,
  durationMs: 10_000,
  width: 1920,
  height: 1080,
  videoCodec: "h264",
  audioCodec: "aac",
  isVfr: false,
  createdAt: null,
  modifiedAt: null,
  thumbnailPath: null,
  sessionId: null,
  indexedAt: "2024-01-01T00:00:00Z",
};

function renderEditor(overrides: Partial<Parameters<typeof EditorView>[0]> = {}) {
  const view = render(
    <EditorView
      recording={recording}
      folderRecordings={[]}
      preferNvenc={false}
      editJobs={[]}
      onBack={() => undefined}
      onOpen={() => undefined}
      onDeleted={() => undefined}
      onJobStarted={() => undefined}
      {...overrides}
    />,
  );

  const track = view.container.querySelector(
    ".timeline__track",
  ) as HTMLDivElement;
  Object.defineProperty(track, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      left: 0,
      top: 0,
      width: 1000,
      height: 28,
      right: 1000,
      bottom: 28,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
  track.setPointerCapture = vi.fn();
  track.releasePointerCapture = vi.fn();
  track.hasPointerCapture = vi.fn().mockReturnValue(true);

  return { ...view, track };
}

describe("EditorView timeline wiring", () => {
  afterEach(() => {
    cleanup();
    latestPlayerProps = null;
  });

  beforeEach(() => {
    playerSpies.seekAndLock.mockReset();
    playerSpies.beginScrub.mockReset();
    playerSpies.scrubTo.mockReset();
    playerSpies.endScrubAndLock.mockReset();
    playerSpies.play.mockReset().mockResolvedValue(undefined);
    playerSpies.pause.mockReset();
    playerSpies.getCurrentMs.mockReset().mockReturnValue(0);
    playerSpies.isPaused.mockReset().mockReturnValue(true);
    vi.mocked(api.startTrim).mockReset();
    vi.mocked(api.startCompress).mockReset();
    vi.mocked(api.resolveCopyPath).mockReset();
  });

  it("seeks and updates playhead on track click", () => {
    const { track } = renderEditor();

    fireEvent.pointerDown(track, { clientX: 500, button: 0, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 500, pointerId: 1 });

    expect(playerSpies.seekAndLock).toHaveBeenCalledWith(5000);
    expect(screen.getByText("00:00:05.000")).toBeTruthy();
  });

  it("runs scrub cycle on drag without seekAndLock click", () => {
    const { track } = renderEditor();

    fireEvent.pointerDown(track, { clientX: 200, button: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 800, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 800, pointerId: 1 });

    expect(playerSpies.beginScrub).toHaveBeenCalledTimes(1);
    expect(playerSpies.scrubTo).toHaveBeenCalled();
    expect(playerSpies.endScrubAndLock).toHaveBeenCalledWith(8000);
    expect(playerSpies.seekAndLock).not.toHaveBeenCalled();
  });

  it("locks timeline and transport while seeking", () => {
    const { track } = renderEditor();

    act(() => {
      latestPlayerProps?.onSeekingChange?.(true);
    });

    expect(track.classList.contains("timeline__track--locked")).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Play" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    playerSpies.seekAndLock.mockClear();
    fireEvent.pointerDown(track, { clientX: 500, button: 0, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 500, pointerId: 1 });
    expect(playerSpies.seekAndLock).not.toHaveBeenCalled();

    fireEvent.pointerDown(track, { clientX: 200, button: 0, pointerId: 2 });
    fireEvent.pointerMove(track, { clientX: 800, pointerId: 2 });
    fireEvent.pointerUp(track, { clientX: 800, pointerId: 2 });
    expect(playerSpies.beginScrub).not.toHaveBeenCalled();
    expect(playerSpies.endScrubAndLock).not.toHaveBeenCalled();
  });

  it("previews trim without seeking until commit", () => {
    const { track } = renderEditor();

    fireEvent.pointerDown(track, { clientX: 0, button: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 300, pointerId: 1 });

    expect(playerSpies.seekAndLock).not.toHaveBeenCalled();
    expect(screen.getByText("00:00:03.000 – 00:00:10.000")).toBeTruthy();
  });

  it("seeks on trim commit when video time is far from playhead", () => {
    const { track } = renderEditor();
    playerSpies.getCurrentMs.mockReturnValue(0);

    fireEvent.pointerDown(track, { clientX: 0, button: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 600, pointerId: 1 });
    expect(screen.getByText("00:00:06.000 – 00:00:10.000")).toBeTruthy();
    fireEvent.pointerUp(track, { clientX: 600, pointerId: 1 });

    expect(playerSpies.seekAndLock).toHaveBeenCalledWith(6000);
  });

  it("skips seek on trim commit when video already near target", () => {
    const { track } = renderEditor();
    playerSpies.getCurrentMs.mockReturnValue(6000);

    fireEvent.pointerDown(track, { clientX: 0, button: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 600, pointerId: 1 });
    expect(screen.getByText("00:00:06.000 – 00:00:10.000")).toBeTruthy();
    fireEvent.pointerUp(track, { clientX: 600, pointerId: 1 });

    expect(playerSpies.seekAndLock).not.toHaveBeenCalled();
  });

  it("skips seek on trim commit while timeline is locked", () => {
    const { track } = renderEditor();

    act(() => {
      latestPlayerProps?.onSeekingChange?.(true);
    });

    fireEvent.pointerDown(track, { clientX: 0, button: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 600, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 600, pointerId: 1 });

    expect(playerSpies.seekAndLock).not.toHaveBeenCalled();
  });

  it("does not toggle playback while timeline is locked", () => {
    renderEditor();

    act(() => {
      latestPlayerProps?.onSeekingChange?.(true);
    });

    fireEvent.click(screen.getByRole("button", { name: "Play" }));

    expect(playerSpies.play).not.toHaveBeenCalled();
    expect(playerSpies.pause).not.toHaveBeenCalled();
  });

  it("disables trim/compress and shows status when recording has active job", () => {
    const activeJob: JobStatus = {
      id: "job-1",
      kind: "compress",
      status: "processing",
      progress: 0.4,
      message: null,
      outputPath: "/recordings/clip_compressed.mp4",
      sourcePath: recording.path,
      sourceFilename: recording.filename,
      queuedAt: "2024-01-01T00:00:00.000Z",
      startedAt: "2024-01-01T00:00:10.000Z",
      finishedAt: null,
    };

    renderEditor({ editJobs: [activeJob] });

    const workingButtons = screen.getAllByRole("button", {
      name: /Working/,
    }) as HTMLButtonElement[];
    expect(workingButtons).toHaveLength(2);
    expect(workingButtons.every((b) => b.disabled)).toBe(true);
    expect(screen.getByText(/Compress processing/)).toBeTruthy();
  });

  it("enqueues compress when recording has no active job", async () => {
    const onJobStarted = vi.fn();
    vi.mocked(api.resolveCopyPath).mockResolvedValue({
      path: "/recordings/clip_compressed.mp4",
      filename: "clip_compressed.mp4",
      exists: false,
    });
    vi.mocked(api.startCompress).mockResolvedValue({
      id: "job-2",
      kind: "compress",
      status: "queued",
      progress: 0,
      message: null,
      outputPath: "/recordings/clip_compressed.mp4",
      sourcePath: recording.path,
      sourceFilename: recording.filename,
      queuedAt: "2024-01-01T00:00:00.000Z",
      startedAt: null,
      finishedAt: null,
    });

    renderEditor({ onJobStarted });

    fireEvent.click(screen.getByRole("button", { name: "Compress" }));

    await vi.waitFor(() => {
      expect(api.startCompress).toHaveBeenCalled();
    });
    expect(onJobStarted).toHaveBeenCalled();
  });

  it("does not block when active job is for another path", async () => {
    vi.mocked(api.resolveCopyPath).mockResolvedValue({
      path: "/recordings/clip_compressed.mp4",
      filename: "clip_compressed.mp4",
      exists: false,
    });
    vi.mocked(api.startCompress).mockResolvedValue({
      id: "job-other",
      kind: "compress",
      status: "queued",
      progress: 0,
      message: null,
      outputPath: "/recordings/other_compressed.mp4",
      sourcePath: recording.path,
      sourceFilename: recording.filename,
      queuedAt: "2024-01-01T00:00:00.000Z",
      startedAt: null,
      finishedAt: null,
    });

    renderEditor({
      editJobs: [
        {
          id: "job-1",
          kind: "compress",
          status: "processing",
          progress: 0.2,
          message: null,
          outputPath: "/other/out.mp4",
          sourcePath: "/other/video.mp4",
          sourceFilename: "video.mp4",
          queuedAt: "2024-01-01T00:00:00.000Z",
          startedAt: "2024-01-01T00:00:01.000Z",
          finishedAt: null,
        },
      ],
    });

    const compress = screen.getByRole("button", {
      name: "Compress",
    }) as HTMLButtonElement;
    expect(compress.disabled).toBe(false);
    fireEvent.click(compress);
    await vi.waitFor(() => {
      expect(api.startCompress).toHaveBeenCalled();
    });
  });

  it("shows queued hint with position", () => {
    renderEditor({
      editJobs: [
        {
          id: "job-front",
          kind: "trim",
          status: "queued",
          progress: 0,
          message: null,
          outputPath: null,
          sourcePath: "/other/a.mp4",
          sourceFilename: "a.mp4",
          queuedAt: "2024-01-01T00:00:00.000Z",
          startedAt: null,
          finishedAt: null,
        },
        {
          id: "job-self",
          kind: "compress",
          status: "queued",
          progress: 0,
          message: null,
          outputPath: null,
          sourcePath: recording.path,
          sourceFilename: recording.filename,
          queuedAt: "2024-01-01T00:00:01.000Z",
          startedAt: null,
          finishedAt: null,
        },
      ],
    });

    expect(screen.getByText(/Compress queued · #2/)).toBeTruthy();
    expect(
      (screen.getAllByRole("button", { name: /Working/ }) as HTMLButtonElement[])
        .length,
    ).toBe(2);
  });

  it("re-enables Delete after switching to another recording", async () => {
    vi.mocked(api.deleteRecording).mockResolvedValueOnce(undefined);
    const next: Recording = {
      ...recording,
      id: "rec-2",
      path: "/recordings/other.mp4",
      filename: "other.mp4",
    };
    const onDeleted = vi.fn();

    const { rerender } = renderEditor({ onDeleted });

    fireEvent.click(screen.getByRole("button", { name: "Delete video" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await vi.waitFor(() => {
      expect(onDeleted).toHaveBeenCalled();
    });

    expect(
      (
        screen.getByRole("button", {
          name: "Delete video",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    rerender(
      <EditorView
        recording={next}
        folderRecordings={[]}
        preferNvenc={false}
        editJobs={[]}
        onBack={() => undefined}
        onOpen={() => undefined}
        onDeleted={onDeleted}
        onJobStarted={() => undefined}
      />,
    );

    expect(
      (
        screen.getByRole("button", {
          name: "Delete video",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("shows Fast trim by default and sends fast mode on trim", async () => {
    vi.mocked(api.resolveCopyPath).mockResolvedValue({
      path: "/recordings/clip_trimmed.mp4",
      filename: "clip_trimmed.mp4",
      exists: false,
    });
    vi.mocked(api.startTrim).mockResolvedValue({
      id: "job-trim",
      kind: "trim",
      status: "queued",
      progress: 0,
      message: null,
      outputPath: "/recordings/clip_trimmed.mp4",
      sourcePath: recording.path,
      sourceFilename: recording.filename,
      queuedAt: "2024-01-01T00:00:00.000Z",
      startedAt: null,
      finishedAt: null,
    });

    renderEditor();

    expect(
      screen.getByRole("button", { name: "Fast trim" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Fast trim" }));

    await vi.waitFor(() => {
      expect(api.startTrim).toHaveBeenCalledWith(
        expect.objectContaining({
          trimMode: "fast",
          outputMode: "copy",
          crf: 26,
          useNvenc: false,
          fps: 60,
        }),
      );
    });
  });

  it("chevron menu switches to Precise trim without starting a job", () => {
    renderEditor();

    fireEvent.click(screen.getByRole("button", { name: "Trim mode" }));
    fireEvent.click(screen.getByRole("button", { name: "Precise trim" }));

    expect(screen.getByRole("button", { name: "Precise trim" })).toBeTruthy();
    expect(api.startTrim).not.toHaveBeenCalled();
  });

  it("sends precise trim settings when Precise trim is selected", async () => {
    vi.mocked(api.resolveCopyPath).mockResolvedValue({
      path: "/recordings/clip_trimmed.mp4",
      filename: "clip_trimmed.mp4",
      exists: false,
    });
    vi.mocked(api.startTrim).mockResolvedValue({
      id: "job-trim-precise",
      kind: "trim",
      status: "queued",
      progress: 0,
      message: null,
      outputPath: "/recordings/clip_trimmed.mp4",
      sourcePath: recording.path,
      sourceFilename: recording.filename,
      queuedAt: "2024-01-01T00:00:00.000Z",
      startedAt: null,
      finishedAt: null,
    });

    renderEditor({ preferNvenc: true });

    fireEvent.click(screen.getByRole("button", { name: "Trim mode" }));
    fireEvent.click(screen.getByRole("button", { name: "Precise trim" }));
    fireEvent.click(screen.getByRole("button", { name: "Precise trim" }));

    await vi.waitFor(() => {
      expect(api.startTrim).toHaveBeenCalledWith(
        expect.objectContaining({
          trimMode: "precise",
          crf: 26,
          useNvenc: true,
          fps: 60,
        }),
      );
    });
  });
});
