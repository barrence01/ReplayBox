import { describe, expect, it } from "vitest";
import { clampToSeekableSec, isSeekAtTargetSec } from "./videoSeek";

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
    expect(isSeekAtTargetSec(0.48, 0.5)).toBe(true);
  });

  it("rejects when outside tolerance", () => {
    expect(isSeekAtTargetSec(1, 5)).toBe(false);
  });
});
