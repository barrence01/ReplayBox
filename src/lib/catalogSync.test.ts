import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  createCatalogSync,
  MIN_SYNC_INTERVAL_MS,
  resolveScopeForView,
} from "./catalogSync";
import type { Recording } from "../types";

vi.mock("./api", () => ({
  listRecordings: vi.fn(),
  syncCatalogDelta: vi.fn(),
}));

import { listRecordings, syncCatalogDelta } from "./api";

const sampleRecording: Recording = {
  id: "r1",
  path: "/watch/clip.mp4",
  filename: "clip.mp4",
  dir: "/watch",
  sizeBytes: 100,
  durationMs: 1000,
  width: 1920,
  height: 1080,
  videoCodec: "h264",
  audioCodec: "aac",
  isVfr: false,
  createdAt: null,
  modifiedAt: "2024-01-02T00:00:00Z",
  thumbnailPath: null,
  sessionId: null,
  indexedAt: "2024-01-03T00:00:00Z",
};

describe("resolveScopeForView", () => {
  it("maps session to last24h", () => {
    expect(resolveScopeForView("session")).toEqual({ kind: "last24h" });
  });

  it("maps library to full", () => {
    expect(resolveScopeForView("library")).toEqual({ kind: "full" });
  });
});

describe("createCatalogSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listRecordings).mockResolvedValue([sampleRecording]);
    vi.mocked(syncCatalogDelta).mockResolvedValue(undefined);
  });

  it("runs list and delta sync on immediate request", async () => {
    const onRecordings = vi.fn();
    const onListSyncing = vi.fn();
    const sync = createCatalogSync({
      onRecordings,
      onListSyncing,
      isScanBusy: () => false,
    });

    await sync.sync({ scope: { kind: "last24h" }, immediate: true });

    expect(listRecordings).toHaveBeenCalledTimes(1);
    expect(syncCatalogDelta).toHaveBeenCalledWith({ kind: "last24h" });
    expect(onRecordings).toHaveBeenCalledWith([sampleRecording]);
  });

  it("coalesces concurrent sync requests", async () => {
    let resolveList: (value: Recording[]) => void = () => {};
    vi.mocked(listRecordings).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveList = resolve;
        }),
    );

    const sync = createCatalogSync({
      onRecordings: vi.fn(),
      onListSyncing: vi.fn(),
      isScanBusy: () => false,
    });

    const first = sync.sync({ scope: { kind: "full" }, immediate: true });
    const second = sync.sync({ scope: { kind: "full" }, immediate: true });
    resolveList([sampleRecording]);
    await Promise.all([first, second]);

    expect(listRecordings).toHaveBeenCalledTimes(1);
    expect(syncCatalogDelta).toHaveBeenCalledTimes(1);
  });

  it("skips delta when scan is busy", async () => {
    const sync = createCatalogSync({
      onRecordings: vi.fn(),
      onListSyncing: vi.fn(),
      isScanBusy: () => true,
    });

    await sync.sync({ scope: { kind: "full" }, immediate: true });

    expect(listRecordings).toHaveBeenCalledTimes(1);
    expect(syncCatalogDelta).not.toHaveBeenCalled();
  });

  it("throttles non-immediate delta sync within interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-01T12:00:00Z"));

    const sync = createCatalogSync({
      onRecordings: vi.fn(),
      onListSyncing: vi.fn(),
      isScanBusy: () => false,
    });

    await sync.sync({ scope: { kind: "full" }, immediate: true });
    expect(syncCatalogDelta).toHaveBeenCalledTimes(1);

    vi.setSystemTime(
      new Date(Date.now() + MIN_SYNC_INTERVAL_MS - 1_000),
    );
    await sync.sync({ scope: { kind: "full" }, immediate: false });
    expect(syncCatalogDelta).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});
