import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../types";
import { SettingsView } from "../views/SettingsView";

const openMock = vi.fn();
const checkWatchDirMock = vi.fn();
const resolvedToolPathsMock = vi.fn();
const getPlaybackCacheLimitsMock = vi.fn();
const getPlaybackCacheStatsMock = vi.fn();
const clearPlaybackCacheMock = vi.fn();
const clearAllCacheMock = vi.fn();
const nvencAvailableMock = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openMock(...args),
}));

vi.mock("../lib/api", () => ({
  checkWatchDir: (...args: unknown[]) => checkWatchDirMock(...args),
  resolvedToolPaths: (...args: unknown[]) => resolvedToolPathsMock(...args),
  getPlaybackCacheLimits: (...args: unknown[]) =>
    getPlaybackCacheLimitsMock(...args),
  getPlaybackCacheStats: (...args: unknown[]) =>
    getPlaybackCacheStatsMock(...args),
  clearPlaybackCache: (...args: unknown[]) => clearPlaybackCacheMock(...args),
  clearAllCache: (...args: unknown[]) => clearAllCacheMock(...args),
  nvencAvailable: (...args: unknown[]) => nvencAvailableMock(...args),
}));

const baseSettings: Settings = {
  watchDir: "/recordings",
  ffmpegPath: "",
  ffprobePath: "",
  compressCrf: 26,
  preferNvenc: true,
  launchOnStartup: false,
  playbackCacheMaxGb: 5,
  previewCrf: 28,
  previewScale: 2,
};

const baseLimits = {
  minGb: 1,
  maxGb: 10,
  defaultGb: 5,
  freeGb: 50,
  enabled: true,
};

describe("SettingsView watch folder access", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    openMock.mockReset();
    checkWatchDirMock.mockReset();
    getPlaybackCacheLimitsMock.mockReset();
    getPlaybackCacheStatsMock.mockReset();
    clearPlaybackCacheMock.mockReset();
    clearAllCacheMock.mockReset();
    nvencAvailableMock.mockReset();
    resolvedToolPathsMock.mockResolvedValue(["", ""]);
    nvencAvailableMock.mockResolvedValue(true);
    getPlaybackCacheLimitsMock.mockResolvedValue(baseLimits);
    getPlaybackCacheStatsMock.mockResolvedValue({
      usedBytes: 2 * 1024 * 1024 * 1024,
      maxGb: 5,
    });
    clearPlaybackCacheMock.mockResolvedValue({ freedBytes: 1024 });
    clearAllCacheMock.mockResolvedValue({ freedBytes: 2048 });
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

  it("shows cache usage and slider", async () => {
    render(
      <SettingsView
        settings={baseSettings}
        tools={{ ffmpeg: true, ffprobe: true }}
        onSave={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("2 GB / 5 GB")).toBeTruthy();
      expect(screen.getByLabelText(/Maximum cache size/i)).toBeTruthy();
    });
  });

  it("blocks save when preview cache limit exceeds dynamic max", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    checkWatchDirMock.mockResolvedValue(undefined);
    getPlaybackCacheLimitsMock.mockResolvedValue({
      ...baseLimits,
      maxGb: 3,
    });

    render(
      <SettingsView
        settings={{ ...baseSettings, playbackCacheMaxGb: 5 }}
        tools={{ ffmpeg: true, ffprobe: true }}
        onSave={onSave}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText(/Maximum cache size/i)).toBeTruthy();
    });

    await user.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        ...baseSettings,
        playbackCacheMaxGb: 3,
      });
    });
  });

  it("shows disabled cache message when limits are disabled", async () => {
    getPlaybackCacheLimitsMock.mockResolvedValue({
      minGb: 0,
      maxGb: 0,
      defaultGb: 5,
      freeGb: 1,
      enabled: false,
    });

    render(
      <SettingsView
        settings={baseSettings}
        tools={{ ffmpeg: true, ffprobe: true }}
        onSave={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByText(/Preview cache unavailable/i),
      ).toBeTruthy();
      expect((screen.getByLabelText(/Maximum cache size/i) as HTMLInputElement).disabled).toBe(
        true,
      );
    });
  });

  it("clears video cache after confirmation", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(
      <SettingsView
        settings={baseSettings}
        tools={{ ffmpeg: true, ffprobe: true }}
        onSave={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("2 GB / 5 GB")).toBeTruthy();
    });

    await user.click(
      screen.getByRole("button", { name: "Clear video cache" }),
    );

    await waitFor(() => {
      expect(clearPlaybackCacheMock).toHaveBeenCalled();
      expect(screen.getByText("Video cache cleared.")).toBeTruthy();
    });
  });

  it("does not clear video cache when confirmation is cancelled", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(false);

    render(
      <SettingsView
        settings={baseSettings}
        tools={{ ffmpeg: true, ffprobe: true }}
        onSave={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("2 GB / 5 GB")).toBeTruthy();
    });

    await user.click(
      screen.getByRole("button", { name: "Clear video cache" }),
    );

    expect(clearPlaybackCacheMock).not.toHaveBeenCalled();
  });

  it("shows preview settings and nvenc status", async () => {
    render(
      <SettingsView
        settings={baseSettings}
        tools={{ ffmpeg: true, ffprobe: true }}
        onSave={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText(/Preview quality/i)).toBeTruthy();
      expect(screen.getByLabelText(/Preview resolution/i)).toBeTruthy();
      expect(
        screen.getByText(/NVENC available \(used automatically for preview\)/i),
      ).toBeTruthy();
    });
  });

  it("saves preview settings with other fields", async () => {
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

    await waitFor(() => {
      expect(screen.getByLabelText(/Preview quality/i)).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText(/Preview quality/i), {
      target: { value: "30" },
    });
    fireEvent.change(screen.getByLabelText(/Preview resolution/i), {
      target: { value: "4" },
    });
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        ...baseSettings,
        previewCrf: 30,
        previewScale: 4,
      });
    });
  });
});
