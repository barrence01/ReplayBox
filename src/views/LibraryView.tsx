import { useMemo, useState } from "react";
import type { Recording } from "../types";
import { RecordingGrid } from "../components/RecordingGrid";
import { FolderCard } from "../components/FolderCard";
import {
  listGameFolders,
  recordingsInFolder,
  type GameFolder,
} from "../lib/libraryFolders";
import {
  compareTimestamps,
  sortRecordings,
  type SortOrder,
} from "../lib/sortRecordings";

interface Props {
  watchDir: string;
  recordings: Recording[];
  libraryReady: boolean;
  onOpen: (recording: Recording) => void;
  onRescan: () => Promise<void>;
  onScanFolder: (folderPath: string) => Promise<void>;
  fullScanning: boolean;
  folderScanningPath: string | null;
}

export function LibraryView({
  watchDir,
  recordings,
  libraryReady,
  onOpen,
  onRescan,
  onScanFolder,
  fullScanning,
  folderScanningPath,
}: Props) {
  const [query, setQuery] = useState("");
  const [selectedFolder, setSelectedFolder] = useState<GameFolder | null>(null);
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest");

  const folders = useMemo(
    () => listGameFolders(watchDir, recordings),
    [watchDir, recordings],
  );

  const filteredFolders = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? folders.filter((f) => f.name.toLowerCase().includes(q))
      : folders;
    return [...list].sort((a, b) => {
      const aRoot = a.name === "(Root)";
      const bRoot = b.name === "(Root)";
      if (aRoot !== bRoot) return aRoot ? -1 : 1;
      const byTime = compareTimestamps(
        a.latestModifiedAt,
        b.latestModifiedAt,
        sortOrder,
      );
      if (byTime !== 0) return byTime;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
  }, [folders, query, sortOrder]);

  const folderRecordings = useMemo(() => {
    if (!selectedFolder) return [];
    const list = recordingsInFolder(
      recordings,
      selectedFolder.path,
      watchDir,
    );
    const q = query.trim().toLowerCase();
    const filtered = q
      ? list.filter(
          (r) =>
            r.filename.toLowerCase().includes(q) ||
            r.dir.toLowerCase().includes(q),
        )
      : list;
    return sortRecordings(filtered, sortOrder);
  }, [selectedFolder, recordings, query, watchDir, sortOrder]);

  const folderScanning =
    selectedFolder !== null &&
    folderScanningPath !== null &&
    folderScanningPath === selectedFolder.path;

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
                <span className="breadcrumb__current" title={selectedFolder.name}>
                  {selectedFolder.name}
                </span>
              </>
            )}
          </nav>
          <h1 title={selectedFolder ? selectedFolder.name : undefined}>
            {selectedFolder ? selectedFolder.name : "Library"}
          </h1>
          <p>
            {selectedFolder
              ? folderScanning
                ? "Updating recordings in this folder…"
                : "Recordings in this game folder."
              : "Game folders under the watch directory."}
          </p>
        </div>
        <div className="view__actions">
          <label className="sort-select">
            <span className="sr-only">Sort order</span>
            <select
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value as SortOrder)}
              aria-label="Sort order"
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </select>
          </label>
          <input
            type="search"
            placeholder={
              selectedFolder ? "Search recordings…" : "Search folders…"
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            type="button"
            disabled={fullScanning}
            onClick={() => void onRescan()}
          >
            {fullScanning ? "Scanning…" : "Rescan"}
          </button>
        </div>
      </header>

      {!selectedFolder ? (
        !libraryReady ? (
          <p className="empty-state">Loading library…</p>
        ) : filteredFolders.length === 0 ? (
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
                  void onScanFolder(f.path);
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
