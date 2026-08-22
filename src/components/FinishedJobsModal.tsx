import type { ReactNode } from "react";

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/** Modal listing all finished jobs for a queue section. */
export function FinishedJobsModal({ title, onClose, children }: Props) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal modal--queue"
        role="dialog"
        aria-modal="true"
        aria-labelledby="finished-jobs-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="finished-jobs-modal-title">{title}</h2>
        <div className="modal--queue__body">{children}</div>
        <div className="modal__actions">
          <button type="button" className="secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
