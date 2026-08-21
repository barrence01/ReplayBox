import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { JobStatus } from "../types";

interface Props {
  job: JobStatus | null;
  onCancel?: (jobId: string) => void;
  onDismiss?: () => void;
}

function basename(path: string | null): string {
  if (!path) return "…";
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

/** Fixed top bar showing active trim/compress job progress. */
export function JobBar({ job, onCancel, onDismiss }: Props) {
  if (!job) return null;

  const running = job.status === "running";
  const indeterminate = running && job.progress <= 0;
  const percent = Math.round(Math.min(Math.max(job.progress, 0), 1) * 100);
  const filename = basename(job.outputPath);
  const finished =
    job.status === "done" ||
    job.status === "error" ||
    job.status === "cancelled";
  const canOpenFolder = job.status === "done" && !!job.outputPath;
  const outputPath = job.outputPath;

  async function openFolder() {
    if (!outputPath) return;
    try {
      await revealItemInDir(outputPath);
    } catch (e) {
      console.error("Failed to open folder:", e);
    }
  }

  return (
    <div className={`job-bar job-bar--${job.status}`}>
      <div className="job-bar__main">
        <div className="job-bar__meta">
          <strong className="job-bar__kind">{job.kind}</strong>
          <span className="job-bar__file" title={job.outputPath ?? undefined}>
            {filename}
          </span>
          <span className="job-bar__status">
            {job.status}
            {running && !indeterminate ? ` · ${percent}%` : ""}
            {job.message && !running ? ` · ${job.message}` : ""}
          </span>
        </div>
        <div className="job-bar__actions">
          {running && onCancel && (
            <button
              type="button"
              className="secondary"
              onClick={() => onCancel(job.id)}
            >
              Cancel
            </button>
          )}
          {canOpenFolder && (
            <button
              type="button"
              className="secondary"
              onClick={() => void openFolder()}
            >
              Open folder
            </button>
          )}
          {finished && onDismiss && (
            <button type="button" className="secondary" onClick={onDismiss}>
              Dismiss
            </button>
          )}
        </div>
      </div>
      {running && (
        <div
          className={
            indeterminate
              ? "job-bar__track job-bar__track--indeterminate"
              : "job-bar__track"
          }
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={indeterminate ? undefined : percent}
        >
          <div style={indeterminate ? undefined : { width: `${percent}%` }} />
        </div>
      )}
    </div>
  );
}
