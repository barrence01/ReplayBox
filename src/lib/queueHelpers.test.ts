import { describe, expect, it } from "vitest";
import type { JobStatus } from "../types";
import {
  compareFinishedJobs,
  countActive,
  formatElapsed,
  formatJobElapsed,
  formatJobFinishedAt,
  isActiveJob,
  isTerminalJob,
  mergeJob,
  queuePosition,
  sortFinishedJobs,
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

  it("sorts finished jobs newest first by finishedAt", () => {
    const sorted = sortFinishedJobs([
      job({
        id: "old",
        status: "completed",
        finishedAt: "2024-01-01T00:00:10.000Z",
      }),
      job({ id: "active", status: "processing" }),
      job({
        id: "new",
        status: "failed",
        finishedAt: "2024-01-01T00:00:30.000Z",
      }),
      job({
        id: "mid",
        status: "cancelled",
        finishedAt: "2024-01-01T00:00:20.000Z",
      }),
    ]);
    expect(sorted.map((j) => j.id)).toEqual(["new", "mid", "old"]);
  });

  it("compares finished jobs with missing finishedAt last", () => {
    const withTime = job({
      id: "a",
      status: "completed",
      finishedAt: "2024-01-01T00:00:10.000Z",
    });
    const without = job({ id: "b", status: "completed", finishedAt: null });
    expect(compareFinishedJobs(withTime, without)).toBeLessThan(0);
    expect(compareFinishedJobs(without, withTime)).toBeGreaterThan(0);
  });

  it("formats finishedAt as local clock time", () => {
    const formatted = formatJobFinishedAt("2024-01-01T15:42:00.000Z");
    expect(formatted).toBeTruthy();
    expect(formatted).toMatch(/\d/);
    expect(formatJobFinishedAt(null)).toBeNull();
    expect(formatJobFinishedAt("not-a-date")).toBeNull();
  });
});
