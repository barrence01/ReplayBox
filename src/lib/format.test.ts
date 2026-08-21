import { describe, expect, it } from "vitest";
import { formatBytes, formatTimestamp } from "./format";

describe("formatTimestamp", () => {
  it("formats zero", () => {
    expect(formatTimestamp(0)).toBe("00:00:00.000");
  });

  it("formats hours minutes seconds and millis", () => {
    expect(formatTimestamp(3_661_234)).toBe("01:01:01.234");
  });

  it("clamps negative values to zero", () => {
    expect(formatTimestamp(-50)).toBe("00:00:00.000");
  });
});

describe("formatBytes", () => {
  it("shows em dash for null", () => {
    expect(formatBytes(null)).toBe("—");
  });

  it("formats bytes without decimals", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("formats larger units with one decimal", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
  });
});
