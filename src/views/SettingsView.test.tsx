import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../types";
import { SettingsView } from "../views/SettingsView";

const openMock = vi.fn();
const checkWatchDirMock = vi.fn();
const resolvedToolPathsMock = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openMock(...args),
}));

vi.mock("../lib/api", () => ({
  checkWatchDir: (...args: unknown[]) => checkWatchDirMock(...args),
  resolvedToolPaths: (...args: unknown[]) => resolvedToolPathsMock(...args),
}));

const baseSettings: Settings = {
  watchDir: "/recordings",
  ffmpegPath: "",
  ffprobePath: "",
  compressCrf: 26,
  preferNvenc: true,
  launchOnStartup: false,
};

describe("SettingsView watch folder access", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    openMock.mockReset();
    checkWatchDirMock.mockReset();
    resolvedToolPathsMock.mockResolvedValue(["", ""]);
  });

  it("applies browsed path when checkWatchDir succeeds", async () => {
    const user = userEvent.setup();
    openMock.mockResolvedValue("/new/recordings");
    checkWatchDirMock.mockResolvedValue(undefined);

    render(
      <SettingsView
        settings={baseSettings}
        tools={{ ffmpeg: true, ffprobe: true }}
        onSave={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Browse…" }));

    await waitFor(() => {
      expect(
        (screen.getByDisplayValue("/new/recordings") as HTMLInputElement)
          .value,
      ).toBe("/new/recordings");
    });
    expect(checkWatchDirMock).toHaveBeenCalledWith("/new/recordings");
  });

  it("keeps previous path when browsed folder is inaccessible", async () => {
    const user = userEvent.setup();
    openMock.mockResolvedValue("/bad/path");
    checkWatchDirMock.mockRejectedValue(
      new Error("Watch folder does not exist: /bad/path"),
    );

    render(
      <SettingsView
        settings={baseSettings}
        tools={{ ffmpeg: true, ffprobe: true }}
        onSave={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Browse…" }));

    await waitFor(() => {
      expect(
        screen.getByText(/Watch folder does not exist/i),
      ).toBeTruthy();
    });
    expect(screen.getByDisplayValue("/recordings")).toBeTruthy();
  });

  it("blocks save when watch folder validation fails", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    checkWatchDirMock.mockRejectedValue(
      new Error("Watch folder is not accessible"),
    );

    render(
      <SettingsView
        settings={baseSettings}
        tools={{ ffmpeg: true, ffprobe: true }}
        onSave={onSave}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => {
      expect(screen.getByText(/Watch folder is not accessible/i)).toBeTruthy();
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("saves when watch folder is accessible", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    checkWatchDirMock.mockResolvedValue(undefined);

    render(
      <SettingsView
        settings={baseSettings}
        tools={{ ffmpeg: true, ffprobe: true }}
        onSave={onSave}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(baseSettings);
      expect(screen.getByText("Settings saved.")).toBeTruthy();
    });
  });
});
