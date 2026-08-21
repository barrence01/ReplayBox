import { useMemo, useState } from "react";
import type { Recording } from "../types";
import { RecordingGrid } from "../components/RecordingGrid";
import { FolderCard } from "../components/FolderCard";
import {
  listGameFolders,
  recordingsInFolder,
  type GameFolder,
} from "../lib/libraryFolders";

interface Props {
  watchDir: string;
  recordings: Recording[];
  onOpen: (recording: Recording) => void;
  onRescan: () => Promise<void>;
  onRefresh: () => Promise<void>;
}

export function LibraryView({
  watchDir,
  recordings,
  onOpen,
  onRescan,
  onRefresh,
}: Props) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState<GameFolder | null>(null);

  const folders = useMemo(
    () => listGameFolders(watchDir, recordings),
    [watchDir, recordings],
  );

  const filteredFolders = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return folders;
    return folders.filter((f) => f.name.toLowerCase().includes(q));
  }, [folders, query]);

  const folderRecordings = useMemo(() => {
    if (!selectedFolder) return [];
    const list = recordingsInFolder(recordings, selectedFolder.path);
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (r) =>
        r.filename.toLowerCase().includes(q) ||
        r.dir.toLowerCase().includes(q),
    );
  }, [selectedFolder, recordings, query]);

  return (
    <section className="view">
      <header className="view__header">
        <div>
          <nav className="breadcrumb" aria-label="Library breadcrumb">
            <button
              type="button"
              className="linkish"
              onClick={() => {
                setSelectedFolder(null);
                setQuery("");
              }}
            >
              Library
            </button>
            {selectedFolder && (
              <>
                <span className="breadcrumb__sep">/</span>
                <span>{selectedFolder.name}</span>
              </>
            )}
          </nav>
          <h1>{selectedFolder ? selectedFolder.name : "Library"}</h1>
          <p>
            {selectedFolder
              ? "Recordings in this game folder."
              : "Game folders under the watch directory."}
          </p>
        </div>
        <div className="view__actions">
          <input
            type="search"
            placeholder={
              selectedFolder
                ? "Search recordings…"
                : "Search folders…"
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onRescan();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Scanning…" : "Rescan"}
          </button>
        </div>
      </header>

      {!selectedFolder ? (
        filteredFolders.length === 0 ? (
          <p className="empty-state">
            No game folders found. Set a watch folder in Settings and rescan.
          </p>
        ) : (
          <div className="folder-grid">
            {filteredFolders.map((folder) => (
              <FolderCard
                key={folder.path}
                folder={folder}
                onOpen={(f) => {
                  setSelectedFolder(f);
                  setQuery("");
                  void onRefresh();
                }}
              />
            ))}
          </div>
        )
      ) : (
        <RecordingGrid
          recordings={folderRecordings}
          emptyMessage="No recordings in this folder."
          onOpen={onOpen}
        />
      )}
    </section>
  );
}
