export interface GameFolder {
  /** Absolute path to the game folder under watchDir. */
  path: string;
  name: string;
  recordingCount: number;
}

function normalizeDir(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * First-level game folders under watchDir that contain at least one indexed recording.
 * Videos sitting directly in watchDir are grouped under "(Root)".
 */
export function listGameFolders(
  watchDir: string,
  recordings: { path: string; dir: string }[],
): GameFolder[] {
  const root = normalizeDir(watchDir);
  const rootPrefix = `${root}/`;
  const map = new Map<string, GameFolder>();

  for (const r of recordings) {
    const fileDir = normalizeDir(r.dir);

    if (fileDir === root) {
      const existing = map.get(root);
      if (existing) {
        existing.recordingCount += 1;
      } else {
        map.set(root, {
          path: root,
          name: "(Root)",
          recordingCount: 1,
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
    } else {
      map.set(folderPath, {
        path: folderPath,
        name: firstSeg,
        recordingCount: 1,
      });
    }
  }

  return Array.from(map.values()).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

/** Recordings inside a game folder (including nested subfolders). */
export function recordingsInFolder<T extends { path: string; dir: string }>(
  recordings: T[],
  folderPath: string,
): T[] {
  const folder = normalizeDir(folderPath);
  const prefix = `${folder}/`;
  return recordings.filter((r) => {
    const dir = normalizeDir(r.dir);
    const path = normalizeDir(r.path);
    return dir === folder || dir.startsWith(prefix) || path.startsWith(prefix);
  });
}
