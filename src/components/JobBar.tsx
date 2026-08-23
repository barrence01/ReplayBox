import type { JobStatus } from "../types";
import { countActive } from "../lib/queueHelpers";

interface Props {
  editJobs: JobStatus[];
  previewJobs: JobStatus[];
  onOpenQueues: () => void;
}

/** Compact summary of active edit and preview queue work. */
export function JobBar({ editJobs, previewJobs, onOpenQueues }: Props) {
  const edit = countActive(editJobs);
  const preview = countActive(previewJobs);
  const total = edit.processing + edit.queued + preview.processing + preview.queued;
  if (total === 0) return null;

  const parts: string[] = [];
  if (edit.processing + edit.queued > 0) {
    parts.push(
      `Jobs ${edit.processing} processing · ${edit.queued} queued`,
    );
  }
  if (preview.processing + preview.queued > 0) {
    parts.push(
      `Preview ${preview.processing} processing · ${preview.queued} queued`,
    );
  }

  return (
    <button type="button" className="job-bar job-bar--summary" onClick={onOpenQueues}>
      <div className="job-bar__main">
        <div className="job-bar__meta">
          <strong className="job-bar__kind">Queues</strong>
          <span className="job-bar__status">{parts.join(" · ")}</span>
        </div>
        <span className="job-bar__actions muted">Open</span>
      </div>
    </button>
  );
}
