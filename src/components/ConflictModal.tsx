interface Props {
  filename: string;
  onReplace: () => void;
  onCreateNew: () => void;
  onCancel: () => void;
}

/** Modal when a Create a copy destination already exists. */
export function ConflictModal({
  filename,
  onReplace,
  onCreateNew,
  onCancel,
}: Props) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="conflict-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="conflict-modal-title">Copy already exists</h2>
        <p>
          A file named <strong className="mono">{filename}</strong> already
          exists. Replace it or create a new numbered copy?
        </p>
        <div className="modal__actions">
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="secondary" onClick={onCreateNew}>
            Create new
          </button>
          <button type="button" onClick={onReplace}>
            Replace existing
          </button>
        </div>
      </div>
    </div>
  );
}
