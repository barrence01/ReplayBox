import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Timeline } from "./Timeline";

function renderTimeline(overrides: Partial<Parameters<typeof Timeline>[0]> = {}) {
  const onStartChange = vi.fn();
  const onEndChange = vi.fn();
  const onStartCommit = vi.fn();
  const onEndCommit = vi.fn();
  const onSeekClick = vi.fn();
  const onScrubStart = vi.fn();
  const onScrub = vi.fn();
  const onScrubEnd = vi.fn();

  const props = {
    durationMs: 10_000,
    startMs: 1000,
    endMs: 9000,
    currentMs: 5000,
    onStartChange,
    onEndChange,
    onStartCommit,
    onEndCommit,
    onSeekClick,
    onScrubStart,
    onScrub,
    onScrubEnd,
    ...overrides,
  };

  const view = render(<Timeline {...props} />);
  const track = view.container.querySelector(".timeline__track") as HTMLDivElement;
  const sliderLabels = view.container.querySelectorAll(".timeline__sliders label");
  const startSlider = sliderLabels[0]?.querySelector(
    'input[type="range"]',
  ) as HTMLInputElement;
  const endSlider = sliderLabels[1]?.querySelector(
    'input[type="range"]',
  ) as HTMLInputElement;

  Object.defineProperty(track, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      left: 0,
      top: 0,
      width: 1000,
      height: 28,
      right: 1000,
      bottom: 28,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
  track.setPointerCapture = vi.fn();
  track.releasePointerCapture = vi.fn();
  track.hasPointerCapture = vi.fn().mockReturnValue(true);

  return {
    ...view,
    track,
    startSlider,
    endSlider,
    onStartChange,
    onEndChange,
    onStartCommit,
    onEndCommit,
    onSeekClick,
    onScrubStart,
    onScrub,
    onScrubEnd,
  };
}

describe("Timeline", () => {
  it("seeks on quick click without starting scrub", () => {
    const { track, onSeekClick, onScrubStart, onScrubEnd } = renderTimeline();

    fireEvent.pointerDown(track, { clientX: 500, button: 0, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 500, pointerId: 1 });

    expect(onSeekClick).toHaveBeenCalledWith(5000);
    expect(onScrubStart).not.toHaveBeenCalled();
    expect(onScrubEnd).not.toHaveBeenCalled();
  });

  it("runs scrub cycle when pointer moves beyond threshold", () => {
    const { track, onSeekClick, onScrubStart, onScrub, onScrubEnd } =
      renderTimeline();

    fireEvent.pointerDown(track, { clientX: 200, button: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 800, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 800, pointerId: 1 });

    expect(onScrubStart).toHaveBeenCalledTimes(1);
    expect(onScrub).toHaveBeenCalled();
    expect(onScrubEnd).toHaveBeenCalledWith(8000);
    expect(onSeekClick).not.toHaveBeenCalled();
  });

  it("does not start scrub for small pointer movement", () => {
    const { track, onScrubStart, onSeekClick } = renderTimeline();

    fireEvent.pointerDown(track, { clientX: 500, button: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 502, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 502, pointerId: 1 });

    expect(onScrubStart).not.toHaveBeenCalled();
    expect(onSeekClick).toHaveBeenCalledWith(5020);
  });

  it("ends scrub on pointercancel", () => {
    const { track, onScrubEnd } = renderTimeline();

    fireEvent.pointerDown(track, { clientX: 300, button: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 600, pointerId: 1 });
    fireEvent.pointerCancel(track, { clientX: 600, pointerId: 1 });

    expect(onScrubEnd).toHaveBeenCalledWith(6000);
  });

  it("clamps scrub ms to trim range", () => {
    const { track, onScrub } = renderTimeline();

    fireEvent.pointerDown(track, { clientX: 50, button: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 60, pointerId: 1 });
    expect(onScrub).toHaveBeenCalledWith(1000);

    onScrub.mockClear();
    fireEvent.pointerMove(track, { clientX: 990, pointerId: 1 });
    expect(onScrub).toHaveBeenCalledWith(9000);
  });

  it("ignores pointerdown when disabled", () => {
    const { track, onSeekClick, onScrubStart } = renderTimeline({
      disabled: true,
    });

    fireEvent.pointerDown(track, { clientX: 500, button: 0, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 500, pointerId: 1 });

    expect(onSeekClick).not.toHaveBeenCalled();
    expect(onScrubStart).not.toHaveBeenCalled();
  });

  it("ignores non-primary button", () => {
    const { track, onSeekClick } = renderTimeline();

    fireEvent.pointerDown(track, { clientX: 500, button: 2, pointerId: 1 });

    expect(onSeekClick).not.toHaveBeenCalled();
  });

  it("calls onStartChange on drag without commit", () => {
    const { startSlider, onStartChange, onStartCommit } = renderTimeline();

    fireEvent.change(startSlider, { target: { value: "3000" } });

    expect(onStartChange).toHaveBeenCalledWith(3000);
    expect(onStartCommit).not.toHaveBeenCalled();
  });

  it("calls onStartCommit on pointer up", () => {
    const { startSlider, onStartCommit } = renderTimeline();

    startSlider.value = "3000";
    fireEvent.change(startSlider, { target: { value: "3000" } });
    fireEvent.pointerUp(startSlider);

    expect(onStartCommit).toHaveBeenCalledWith(3000);
  });

  it("calls onEndChange on drag without commit", () => {
    const { endSlider, onEndChange, onEndCommit } = renderTimeline();

    fireEvent.change(endSlider, { target: { value: "7000" } });

    expect(onEndChange).toHaveBeenCalledWith(7000);
    expect(onEndCommit).not.toHaveBeenCalled();
  });

  it("calls onEndCommit on pointer up", () => {
    const { endSlider, onEndCommit } = renderTimeline();

    endSlider.value = "7000";
    fireEvent.pointerUp(endSlider);

    expect(onEndCommit).toHaveBeenCalledWith(7000);
  });

  it("toggles scrubbing class while dragging", () => {
    const { track } = renderTimeline();

    fireEvent.pointerDown(track, { clientX: 200, button: 0, pointerId: 1 });
    expect(track.classList.contains("timeline__track--scrubbing")).toBe(false);

    fireEvent.pointerMove(track, { clientX: 800, pointerId: 1 });
    expect(track.classList.contains("timeline__track--scrubbing")).toBe(true);

    fireEvent.pointerUp(track, { clientX: 800, pointerId: 1 });
    expect(track.classList.contains("timeline__track--scrubbing")).toBe(false);
  });

  it("disables trim ranges when locked", () => {
    const { startSlider, endSlider, track } = renderTimeline({
      disabled: true,
    });

    expect(startSlider.disabled).toBe(true);
    expect(endSlider.disabled).toBe(true);
    expect(track.classList.contains("timeline__track--locked")).toBe(true);
  });

  it("calls onStartCommit on key up", () => {
    const { startSlider, onStartCommit } = renderTimeline();

    startSlider.value = "3000";
    fireEvent.keyUp(startSlider);

    expect(onStartCommit).toHaveBeenCalledWith(3000);
  });

  it("calls onEndCommit on key up", () => {
    const { endSlider, onEndCommit } = renderTimeline();

    endSlider.value = "7000";
    fireEvent.keyUp(endSlider);

    expect(onEndCommit).toHaveBeenCalledWith(7000);
  });

  it("captures and releases pointer on scrub", () => {
    const { track } = renderTimeline();

    fireEvent.pointerDown(track, { clientX: 200, button: 0, pointerId: 7 });
    expect(track.setPointerCapture).toHaveBeenCalledWith(7);

    fireEvent.pointerUp(track, { clientX: 200, pointerId: 7 });
    expect(track.releasePointerCapture).toHaveBeenCalledWith(7);
  });
});
