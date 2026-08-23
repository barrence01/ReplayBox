import { describe, expect, it } from "vitest";
import { HOME_VIEW, trayPurgePatch } from "./trayUiState";

describe("trayUiState", () => {
  it("HOME_VIEW is session", () => {
    expect(HOME_VIEW).toBe("session");
  });

  it("trayPurgePatch clears catalog and jobs", () => {
    expect(trayPurgePatch()).toEqual({
      libraryReady: false,
      recordings: [],
      editJobs: [],
      previewJobs: [],
    });
  });
});
