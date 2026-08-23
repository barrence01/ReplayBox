import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { JobStatus } from "../types";
import { formatJobFinishedAt } from "../lib/queueHelpers";
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

function finishedSection(): HTMLElement {
  return screen.getByText("Finished", { selector: "h2" }).closest(
    ".queue-section",
  ) as HTMLElement;
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
    expect(screen.getAllByText("No active jobs.").length).toBe(2);
    expect(screen.getByText("No finished jobs.")).toBeTruthy();
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

  it("dismisses finished edit jobs from the global finished section", () => {
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

  it("dismisses finished preview jobs from the global finished section", () => {
    const { props } = renderQueues({
      previewJobs: [
        job({
          id: "p1",
          kind: "preview",
          status: "completed",
          sourceFilename: "preview-done.mp4",
          finishedAt: "2024-01-01T00:00:42.000Z",
        }),
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(props.onDismissPreview).toHaveBeenCalledWith("p1");
  });

  it("clears finished jobs from both queues", () => {
    const { props } = renderQueues({
      editJobs: [
        job({
          id: "1",
          status: "failed",
          sourceFilename: "bad.mp4",
          finishedAt: "2024-01-01T00:00:10.000Z",
        }),
      ],
      previewJobs: [
        job({
          id: "p1",
          kind: "preview",
          status: "completed",
          sourceFilename: "preview-done.mp4",
          finishedAt: "2024-01-01T00:00:20.000Z",
        }),
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Clear finished" }));
    expect(props.onClearEditFinished).toHaveBeenCalled();
    expect(props.onClearPreviewFinished).toHaveBeenCalled();
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

  it("keeps active jobs in queue sections and finished in the global section", () => {
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
      previewJobs: [
        job({
          id: "p-done",
          kind: "preview",
          status: "completed",
          sourceFilename: "preview-done.mp4",
          finishedAt: "2024-01-01T00:00:30.000Z",
        }),
      ],
    });

    const jobsSection = screen.getByText("Jobs (Compress / Trim)").closest(
      ".queue-section",
    ) as HTMLElement;
    expect(within(jobsSection).getByText("live.mp4")).toBeTruthy();
    expect(within(jobsSection).queryByText("done.mp4")).toBeNull();

    const finished = finishedSection();
    expect(within(finished).getByText("done.mp4")).toBeTruthy();
    expect(within(finished).getByText("preview-done.mp4")).toBeTruthy();
    expect(within(finished).queryByText("live.mp4")).toBeNull();
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

  it("orders global finished jobs newest first across queues", () => {
    renderQueues({
      editJobs: [
        job({
          id: "old",
          status: "completed",
          sourceFilename: "old.mp4",
          finishedAt: "2024-01-01T00:00:10.000Z",
        }),
        job({
          id: "mid",
          status: "failed",
          sourceFilename: "mid.mp4",
          finishedAt: "2024-01-01T00:00:20.000Z",
        }),
      ],
      previewJobs: [
        job({
          id: "new",
          kind: "preview",
          status: "completed",
          sourceFilename: "new.mp4",
          finishedAt: "2024-01-01T00:00:40.000Z",
        }),
      ],
    });

    const files = within(finishedSection())
      .getAllByText(/\.mp4$/)
      .map((el) => el.textContent);
    expect(files).toEqual(["new.mp4", "mid.mp4", "old.mp4"]);
  });

  it("caps global finished list at five and opens see more modal", () => {
    const editJobs = Array.from({ length: 3 }, (_, i) =>
      job({
        id: `e${i}`,
        status: "completed",
        sourceFilename: `edit-${i}.mp4`,
        finishedAt: `2024-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      }),
    );
    const previewJobs = Array.from({ length: 3 }, (_, i) =>
      job({
        id: `p${i}`,
        kind: "preview",
        status: "completed",
        sourceFilename: `preview-${i}.mp4`,
        finishedAt: `2024-01-01T00:00:${String(i + 3).padStart(2, "0")}.000Z`,
      }),
    );

    renderQueues({ editJobs, previewJobs });

    const finished = finishedSection();
    expect(within(finished).getByText("preview-2.mp4")).toBeTruthy();
    expect(within(finished).getByText("edit-1.mp4")).toBeTruthy();
    expect(within(finished).queryByText("edit-0.mp4")).toBeNull();

    fireEvent.click(within(finished).getByRole("button", { name: "See more (6)" }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Finished jobs")).toBeTruthy();
    expect(within(dialog).getByText("edit-0.mp4")).toBeTruthy();
    expect(within(dialog).getByText("preview-2.mp4")).toBeTruthy();
  });

  it("shows local finish time for finished jobs", () => {
    const finishedAt = "2024-01-01T00:00:42.000Z";
    const label = formatJobFinishedAt(finishedAt);
    expect(label).toBeTruthy();

    renderQueues({
      editJobs: [
        job({
          id: "1",
          status: "completed",
          sourceFilename: "done.mp4",
          startedAt: "2024-01-01T00:00:00.000Z",
          finishedAt,
        }),
      ],
    });

    expect(screen.getByText(label!)).toBeTruthy();
  });
});
