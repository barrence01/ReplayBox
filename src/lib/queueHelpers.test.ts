import { describe, expect, it } from "vitest";
import type { JobStatus } from "../types";
import {
  countActive,
  formatElapsed,
  formatJobElapsed,
  mergeJob,
  queuePosition,
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
