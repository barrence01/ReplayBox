import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../types";
import { SettingsView } from "../views/SettingsView";

const openMock = vi.fn();
const openPathMock = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openMock(...args),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: (...args: unknown[]) => openPathMock(...args),
}));
const checkWatchDirMock = vi.fn();
const resolvedToolPathsMock = vi.fn();
const getLogDirMock = vi.fn();
const getPlaybackCacheLimitsMock = vi.fn();
const getPlaybackCacheStatsMock = vi.fn();
const clearPlaybackCacheMock = vi.fn();
const clearAllCacheMock = vi.fn();
const hardwareEncodingStatusMock = vi.fn();

vi.mock("../lib/api", () => ({
  checkWatchDir: (...args: unknown[]) => checkWatchDirMock(...args),
  resolvedToolPaths: (...args: unknown[]) => resolvedToolPathsMock(...args),
  getLogDir: (...args: unknown[]) => getLogDirMock(...args),
  getPlaybackCacheLimits: (...args: unknown[]) =>
    getPlaybackCacheLimitsMock(...args),
  getPlaybackCacheStats: (...args: unknown[]) =>
    getPlaybackCacheStatsMock(...args),
  clearPlaybackCache: (...args: unknown[]) => clearPlaybackCacheMock(...args),
  clearAllCache: (...args: unknown[]) => clearAllCacheMock(...args),
  nvencAvailable: vi.fn(),
  hardwareEncodingStatus: (...args: unknown[]) =>
    hardwareEncodingStatusMock(...args),
}));

const baseHwStatus = {
  active: "nvenc" as const,
  nvencCompiled: true,
  nvencRuntime: true,
  vaapiCompiled: true,
  vaapiRuntime: false,
  vaapiDevice: null,
};

const baseSettings: Settings = {
  watchDir: "/recordings",
  ffmpegPath: "",
  ffprobePath: "",
  compressCrf: 26,
  preferHardwareEncoding: true,
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
    openPathMock.mockReset();
    checkWatchDirMock.mockReset();
    getLogDirMock.mockReset();
    getPlaybackCacheLimitsMock.mockReset();
    getPlaybackCacheStatsMock.mockReset();
    clearPlaybackCacheMock.mockReset();
    clearAllCacheMock.mockReset();
    hardwareEncodingStatusMock.mockReset();
    resolvedToolPathsMock.mockResolvedValue(["", ""]);
    getLogDirMock.mockResolvedValue("/home/user/.local/share/org.replaybox/logs");
    openPathMock.mockResolvedValue(undefined);
    hardwareEncodingStatusMock.mockResolvedValue(baseHwStatus);
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

  it("shows encoder status in encoding section", async () => {
    render(
      <SettingsView
        settings={baseSettings}
        tools={{ ffmpeg: true, ffprobe: true }}
        onSave={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Encoder:/i)).toBeTruthy();
      expect(screen.getByText("NVENC")).toBeTruthy();
    });
    expect(screen.queryByText(/Active encoder/i)).toBeNull();
    expect(screen.queryByText(/compiled/i)).toBeNull();
  });

  it("shows VAAPI when NVENC is unavailable", async () => {
    hardwareEncodingStatusMock.mockResolvedValue({
      ...baseHwStatus,
      active: "vaapi",
      nvencRuntime: false,
      vaapiRuntime: true,
    });

    render(
      <SettingsView
        settings={baseSettings}
        tools={{ ffmpeg: true, ffprobe: true }}
        onSave={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("VAAPI")).toBeTruthy();
    });
  });

  it("shows Software when hardware encoding is disabled", async () => {
    const user = userEvent.setup();

    render(
      <SettingsView
        settings={baseSettings}
        tools={{ ffmpeg: true, ffprobe: true }}
        onSave={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("NVENC")).toBeTruthy();
    });

    await user.click(
      screen.getByRole("checkbox", {
        name: /Prefer hardware encoding when available/i,
      }),
    );

    await waitFor(() => {
      expect(screen.getByText("Software")).toBeTruthy();
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

  it("does not update cache stats after unmount", async () => {
    let resolveStats: ((value: unknown) => void) | undefined;
    getPlaybackCacheStatsMock.mockReturnValue(
      new Promise((resolve) => {
        resolveStats = resolve;
      }),
    );

    const { unmount } = render(
      <SettingsView
        settings={baseSettings}
        tools={{ ffmpeg: true, ffprobe: true }}
        onSave={async () => undefined}
      />,
    );

    unmount();
    resolveStats?.({
      usedBytes: 99,
      maxGb: 5,
    });

    await waitFor(() => {
      expect(getPlaybackCacheLimitsMock).toHaveBeenCalled();
    });
  });

  it("opens logs folder when Open logs folder is clicked", async () => {
    const user = userEvent.setup();

    render(
      <SettingsView
        settings={baseSettings}
        tools={{ ffmpeg: true, ffprobe: true }}
        onSave={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByText(/Logs: \/home\/user\/\.local\/share\/org\.replaybox\/logs/),
      ).toBeTruthy();
    });

    await user.click(screen.getByRole("button", { name: "Open logs folder" }));

    await waitFor(() => {
      expect(openPathMock).toHaveBeenCalledWith(
        "/home/user/.local/share/org.replaybox/logs",
      );
    });
  });
});
