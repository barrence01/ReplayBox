export type SortOrder = "newest" | "oldest";

type SortableRecording = {
  modifiedAt: string | null;
  indexedAt: string;
};

export function recordingSortKey(recording: SortableRecording): string {
  return recording.modifiedAt ?? recording.indexedAt;
}

export function sortRecordings<T extends SortableRecording>(
  recordings: T[],
  order: SortOrder,
): T[] {
  const sorted = [...recordings].sort((a, b) =>
    recordingSortKey(a).localeCompare(recordingSortKey(b)),
  );
  if (order === "newest") {
    sorted.reverse();
  }
  return sorted;
}

export function compareTimestamps(
  a: string | null | undefined,
  b: string | null | undefined,
  order: SortOrder,
): number {
  const left = a ?? "";
  const right = b ?? "";
  const cmp = left.localeCompare(right);
  return order === "newest" ? -cmp : cmp;
}
