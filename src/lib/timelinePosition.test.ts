import { describe, expect, it } from "vitest";
import {
  clampPlayheadMs,
  effectiveDurationMs,
  hitTestHandle,
  msFromPointer,
  playheadMsFromPointer,
} from "./timelinePosition";

describe("effectiveDurationMs", () => {
  it("returns at least 1", () => {
    expect(effectiveDurationMs(0)).toBe(1);
    expect(effectiveDurationMs(-10)).toBe(1);
    expect(effectiveDurationMs(5000)).toBe(5000);
  });
});

describe("clampPlayheadMs", () => {
  it("clamps within trim range", () => {
    expect(clampPlayheadMs(500, 100, 900)).toBe(500);
    expect(clampPlayheadMs(50, 100, 900)).toBe(100);
    expect(clampPlayheadMs(950, 100, 900)).toBe(900);
  });

  it("handles minimal selection", () => {
    expect(clampPlayheadMs(500, 100, 101)).toBe(101);
  });
});

describe("msFromPointer", () => {
  it("maps pointer across full duration without trim clamp", () => {
    const rect = { left: 0, width: 1000 };
    expect(msFromPointer(50, rect, 10_000)).toBe(500);
    expect(msFromPointer(990, rect, 10_000)).toBe(9900);
  });
});

describe("playheadMsFromPointer", () => {
  it("maps mid-track pointer to ms and clamps to trim", () => {
    const rect = { left: 0, width: 1000 };
    expect(playheadMsFromPointer(500, rect, 10_000, 2000, 8000)).toBe(5000);
    expect(playheadMsFromPointer(50, rect, 10_000, 2000, 8000)).toBe(2000);
    expect(playheadMsFromPointer(990, rect, 10_000, 2000, 8000)).toBe(8000);
  });

  it("clamps pointer outside the track", () => {
    const rect = { left: 100, width: 200 };
    expect(playheadMsFromPointer(50, rect, 10_000, 0, 10_000)).toBe(0);
    expect(playheadMsFromPointer(400, rect, 10_000, 0, 10_000)).toBe(10_000);
  });

  it("handles invalid rect width", () => {
    expect(
      playheadMsFromPointer(150, { left: 0, width: 0 }, 10_000, 0, 10_000),
    ).toBe(0);
  });

  it("maps track edges to 0 and duration", () => {
    const rect = { left: 0, width: 1000 };
    expect(playheadMsFromPointer(0, rect, 10_000, 0, 10_000)).toBe(0);
    expect(playheadMsFromPointer(1000, rect, 10_000, 0, 10_000)).toBe(10_000);
  });
});

describe("hitTestHandle", () => {
  const rect = { left: 0, width: 1000 };

  it("hits start and end handles before playhead", () => {
    expect(hitTestHandle(100, rect, 10_000, 1000, 9000, 5000)).toBe("start");
    expect(hitTestHandle(900, rect, 10_000, 1000, 9000, 5000)).toBe("end");
  });

  it("hits playhead when not on a trim handle", () => {
    expect(hitTestHandle(500, rect, 10_000, 1000, 9000, 5000)).toBe("playhead");
  });

  it("returns track away from handles", () => {
    expect(hitTestHandle(400, rect, 10_000, 1000, 9000, 5000)).toBe("track");
  });

  it("prefers the closer trim handle when both are in range", () => {
    expect(hitTestHandle(52, rect, 10_000, 500, 550, 3000)).toBe("start");
    expect(hitTestHandle(54, rect, 10_000, 500, 550, 3000)).toBe("end");
  });
});
