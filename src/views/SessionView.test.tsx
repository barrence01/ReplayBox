import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionView } from "./SessionView";
import type { Recording } from "../types";

const recording: Recording = {
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
  modifiedAt: new Date().toISOString(),
  thumbnailPath: null,
  sessionId: null,
  indexedAt: new Date().toISOString(),
};

describe("SessionView", () => {
  it("shows updating status while catalog sync is active", () => {
    render(
      <SessionView
        allRecordings={[recording]}
        catalogSyncing
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByText("Updating…").textContent).toBe("Updating…");
  });
});
