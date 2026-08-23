import { describe, expect, it } from "vitest";
import {
  listGameFolders,
  recordingsInExactDir,
  recordingsInFolder,
} from "./libraryFolders";

const watchDir = "/home/user/Recordings";

describe("listGameFolders", () => {
  it("returns empty for no recordings", () => {
    expect(listGameFolders(watchDir, [])).toEqual([]);
  });

  it("groups root recordings under (Root)", () => {
    const folders = listGameFolders(watchDir, [
      {
        path: `${watchDir}/clip.mp4`,
        dir: watchDir,
        modifiedAt: "2024-01-02T00:00:00Z",
      },
      {
        path: `${watchDir}/other.mp4`,
        dir: `${watchDir}/`,
        indexedAt: "2024-01-01T00:00:00Z",
      },
    ]);
    expect(folders).toHaveLength(1);
    expect(folders[0]).toMatchObject({
      path: watchDir,
      name: "(Root)",
      recordingCount: 2,
      latestModifiedAt: "2024-01-02T00:00:00Z",
    });
  });

  it("groups nested paths under first-level game folders", () => {
    const folders = listGameFolders(watchDir, [
      {
        path: `${watchDir}/CS2/match.mp4`,
        dir: `${watchDir}/CS2`,
        modifiedAt: "2024-02-01T00:00:00Z",
      },
      {
        path: `${watchDir}/CS2/demos/a.mp4`,
        dir: `${watchDir}/CS2/demos`,
        modifiedAt: "2024-03-01T00:00:00Z",
      },
      {
        path: `${watchDir}/Dota2\\clip.mp4`,
        dir: `${watchDir}\\Dota2`,
        modifiedAt: "2024-01-15T00:00:00Z",
      },
    ]);
    const byName = Object.fromEntries(folders.map((f) => [f.name, f]));
    expect(byName.CS2.recordingCount).toBe(2);
    expect(byName.CS2.latestModifiedAt).toBe("2024-03-01T00:00:00Z");
    expect(byName.Dota2.recordingCount).toBe(1);
  });

  it("ignores recordings outside watchDir", () => {
    const folders = listGameFolders(watchDir, [
      {
        path: "/elsewhere/clip.mp4",
        dir: "/elsewhere",
        modifiedAt: "2024-01-01T00:00:00Z",
      },
    ]);
    expect(folders).toEqual([]);
  });
});

describe("recordingsInFolder", () => {
  const recordings = [
    { path: `${watchDir}/root.mp4`, dir: watchDir },
    { path: `${watchDir}/CS2/a.mp4`, dir: `${watchDir}/CS2` },
    { path: `${watchDir}/CS2/demos/b.mp4`, dir: `${watchDir}/CS2/demos` },
  ];

  it("matches root with exact dir only", () => {
    expect(recordingsInFolder(recordings, watchDir, watchDir)).toEqual([
      recordings[0],
    ]);
  });

  it("includes nested recordings for a game folder", () => {
    expect(
      recordingsInFolder(recordings, `${watchDir}/CS2`, watchDir),
    ).toEqual([recordings[1], recordings[2]]);
  });
});

describe("recordingsInExactDir", () => {
  it("filters by exact normalized directory", () => {
    const recordings = [
      { dir: `${watchDir}/CS2/` },
      { dir: `${watchDir}/CS2/demos` },
    ];
    expect(recordingsInExactDir(recordings, `${watchDir}/CS2`)).toEqual([
      recordings[0],
    ]);
  });
});
