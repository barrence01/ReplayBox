import { describe, expect, it } from "vitest";
import type { JobStatus } from "../types";
import {
  countActive,
  formatElapsed,
  formatJobElapsed,
  isActiveJob,
  isTerminalJob,
  mergeJob,
  queuePosition,
  statusLabel,
} from "./queueHelpers";

function job(partial: Partial<JobStatus> & Pick<JobStatus, "id" | "status">): JobStatus {
  return {
    kind: "trim",
    progress: 0,
    message: null,
    outputPath: null,
    sourcePath: null,
    sourceFilename: null,
    queuedAt: "2024-01-01T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    ...partial,
  };
}

describe("queueHelpers", () => {
  it("computes queue position among queued jobs", () => {
    const jobs = [
      job({ id: "a", status: "processing" }),
      job({ id: "b", status: "queued", queuedAt: "2024-01-01T00:00:01.000Z" }),
      job({ id: "c", status: "queued", queuedAt: "2024-01-01T00:00:02.000Z" }),
    ];
    expect(queuePosition(jobs, "b")).toBe(1);
    expect(queuePosition(jobs, "c")).toBe(2);
    expect(queuePosition(jobs, "a")).toBeNull();
  });

  it("formats elapsed from iso timestamp", () => {
    const now = Date.parse("2024-01-01T00:01:05.000Z");
    expect(formatElapsed("2024-01-01T00:00:00.000Z", now)).toBe("01:05");
  });

  it("freezes terminal job elapsed at finishedAt", () => {
    const now = Date.parse("2024-01-01T00:10:00.000Z");
    expect(
      formatJobElapsed(
        job({
          id: "a",
          status: "completed",
          startedAt: "2024-01-01T00:00:00.000Z",
          finishedAt: "2024-01-01T00:00:30.000Z",
        }),
        now,
      ),
    ).toBe("00:30");
  });

  it("formats queued and processing elapsed from the right timestamps", () => {
    const now = Date.parse("2024-01-01T00:01:00.000Z");
    expect(
      formatJobElapsed(
        job({
          id: "q",
          status: "queued",
          queuedAt: "2024-01-01T00:00:40.000Z",
        }),
        now,
      ),
    ).toBe("00:20");
    expect(
      formatJobElapsed(
        job({
          id: "p",
          status: "processing",
          queuedAt: "2024-01-01T00:00:00.000Z",
          startedAt: "2024-01-01T00:00:50.000Z",
        }),
        now,
      ),
    ).toBe("00:10");
  });

  it("maps status labels", () => {
    expect(statusLabel("queued")).toBe("Waiting in queue");
    expect(statusLabel("processing")).toBe("Processing");
    expect(statusLabel("completed")).toBe("Completed");
    expect(statusLabel("failed")).toBe("Failed");
    expect(statusLabel("cancelled")).toBe("Cancelled");
  });

  it("classifies active and terminal statuses", () => {
    expect(isActiveJob("queued")).toBe(true);
    expect(isActiveJob("processing")).toBe(true);
    expect(isActiveJob("completed")).toBe(false);
    expect(isTerminalJob("completed")).toBe(true);
    expect(isTerminalJob("failed")).toBe(true);
    expect(isTerminalJob("cancelled")).toBe(true);
    expect(isTerminalJob("queued")).toBe(false);
  });

  it("merges job updates by id", () => {
    const jobs = [job({ id: "a", status: "queued" })];
    const next = mergeJob(jobs, job({ id: "a", status: "processing", progress: 0.5 }));
    expect(next).toHaveLength(1);
    expect(next[0].status).toBe("processing");
    expect(next[0].progress).toBe(0.5);
  });

  it("counts active jobs", () => {
    expect(
      countActive([
        job({ id: "a", status: "processing" }),
        job({ id: "b", status: "queued" }),
        job({ id: "c", status: "completed" }),
      ]),
    ).toEqual({ processing: 1, queued: 1 });
  });
});
