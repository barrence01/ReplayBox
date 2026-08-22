import { useEffect, useState } from "react";
import type { JobStatus } from "../types";
import {
  formatJobElapsed,
  isActiveJob,
  isTerminalJob,
  queuePosition,
  statusLabel,
} from "../lib/queueHelpers";

interface Props {
  editJobs: JobStatus[];
  previewJobs: JobStatus[];
  onCancelEdit: (jobId: string) => void;
  onCancelPreview: (jobId: string) => void;
  onDismissEdit: (jobId: string) => void;
  onDismissPreview: (jobId: string) => void;
  onClearEditFinished: () => void;
  onClearPreviewFinished: () => void;
}

function displayName(job: JobStatus): string {
  return job.sourceFilename || job.outputPath?.split(/[/\\]/).pop() || job.id;
}

function QueueRow({
  job,
  jobs,
  nowMs,
  onCancel,
  onDismiss,
}: {
  job: JobStatus;
  jobs: JobStatus[];
  nowMs: number;
  onCancel: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const queued = job.status === "queued";
  const processing = job.status === "processing";
  const terminal = isTerminalJob(job.status);
  const position = queued ? queuePosition(jobs, job.id) : null;
  const percent = Math.round(Math.min(Math.max(job.progress, 0), 1) * 100);
  const elapsed = formatJobElapsed(job, nowMs);

  return (
    <li className={`queue-row queue-row--${job.status}`}>
      <div className="queue-row__main">
        <span className="queue-row__kind">{job.kind}</span>
        <span className="queue-row__file" title={job.sourcePath ?? undefined}>
          {displayName(job)}
        </span>
        <span className="queue-row__status">
          {queued && (
            <>
              {statusLabel("queued")}
              {position != null ? ` · #${position}` : ""}
            </>
          )}
          {processing && (
            <>
              {statusLabel("processing")}
              {job.kind !== "preview" ? ` · ${percent}%` : ""}
            </>
          )}
          {terminal && statusLabel(job.status)}
          {job.message && terminal ? ` · ${job.message}` : ""}
        </span>
        <span className="queue-row__time">{elapsed}</span>
        <div className="queue-row__actions">
          {(queued || processing) && (
            <button
              type="button"
              className="secondary"
              onClick={() => onCancel(job.id)}
            >
              Cancel
            </button>
          )}
          {terminal && (
            <button
              type="button"
              className="secondary"
              onClick={() => onDismiss(job.id)}
            >
              Dismiss
            </button>
          )}
        </div>
      </div>
      {processing && job.kind !== "preview" && (
        <div
          className={
            percent <= 0
              ? "queue-row__track queue-row__track--indeterminate"
              : "queue-row__track"
          }
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent <= 0 ? undefined : percent}
        >
          <div style={percent <= 0 ? undefined : { width: `${percent}%` }} />
        </div>
      )}
    </li>
  );
}

function JobList({
  jobs,
  allJobs,
  nowMs,
  emptyLabel,
  onCancel,
  onDismiss,
}: {
  jobs: JobStatus[];
  allJobs: JobStatus[];
  nowMs: number;
  emptyLabel: string;
  onCancel: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  if (jobs.length === 0) {
    return <p className="muted empty-state">{emptyLabel}</p>;
  }
  return (
    <ul className="queue-list">
      {jobs.map((job) => (
        <QueueRow
          key={job.id}
          job={job}
          jobs={allJobs}
          nowMs={nowMs}
          onCancel={onCancel}
          onDismiss={onDismiss}
        />
      ))}
    </ul>
  );
}

function QueueSection({
  title,
  jobs,
  nowMs,
  onCancel,
  onDismiss,
  onClearFinished,
}: {
  title: string;
  jobs: JobStatus[];
  nowMs: number;
  onCancel: (id: string) => void;
  onDismiss: (id: string) => void;
  onClearFinished: () => void;
}) {
  const active = jobs.filter((j) => isActiveJob(j.status));
  const finished = jobs.filter((j) => isTerminalJob(j.status));

  return (
    <section className="queue-section">
      <div className="queue-section__header">
        <h2>{title}</h2>
      </div>

      <div className="queue-subsection">
        <h3 className="queue-subsection__title">Active</h3>
        <JobList
          jobs={active}
          allJobs={jobs}
          nowMs={nowMs}
          emptyLabel="No active jobs."
          onCancel={onCancel}
          onDismiss={onDismiss}
        />
      </div>

      <div className="queue-subsection">
        <div className="queue-subsection__header">
          <h3 className="queue-subsection__title">Finished</h3>
          {finished.length > 0 && (
            <button type="button" className="secondary" onClick={onClearFinished}>
              Clear finished
            </button>
          )}
        </div>
        <JobList
          jobs={finished}
          allJobs={jobs}
          nowMs={nowMs}
          emptyLabel="No finished jobs."
          onCancel={onCancel}
          onDismiss={onDismiss}
        />
      </div>
    </section>
  );
}

/** Queues page: edit jobs (trim/compress) and preview preparation. */
export function QueuesView({
  editJobs,
  previewJobs,
  onCancelEdit,
  onCancelPreview,
  onDismissEdit,
  onDismissPreview,
  onClearEditFinished,
  onClearPreviewFinished,
}: Props) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="queues-view">
      <header className="queues-view__header">
        <h1>Queues</h1>
        <p className="muted">
          Edit jobs share one queue. Preview preparation runs on its own queue.
        </p>
      </header>

      <QueueSection
        title="Jobs (Compress / Trim)"
        jobs={editJobs}
        nowMs={nowMs}
        onCancel={onCancelEdit}
        onDismiss={onDismissEdit}
        onClearFinished={onClearEditFinished}
      />

      <QueueSection
        title="Preview"
        jobs={previewJobs}
        nowMs={nowMs}
        onCancel={onCancelPreview}
        onDismiss={onDismissPreview}
        onClearFinished={onClearPreviewFinished}
      />
    </div>
  );
}
