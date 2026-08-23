import { describe, expect, it } from "vitest";
import {
  compareTimestamps,
  recordingSortKey,
  sortRecordings,
} from "./sortRecordings";

describe("recordingSortKey", () => {
  it("prefers modifiedAt over indexedAt", () => {
    expect(
      recordingSortKey({
        modifiedAt: "2024-02-01T00:00:00Z",
        indexedAt: "2024-01-01T00:00:00Z",
      }),
    ).toBe("2024-02-01T00:00:00Z");
  });

  it("falls back to indexedAt when modifiedAt is null", () => {
    expect(
      recordingSortKey({
        modifiedAt: null,
        indexedAt: "2024-01-01T00:00:00Z",
      }),
    ).toBe("2024-01-01T00:00:00Z");
  });
});

describe("sortRecordings", () => {
  const recordings = [
    { id: "old", modifiedAt: "2024-01-01T00:00:00Z", indexedAt: "x" },
    { id: "new", modifiedAt: null, indexedAt: "2024-03-01T00:00:00Z" },
    { id: "mid", modifiedAt: "2024-02-01T00:00:00Z", indexedAt: "y" },
  ];

  it("sorts newest first", () => {
    expect(sortRecordings(recordings, "newest").map((r) => r.id)).toEqual([
      "new",
      "mid",
      "old",
    ]);
  });

  it("sorts oldest first", () => {
    expect(sortRecordings(recordings, "oldest").map((r) => r.id)).toEqual([
      "old",
      "mid",
      "new",
    ]);
  });

  it("does not mutate the input array", () => {
    const copy = [...recordings];
    sortRecordings(recordings, "newest");
    expect(recordings).toEqual(copy);
  });
});

describe("compareTimestamps", () => {
  it("orders newest descending", () => {
    expect(
      compareTimestamps("2024-01-01", "2024-02-01", "newest"),
    ).toBeGreaterThan(0);
  });

  it("orders oldest ascending", () => {
    expect(
      compareTimestamps("2024-01-01", "2024-02-01", "oldest"),
    ).toBeLessThan(0);
  });

  it("treats null as empty string", () => {
    expect(compareTimestamps(null, "2024-01-01", "oldest")).toBeLessThan(0);
  });
});
