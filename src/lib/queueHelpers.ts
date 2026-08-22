/** Helpers for queue position and elapsed time derived from job timestamps. */

import type { JobStatus } from "../types";

export function isActiveJob(status: string): boolean {
  return status === "queued" || status === "processing";
}

export function isTerminalJob(status: string): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

export function queuePosition(jobs: JobStatus[], jobId: string): number | null {
  const queued = jobs.filter((j) => j.status === "queued");
  const index = queued.findIndex((j) => j.id === jobId);
  return index >= 0 ? index + 1 : null;
}

export function formatElapsed(
  fromIso: string | null | undefined,
  endMs: number,
): string {
  if (!fromIso) return "00:00";
  const start = Date.parse(fromIso);
  if (Number.isNaN(start)) return "00:00";
  const totalSec = Math.max(0, Math.floor((endMs - start) / 1000));
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

export function formatJobElapsed(job: JobStatus, nowMs: number): string {
  if (job.status === "queued") {
    return formatElapsed(job.queuedAt, nowMs);
  }
  if (job.status === "processing") {
    return formatElapsed(job.startedAt ?? job.queuedAt, nowMs);
  }
  const parsedEnd = job.finishedAt ? Date.parse(job.finishedAt) : Number.NaN;
  const end = Number.isNaN(parsedEnd) ? nowMs : parsedEnd;
  return formatElapsed(job.startedAt ?? job.queuedAt, end);
}

export function statusLabel(status: string): string {
  switch (status) {
    case "queued":
      return "Waiting in queue";
    case "processing":
      return "Processing";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return status;
  }
}

export function mergeJob(jobs: JobStatus[], next: JobStatus): JobStatus[] {
  const index = jobs.findIndex((j) => j.id === next.id);
  if (index < 0) return [...jobs, next].sort(byQueuedAt);
  const copy = jobs.slice();
  copy[index] = next;
  return copy.sort(byQueuedAt);
}

function byQueuedAt(a: JobStatus, b: JobStatus): number {
  return a.queuedAt.localeCompare(b.queuedAt);
}

export function countActive(jobs: JobStatus[]): {
  processing: number;
  queued: number;
} {
  let processing = 0;
  let queued = 0;
  for (const job of jobs) {
    if (job.status === "processing") processing += 1;
    else if (job.status === "queued") queued += 1;
  }
  return { processing, queued };
}
