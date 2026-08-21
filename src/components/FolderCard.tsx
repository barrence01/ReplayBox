import type { GameFolder } from "../lib/libraryFolders";

interface Props {
  folder: GameFolder;
  onOpen: (folder: GameFolder) => void;
}

export function FolderCard({ folder, onOpen }: Props) {
  return (
    <button
      type="button"
      className="folder-card"
      onClick={() => onOpen(folder)}
    >
      <div className="folder-card__icon" aria-hidden>
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
          <path
            d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9Z"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="currentColor"
            fillOpacity="0.15"
          />
        </svg>
      </div>
      <div className="folder-card__meta">
        <div className="folder-card__name" title={folder.name}>
          {folder.name}
        </div>
        <div className="folder-card__sub">
          {folder.recordingCount}{" "}
          {folder.recordingCount === 1 ? "recording" : "recordings"}
        </div>
      </div>
    </button>
  );
}
