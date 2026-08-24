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

    fireEvent.pointerDown(track, { clientX: 400, button: 0, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 400, pointerId: 1 });

    expect(onSeekClick).toHaveBeenCalledWith(4000);
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

    fireEvent.pointerDown(track, { clientX: 400, button: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 402, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 402, pointerId: 1 });

    expect(onScrubStart).not.toHaveBeenCalled();
    expect(onSeekClick).toHaveBeenCalledWith(4020);
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

    fireEvent.pointerDown(track, { clientX: 400, button: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 60, pointerId: 1 });
    expect(onScrub).toHaveBeenCalledWith(1000);

    onScrub.mockClear();
    fireEvent.pointerMove(track, { clientX: 990, pointerId: 1 });
    expect(onScrub).toHaveBeenCalledWith(9000);
  });

  it("ignores pointerdown when disabled", () => {
    const { track, onSeekClick, onScrubStart, onStartChange } = renderTimeline({
      disabled: true,
    });

    fireEvent.pointerDown(track, { clientX: 400, button: 0, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 400, pointerId: 1 });
    fireEvent.pointerDown(track, { clientX: 100, button: 0, pointerId: 2 });
    fireEvent.pointerMove(track, { clientX: 300, pointerId: 2 });

    expect(onSeekClick).not.toHaveBeenCalled();
    expect(onScrubStart).not.toHaveBeenCalled();
    expect(onStartChange).not.toHaveBeenCalled();
  });

  it("ignores non-primary button", () => {
    const { track, onSeekClick } = renderTimeline();

    fireEvent.pointerDown(track, { clientX: 400, button: 2, pointerId: 1 });

    expect(onSeekClick).not.toHaveBeenCalled();
  });

  it("drags start handle without seeking playhead", () => {
    const { track, onStartChange, onStartCommit, onSeekClick, onScrubStart } =
      renderTimeline();

    fireEvent.pointerDown(track, { clientX: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 300, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 300, pointerId: 1 });

    expect(onStartChange).toHaveBeenCalledWith(3000);
    expect(onStartCommit).toHaveBeenCalledWith(3000);
    expect(onSeekClick).not.toHaveBeenCalled();
    expect(onScrubStart).not.toHaveBeenCalled();
  });

  it("drags end handle without seeking playhead", () => {
    const { track, onEndChange, onEndCommit, onSeekClick } = renderTimeline();

    fireEvent.pointerDown(track, { clientX: 900, button: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 700, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 700, pointerId: 1 });

    expect(onEndChange).toHaveBeenCalledWith(7000);
    expect(onEndCommit).toHaveBeenCalledWith(7000);
    expect(onSeekClick).not.toHaveBeenCalled();
  });

  it("renders playhead and trim handles without range sliders", () => {
    const { container } = renderTimeline();

    expect(container.querySelector(".timeline__playhead")).toBeTruthy();
    expect(container.querySelector(".timeline__handle--start")).toBeTruthy();
    expect(container.querySelector(".timeline__handle--end")).toBeTruthy();
    expect(container.querySelector('input[type="range"]')).toBeNull();
  });

  it("sets grab cursor class when hovering playhead", () => {
    const { track } = renderTimeline();

    fireEvent.pointerMove(track, { clientX: 500, pointerId: 1 });
    expect(track.classList.contains("timeline__track--over-playhead")).toBe(true);
    expect(track.classList.contains("timeline__track--over-handle")).toBe(false);
  });

  it("sets resize cursor class when hovering trim handles", () => {
    const { track } = renderTimeline();

    fireEvent.pointerMove(track, { clientX: 100, pointerId: 1 });
    expect(track.classList.contains("timeline__track--over-handle")).toBe(true);

    fireEvent.pointerMove(track, { clientX: 900, pointerId: 1 });
    expect(track.classList.contains("timeline__track--over-handle")).toBe(true);
    expect(track.classList.contains("timeline__track--over-playhead")).toBe(false);
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

  it("marks track locked when disabled", () => {
    const { track } = renderTimeline({
      disabled: true,
    });

    expect(track.classList.contains("timeline__track--locked")).toBe(true);
  });

  it("captures and releases pointer on scrub", () => {
    const { track } = renderTimeline();

    fireEvent.pointerDown(track, { clientX: 200, button: 0, pointerId: 7 });
    expect(track.setPointerCapture).toHaveBeenCalledWith(7);

    fireEvent.pointerUp(track, { clientX: 200, pointerId: 7 });
    expect(track.releasePointerCapture).toHaveBeenCalledWith(7);
  });
});
