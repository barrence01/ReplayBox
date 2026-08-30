import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  clearRecordingsCache,
  loadRecordingsCache,
  saveRecordingsCache,
} from "./recordingsCache";
import type { Recording } from "../types";

const storage = new Map<string, string>();

const sample: Recording = {
  id: "r1",
  path: "/watch/clip.mp4",
  filename: "clip.mp4",
  dir: "/watch",
  sizeBytes: 100,
  durationMs: 1000,
  width: null,
  height: null,
  videoCodec: null,
  audioCodec: null,
  isVfr: false,
  createdAt: null,
  modifiedAt: null,
  thumbnailPath: null,
  sessionId: null,
  indexedAt: "2024-01-01T00:00:00Z",
};

describe("recordingsCache", () => {
  beforeEach(() => {
    storage.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    });
    clearRecordingsCache();
  });

  it("returns null when cache is empty", () => {
    expect(loadRecordingsCache("/watch")).toBeNull();
  });

  it("saves and loads recordings for the same watch dir", () => {
    saveRecordingsCache("/watch", [sample]);
    expect(loadRecordingsCache("/watch")).toEqual([sample]);
  });

  it("invalidates cache when watch dir changes", () => {
    saveRecordingsCache("/watch-a", [sample]);
    expect(loadRecordingsCache("/watch-b")).toBeNull();
  });
});
