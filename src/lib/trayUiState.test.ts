import { describe, expect, it } from "vitest";
import { HOME_VIEW, trayPurgePatch } from "./trayUiState";

describe("trayUiState", () => {
  it("HOME_VIEW is session", () => {
    expect(HOME_VIEW).toBe("session");
  });

  it("trayPurgePatch clears jobs only", () => {
    expect(trayPurgePatch()).toEqual({
      editJobs: [],
      previewJobs: [],
    });
  });
});
