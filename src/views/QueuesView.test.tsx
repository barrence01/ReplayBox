import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    render(
      <QueuesView
        editJobs={[]}
        previewJobs={[]}
        onCancelEdit={vi.fn()}
        onCancelPreview={vi.fn()}
        onDismissEdit={vi.fn()}
        onDismissPreview={vi.fn()}
        onClearEditFinished={vi.fn()}
        onClearPreviewFinished={vi.fn()}
      />,
    );
    expect(screen.getAllByText("No active jobs.").length).toBeGreaterThan(0);
    expect(screen.getAllByText("No finished jobs.").length).toBeGreaterThan(0);
  });

  it("shows queue position and cancel for queued edit job", () => {
    const onCancelEdit = vi.fn();
    render(
      <QueuesView
        editJobs={[
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
        ]}
        previewJobs={[]}
        onCancelEdit={onCancelEdit}
        onCancelPreview={vi.fn()}
        onDismissEdit={vi.fn()}
        onDismissPreview={vi.fn()}
        onClearEditFinished={vi.fn()}
        onClearPreviewFinished={vi.fn()}
      />,
    );

    expect(screen.getByText(/Waiting in queue · #1/)).toBeTruthy();
    const cancelButtons = screen.getAllByRole("button", { name: "Cancel" });
    fireEvent.click(cancelButtons[1]);
    expect(onCancelEdit).toHaveBeenCalledWith("2");
  });

  it("ticks elapsed time for active jobs", () => {
    render(
      <QueuesView
        editJobs={[
          job({
            id: "1",
            status: "processing",
            startedAt: "2024-01-01T00:00:00.000Z",
            sourceFilename: "clip.mp4",
          }),
        ]}
        previewJobs={[]}
        onCancelEdit={vi.fn()}
        onCancelPreview={vi.fn()}
        onDismissEdit={vi.fn()}
        onDismissPreview={vi.fn()}
        onClearEditFinished={vi.fn()}
        onClearPreviewFinished={vi.fn()}
      />,
    );

    expect(screen.getByText("01:00")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("01:01")).toBeTruthy();
  });

  it("freezes elapsed for finished jobs", () => {
    render(
      <QueuesView
        editJobs={[
          job({
            id: "1",
            status: "completed",
            sourceFilename: "done.mp4",
            startedAt: "2024-01-01T00:00:00.000Z",
            finishedAt: "2024-01-01T00:00:42.000Z",
          }),
        ]}
        previewJobs={[]}
        onCancelEdit={vi.fn()}
        onCancelPreview={vi.fn()}
        onDismissEdit={vi.fn()}
        onDismissPreview={vi.fn()}
        onClearEditFinished={vi.fn()}
        onClearPreviewFinished={vi.fn()}
      />,
    );

    expect(screen.getByText("Completed")).toBeTruthy();
    expect(screen.getByText("00:42")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText("00:42")).toBeTruthy();
  });
});
