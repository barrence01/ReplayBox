import { describe, expect, it } from "vitest";
import { isPlayInterruptedError } from "./videoPlayback";

describe("isPlayInterruptedError", () => {
  it("returns true for AbortError", () => {
    expect(isPlayInterruptedError(new DOMException("aborted", "AbortError"))).toBe(
      true,
    );
  });

  it("returns false for other errors", () => {
    expect(
      isPlayInterruptedError(new DOMException("not allowed", "NotAllowedError")),
    ).toBe(false);
    expect(isPlayInterruptedError(new Error("fail"))).toBe(false);
  });
});
