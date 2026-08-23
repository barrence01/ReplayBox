import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AboutView } from "./AboutView";

describe("AboutView", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows MIT license and bundled FFmpeg GPL notice", () => {
    render(<AboutView />);

    expect(screen.getByRole("heading", { name: "About", level: 1 })).toBeTruthy();
    expect(screen.getByText(/MIT License/)).toBeTruthy();
    expect(screen.getByText(/GPL-2\.0/)).toBeTruthy();
    expect(screen.getByText(/libx264/)).toBeTruthy();
    expect(screen.getByText(/THIRD_PARTY\.md/)).toBeTruthy();
  });
});
