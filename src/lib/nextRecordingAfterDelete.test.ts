import { describe, expect, it } from "vitest";
import { pickNeighborRecording } from "./nextRecordingAfterDelete";

describe("pickNeighborRecording", () => {
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("returns the next item when deleting from the middle", () => {
    expect(pickNeighborRecording(list, "b")?.id).toBe("c");
  });

  it("returns the previous item when deleting the last", () => {
    expect(pickNeighborRecording(list, "c")?.id).toBe("b");
  });

  it("returns the next item when deleting the first", () => {
    expect(pickNeighborRecording(list, "a")?.id).toBe("b");
  });

  it("returns null when the deleted item was alone", () => {
    expect(pickNeighborRecording([{ id: "only" }], "only")).toBeNull();
  });

  it("returns null when the id is missing", () => {
    expect(pickNeighborRecording(list, "missing")).toBeNull();
  });
});
