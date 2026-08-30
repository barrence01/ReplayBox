import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTauriEvent } from "./useTauriEvent";

const listenMock = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

function Probe({
  event,
  onEvent,
}: {
  event: string;
  onEvent: () => void;
}) {
  useTauriEvent(event, onEvent);
  return null;
}

describe("useTauriEvent", () => {
  afterEach(() => {
    cleanup();
    listenMock.mockReset();
  });

  it("unlists immediately if the effect cleans up before listen resolves", async () => {
    let resolveListen: ((unlisten: () => void) => void) | undefined;
    const unlisten = vi.fn();
    listenMock.mockReturnValue(
      new Promise<() => void>((resolve) => {
        resolveListen = resolve;
      }),
    );

    const { unmount } = render(
      <Probe event="catalog-updated" onEvent={() => undefined} />,
    );
    unmount();
    resolveListen?.(unlisten);

    await Promise.resolve();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
