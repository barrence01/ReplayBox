export interface GameFolder {
  /** Absolute path to the game folder under watchDir. */
  path: string;
  name: string;
  recordingCount: number;
  /** Latest recording mtime in this folder (for sorting). */
  latestModifiedAt: string | null;
}

function normalizeDir(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

function recordingMtime(r: {
  modifiedAt?: string | null;
  indexedAt?: string;
}): string | null {
  return r.modifiedAt ?? r.indexedAt ?? null;
}

function maxTimestamp(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a.localeCompare(b) >= 0 ? a : b;
}

/**
 * First-level game folders under watchDir that contain at least one indexed recording.
 * Videos sitting directly in watchDir are grouped under "(Root)".
 */
export function listGameFolders(
  watchDir: string,
  recordings: {
    path: string;
    dir: string;
    modifiedAt?: string | null;
    indexedAt?: string;
  }[],
): GameFolder[] {
  const root = normalizeDir(watchDir);
  const rootPrefix = `${root}/`;
  const map = new Map<string, GameFolder>();

  for (const r of recordings) {
    const fileDir = normalizeDir(r.dir);
    const mtime = recordingMtime(r);

    if (fileDir === root) {
      const existing = map.get(root);
      if (existing) {
        existing.recordingCount += 1;
        existing.latestModifiedAt = maxTimestamp(
          existing.latestModifiedAt,
          mtime,
        );
      } else {
        map.set(root, {
          path: root,
          name: "(Root)",
          recordingCount: 1,
          latestModifiedAt: mtime,
        });
      }
      continue;
    }

    if (!fileDir.startsWith(rootPrefix)) {
      continue;
    }

    const relativeDir = fileDir.slice(rootPrefix.length);
    const firstSeg = relativeDir.split("/").filter(Boolean)[0];
    if (!firstSeg) {
      continue;
    }

    const folderPath = `${rootPrefix}${firstSeg}`;
    const existing = map.get(folderPath);
    if (existing) {
      existing.recordingCount += 1;
      existing.latestModifiedAt = maxTimestamp(
        existing.latestModifiedAt,
        mtime,
      );
    } else {
      map.set(folderPath, {
        path: folderPath,
        name: firstSeg,
        recordingCount: 1,
        latestModifiedAt: mtime,
      });
    }
  }

  return Array.from(map.values());
}

/** Recordings inside a game folder. Root uses exact dir match only. */
export function recordingsInFolder<T extends { path: string; dir: string }>(
  recordings: T[],
  folderPath: string,
  watchDir: string,
): T[] {
  const folder = normalizeDir(folderPath);
  const root = normalizeDir(watchDir);

  if (folder === root) {
    return recordings.filter((r) => normalizeDir(r.dir) === root);
  }

  const prefix = `${folder}/`;
  return recordings.filter((r) => {
    const dir = normalizeDir(r.dir);
    const path = normalizeDir(r.path);
    return dir === folder || dir.startsWith(prefix) || path.startsWith(prefix);
  });
}

/** Recordings whose parent directory matches exactly. */
export function recordingsInExactDir<T extends { dir: string }>(
  recordings: T[],
  dir: string,
): T[] {
  const normalized = normalizeDir(dir);
  return recordings.filter((r) => normalizeDir(r.dir) === normalized);
}
