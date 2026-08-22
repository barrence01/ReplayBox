import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { JobStatus } from "../types";
import { QueuesView } from "./QueuesView";

function job(partial: Partial<JobStatus> & Pick<JobStatus, "id" | "status">): JobStatus {
  return {
    kind: "trim",
    progress: 0,
    message: null,
    outputPath: null,
    sourcePath: "/tmp/a.mp4",
    sourceFilename: "a.mp4",
    queuedAt: "2024-01-01T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    ...partial,
  };
}

function renderQueues(overrides: Partial<Parameters<typeof QueuesView>[0]> = {}) {
  const props = {
    editJobs: [] as JobStatus[],
    previewJobs: [] as JobStatus[],
    onCancelEdit: vi.fn(),
    onCancelPreview: vi.fn(),
    onDismissEdit: vi.fn(),
    onDismissPreview: vi.fn(),
    onClearEditFinished: vi.fn(),
    onClearPreviewFinished: vi.fn(),
    ...overrides,
  };
  const view = render(<QueuesView {...props} />);
  return { ...view, props };
}

describe("QueuesView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:01:00.000Z"));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows empty active and finished sections", () => {
    renderQueues();
    expect(screen.getAllByText("No active jobs.").length).toBeGreaterThan(0);
    expect(screen.getAllByText("No finished jobs.").length).toBeGreaterThan(0);
  });

  it("shows queue position and cancel for queued edit job", () => {
    const { props } = renderQueues({
      editJobs: [
        job({
          id: "1",
          kind: "trim",
          status: "processing",
          startedAt: "2024-01-01T00:00:40.000Z",
          sourceFilename: "first.mp4",
        }),
        job({
          id: "2",
          kind: "compress",
          status: "queued",
          sourceFilename: "second.mp4",
          queuedAt: "2024-01-01T00:00:50.000Z",
        }),
      ],
    });

    expect(screen.getByText(/Waiting in queue · #1/)).toBeTruthy();
    const cancelButtons = screen.getAllByRole("button", { name: "Cancel" });
    fireEvent.click(cancelButtons[1]);
    expect(props.onCancelEdit).toHaveBeenCalledWith("2");
  });

  it("cancels preview jobs from the preview section", () => {
    const { props } = renderQueues({
      previewJobs: [
        job({
          id: "p1",
          kind: "preview",
          status: "queued",
          sourceFilename: "preview.mp4",
        }),
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onCancelPreview).toHaveBeenCalledWith("p1");
  });

  it("dismisses finished edit jobs", () => {
    const { props } = renderQueues({
      editJobs: [
        job({
          id: "1",
          status: "completed",
          sourceFilename: "done.mp4",
          startedAt: "2024-01-01T00:00:00.000Z",
          finishedAt: "2024-01-01T00:00:42.000Z",
        }),
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(props.onDismissEdit).toHaveBeenCalledWith("1");
  });

  it("clears finished jobs from the edit section", () => {
    const { props } = renderQueues({
      editJobs: [
        job({
          id: "1",
          status: "failed",
          sourceFilename: "bad.mp4",
          finishedAt: "2024-01-01T00:00:10.000Z",
        }),
      ],
    });

    fireEvent.click(screen.getAllByRole("button", { name: "Clear finished" })[0]);
    expect(props.onClearEditFinished).toHaveBeenCalled();
  });

  it("shows completed failed and cancelled labels", () => {
    renderQueues({
      editJobs: [
        job({
          id: "1",
          status: "completed",
          sourceFilename: "ok.mp4",
          finishedAt: "2024-01-01T00:00:01.000Z",
        }),
        job({
          id: "2",
          status: "failed",
          sourceFilename: "bad.mp4",
          finishedAt: "2024-01-01T00:00:02.000Z",
        }),
        job({
          id: "3",
          status: "cancelled",
          sourceFilename: "stop.mp4",
          finishedAt: "2024-01-01T00:00:03.000Z",
        }),
      ],
    });

    expect(screen.getByText("Completed")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("Cancelled")).toBeTruthy();
  });

  it("splits active and finished jobs under the right headings", () => {
    renderQueues({
      editJobs: [
        job({
          id: "active",
          status: "processing",
          sourceFilename: "live.mp4",
          startedAt: "2024-01-01T00:00:50.000Z",
        }),
        job({
          id: "done",
          status: "completed",
          sourceFilename: "done.mp4",
          startedAt: "2024-01-01T00:00:00.000Z",
          finishedAt: "2024-01-01T00:00:20.000Z",
        }),
      ],
    });

    const jobsSection = screen.getByText("Jobs (Compress / Trim)").closest(
      ".queue-section",
    ) as HTMLElement;
    const subsections = jobsSection.querySelectorAll(".queue-subsection");
    expect(within(subsections[0] as HTMLElement).getByText("live.mp4")).toBeTruthy();
    expect(within(subsections[0] as HTMLElement).queryByText("done.mp4")).toBeNull();
    expect(within(subsections[1] as HTMLElement).getByText("done.mp4")).toBeTruthy();
    expect(within(subsections[1] as HTMLElement).queryByText("live.mp4")).toBeNull();
  });

  it("ticks elapsed time for active jobs", () => {
    renderQueues({
      editJobs: [
        job({
          id: "1",
          status: "processing",
          startedAt: "2024-01-01T00:00:00.000Z",
          sourceFilename: "clip.mp4",
        }),
      ],
    });

    expect(screen.getByText("01:00")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("01:01")).toBeTruthy();
  });

  it("freezes elapsed for finished jobs", () => {
    renderQueues({
      editJobs: [
        job({
          id: "1",
          status: "completed",
          sourceFilename: "done.mp4",
          startedAt: "2024-01-01T00:00:00.000Z",
          finishedAt: "2024-01-01T00:00:42.000Z",
        }),
      ],
    });

    expect(screen.getByText("Completed")).toBeTruthy();
    expect(screen.getByText("00:42")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText("00:42")).toBeTruthy();
  });
});
