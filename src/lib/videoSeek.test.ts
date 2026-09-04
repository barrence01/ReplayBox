import { describe, expect, it, vi } from "vitest";
import {
  applyScrubSeek,
  clampToSeekableSec,
  isSeekAtTargetSec,
} from "./videoSeek";

function mockSeekable(ranges: Array<[number, number]>) {
  return {
    length: ranges.length,
    start: (i: number) => ranges[i][0],
    end: (i: number) => ranges[i][1],
  };
}

describe("clampToSeekableSec", () => {
  it("returns target when inside a range", () => {
    const seekable = mockSeekable([[0, 100]]);
    expect(clampToSeekableSec(seekable, 45)).toBe(45);
  });

  it("returns range start when target is before it", () => {
    const seekable = mockSeekable([[10, 100]]);
    expect(clampToSeekableSec(seekable, 5)).toBe(10);
  });

  it("returns last range end when target is past all ranges", () => {
    const seekable = mockSeekable([[0, 50], [60, 90]]);
    expect(clampToSeekableSec(seekable, 95)).toBe(90);
  });

  it("returns target when seekable is empty", () => {
    const seekable = mockSeekable([]);
    expect(clampToSeekableSec(seekable, 12)).toBe(12);
  });
});

describe("isSeekAtTargetSec", () => {
  it("accepts within default tolerance", () => {
    expect(isSeekAtTargetSec(0.35, 0.5)).toBe(true);
    expect(isSeekAtTargetSec(3.5, 5.0)).toBe(true);
  });

  it("rejects when outside tolerance", () => {
    expect(isSeekAtTargetSec(0.2, 2.0)).toBe(false);
  });
});

describe("applyScrubSeek", () => {
  it("uses fastSeek when available", () => {
    const fastSeek = vi.fn();
    const video = {
      fastSeek,
      currentTime: 0,
    } as unknown as HTMLVideoElement;

    applyScrubSeek(video, 12.5);
    expect(fastSeek).toHaveBeenCalledWith(12.5);
  });

  it("falls back to currentTime when fastSeek is unavailable", () => {
    const video = document.createElement("video");
    applyScrubSeek(video, 3.25);
    expect(video.currentTime).toBe(3.25);
  });
});
