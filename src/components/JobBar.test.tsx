import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobStatus } from "../types";
import { JobBar } from "./JobBar";

function job(partial: Partial<JobStatus> & Pick<JobStatus, "id" | "status" | "kind">): JobStatus {
  return {
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

describe("JobBar", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders nothing when there are no active jobs", () => {
    const { container } = render(
      <JobBar
        editJobs={[job({ id: "1", kind: "trim", status: "completed" })]}
        previewJobs={[]}
        onOpenQueues={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows active counts and opens queues on click", () => {
    const onOpenQueues = vi.fn();
    render(
      <JobBar
        editJobs={[job({ id: "1", kind: "compress", status: "processing" })]}
        previewJobs={[job({ id: "2", kind: "preview", status: "queued" })]}
        onOpenQueues={onOpenQueues}
      />,
    );

    expect(
      screen.getByText(
        "Jobs 1 processing · 0 queued · Preview 0 processing · 1 queued",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Queues/ }));
    expect(onOpenQueues).toHaveBeenCalled();
  });
});
