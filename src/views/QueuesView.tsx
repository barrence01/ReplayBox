import { useEffect, useState } from "react";
import type { JobStatus } from "../types";
import { FinishedJobsModal } from "../components/FinishedJobsModal";
import {
  FINISHED_VISIBLE_LIMIT,
  formatJobElapsed,
  formatJobFinishedAt,
  isActiveJob,
  isTerminalJob,
  queuePosition,
  sortFinishedJobs,
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

function isPreviewJob(job: JobStatus): boolean {
  return job.kind === "preview";
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
  const finishedAtLabel = terminal ? formatJobFinishedAt(job.finishedAt) : null;

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
        <span className="queue-row__time" title="Elapsed duration">
          <span className="queue-row__hint">Elapsed</span> {elapsed}
        </span>
        {finishedAtLabel && (
          <span className="queue-row__finished-at" title="Finished at">
            <span className="queue-row__hint">Ended</span> {finishedAtLabel}
          </span>
        )}
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

function ActiveQueueSection({
  title,
  jobs,
  nowMs,
  onCancel,
}: {
  title: string;
  jobs: JobStatus[];
  nowMs: number;
  onCancel: (id: string) => void;
}) {
  const active = jobs.filter((j) => isActiveJob(j.status));

  return (
    <section className="queue-section">
      <div className="queue-section__header">
        <h2>{title}</h2>
      </div>
      <JobList
        jobs={active}
        allJobs={jobs}
        nowMs={nowMs}
        emptyLabel="No active jobs."
        onCancel={onCancel}
        onDismiss={() => undefined}
      />
    </section>
  );
}

function GlobalFinishedSection({
  editJobs,
  previewJobs,
  nowMs,
  onDismissEdit,
  onDismissPreview,
  onClearAllFinished,
}: {
  editJobs: JobStatus[];
  previewJobs: JobStatus[];
  nowMs: number;
  onDismissEdit: (id: string) => void;
  onDismissPreview: (id: string) => void;
  onClearAllFinished: () => void;
}) {
  const [showAllFinished, setShowAllFinished] = useState(false);
  const allJobs = [...editJobs, ...previewJobs];
  const finished = sortFinishedJobs(allJobs);
  const visibleFinished = finished.slice(0, FINISHED_VISIBLE_LIMIT);

  function dismiss(id: string) {
    const job = allJobs.find((j) => j.id === id);
    if (!job) return;
    if (isPreviewJob(job)) onDismissPreview(id);
    else onDismissEdit(id);
  }

  return (
    <section className="queue-section queue-section--finished">
      <div className="queue-section__header">
        <h2>Finished</h2>
        {finished.length > 0 && (
          <button type="button" className="secondary" onClick={onClearAllFinished}>
            Clear finished
          </button>
        )}
      </div>
      <JobList
        jobs={visibleFinished}
        allJobs={allJobs}
        nowMs={nowMs}
        emptyLabel="No finished jobs."
        onCancel={() => undefined}
        onDismiss={dismiss}
      />
      {finished.length > FINISHED_VISIBLE_LIMIT && (
        <button
          type="button"
          className="secondary queue-subsection__see-more"
          onClick={() => setShowAllFinished(true)}
        >
          See more ({finished.length})
        </button>
      )}
      {showAllFinished && (
        <FinishedJobsModal
          title="Finished jobs"
          onClose={() => setShowAllFinished(false)}
        >
          <JobList
            jobs={finished}
            allJobs={allJobs}
            nowMs={nowMs}
            emptyLabel="No finished jobs."
            onCancel={() => undefined}
            onDismiss={dismiss}
          />
        </FinishedJobsModal>
      )}
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

  function clearAllFinished() {
    onClearEditFinished();
    onClearPreviewFinished();
  }

  return (
    <div className="queues-view">
      <header className="queues-view__header">
        <h1>Queues</h1>
        <p className="muted">
          Running tasks are shown here.
        </p>
      </header>

      <ActiveQueueSection
        title="Jobs (Compress / Trim)"
        jobs={editJobs}
        nowMs={nowMs}
        onCancel={onCancelEdit}
      />

      <ActiveQueueSection
        title="Preview"
        jobs={previewJobs}
        nowMs={nowMs}
        onCancel={onCancelPreview}
      />

      <GlobalFinishedSection
        editJobs={editJobs}
        previewJobs={previewJobs}
        nowMs={nowMs}
        onDismissEdit={onDismissEdit}
        onDismissPreview={onDismissPreview}
        onClearAllFinished={clearAllFinished}
      />
    </div>
  );
}
