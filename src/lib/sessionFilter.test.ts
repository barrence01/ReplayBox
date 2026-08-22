import { describe, expect, it } from "vitest";
import {
  isWithinLast24Hours,
  recordingActivityAt,
} from "./sessionFilter";

const NOW = Date.parse("2026-08-22T15:00:00.000Z");
const HOUR = 60 * 60 * 1000;

describe("recordingActivityAt", () => {
  it("prefers modifiedAt over createdAt and indexedAt", () => {
    expect(
      recordingActivityAt({
        modifiedAt: "2026-08-22T12:00:00.000Z",
        createdAt: "2026-08-21T12:00:00.000Z",
        indexedAt: "2026-08-20T12:00:00.000Z",
      }),
    ).toBe("2026-08-22T12:00:00.000Z");
  });

  it("falls back to createdAt when modifiedAt is null", () => {
    expect(
      recordingActivityAt({
        modifiedAt: null,
        createdAt: "2026-08-21T12:00:00.000Z",
        indexedAt: "2026-08-20T12:00:00.000Z",
      }),
    ).toBe("2026-08-21T12:00:00.000Z");
  });

  it("falls back to indexedAt when modifiedAt and createdAt are null", () => {
    expect(
      recordingActivityAt({
        modifiedAt: null,
        createdAt: null,
        indexedAt: "2026-08-20T12:00:00.000Z",
      }),
    ).toBe("2026-08-20T12:00:00.000Z");
  });
});

describe("isWithinLast24Hours", () => {
  it("returns true for a timestamp one hour ago", () => {
    const iso = new Date(NOW - HOUR).toISOString();
    expect(isWithinLast24Hours(iso, NOW)).toBe(true);
  });

  it("returns false for a timestamp 25 hours ago", () => {
    const iso = new Date(NOW - 25 * HOUR).toISOString();
    expect(isWithinLast24Hours(iso, NOW)).toBe(false);
  });

  it("returns true at the exact 24-hour boundary", () => {
    const iso = new Date(NOW - 24 * HOUR).toISOString();
    expect(isWithinLast24Hours(iso, NOW)).toBe(true);
  });

  it("returns false for a future timestamp", () => {
    const iso = new Date(NOW + HOUR).toISOString();
    expect(isWithinLast24Hours(iso, NOW)).toBe(false);
  });

  it("returns false for an invalid ISO string", () => {
    expect(isWithinLast24Hours("not-a-date", NOW)).toBe(false);
  });
});
