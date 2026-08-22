import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Recording } from "../types";
import {
  FolderRecordingList,
  scrollChildIntoContainer,
} from "./FolderRecordingList";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}));

function recording(
  partial: Pick<Recording, "id" | "filename"> & Partial<Recording>,
): Recording {
  return {
    path: `/recordings/${partial.filename}`,
    dir: "/recordings",
    sizeBytes: 1024,
    durationMs: 10_000,
    width: 1920,
    height: 1080,
    videoCodec: "h264",
    audioCodec: "aac",
    isVfr: false,
    createdAt: null,
    modifiedAt: null,
    thumbnailPath: null,
    sessionId: null,
    indexedAt: "2024-01-01T00:00:00Z",
    ...partial,
  };
}

function rect(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    height: bottom - top,
    width: 100,
    left: 0,
    right: 100,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

describe("scrollChildIntoContainer", () => {
  it("increases scrollTop when the child is below the visible area", () => {
    const container = document.createElement("div");
    const child = document.createElement("button");
    container.scrollTop = 0;
    container.getBoundingClientRect = () => rect(0, 100);
    child.getBoundingClientRect = () => rect(200, 250);

    scrollChildIntoContainer(container, child);

    expect(container.scrollTop).toBe(150);
  });

  it("decreases scrollTop when the child is above the visible area", () => {
    const container = document.createElement("div");
    const child = document.createElement("button");
    container.scrollTop = 200;
    container.getBoundingClientRect = () => rect(0, 100);
    child.getBoundingClientRect = () => rect(-50, 0);

    scrollChildIntoContainer(container, child);

    expect(container.scrollTop).toBe(150);
  });

  it("does not change scrollTop when the child is already visible", () => {
    const container = document.createElement("div");
    const child = document.createElement("button");
    container.scrollTop = 40;
    container.getBoundingClientRect = () => rect(0, 100);
    child.getBoundingClientRect = () => rect(20, 60);

    scrollChildIntoContainer(container, child);

    expect(container.scrollTop).toBe(40);
  });
});

describe("FolderRecordingList", () => {
  afterEach(() => {
    cleanup();
  });

  it("does not call scrollIntoView (avoids scrolling page ancestors)", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    render(
      <FolderRecordingList
        recordings={[
          recording({ id: "a", filename: "a.mp4" }),
          recording({ id: "b", filename: "b.mp4" }),
          recording({ id: "c", filename: "c.mp4" }),
        ]}
        currentId="c"
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /c\.mp4/ })).toBeTruthy();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("adjusts list scrollTop when the active item is offscreen", () => {
    const recordings = [
      recording({ id: "a", filename: "a.mp4" }),
      recording({ id: "b", filename: "b.mp4" }),
      recording({ id: "c", filename: "c.mp4" }),
    ];

    const { container, rerender } = render(
      <FolderRecordingList
        recordings={recordings}
        currentId="a"
        onOpen={vi.fn()}
      />,
    );

    const list = container.querySelector(
      ".folder-recording-list",
    ) as HTMLElement;
    list.scrollTop = 0;

    rerender(
      <FolderRecordingList
        recordings={recordings}
        currentId="c"
        onOpen={vi.fn()}
      />,
    );

    const active = screen.getByRole("button", { name: /c\.mp4/ });
    list.getBoundingClientRect = () => rect(0, 100);
    active.getBoundingClientRect = () => rect(200, 250);

    // New recordings array retriggers the effect with mocked geometry
    rerender(
      <FolderRecordingList
        recordings={[...recordings]}
        currentId="c"
        onOpen={vi.fn()}
      />,
    );

    expect(list.scrollTop).toBe(150);
  });
});
