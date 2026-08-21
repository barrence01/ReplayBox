import type { JobStatus } from "../types";

interface Props {
  job: JobStatus | null;
  onCancel?: (jobId: string) => void;
}

export function JobProgress({ job, onCancel }: Props) {
  if (!job) return null;

  return (
    <div className={`job-progress job-progress--${job.status}`}>
      <div className="job-progress__row">
        <strong>{job.kind}</strong>
        <span>{job.status}</span>
      </div>
      {job.message && <p>{job.message}</p>}
      {job.status === "running" && (
        <>
          <div className="job-progress__bar">
            <div style={{ width: `${Math.round(job.progress * 100)}%` }} />
          </div>
          {onCancel && (
            <button type="button" className="secondary" onClick={() => onCancel(job.id)}>
              Cancel
            </button>
          )}
        </>
      )}
      {job.outputPath && (
        <p className="job-progress__path">{job.outputPath}</p>
      )}
    </div>
  );
}
