export function pickNeighborRecording<T extends { id: string }>(
  list: T[],
  deletedId: string,
): T | null {
  const index = list.findIndex((item) => item.id === deletedId);
  if (index < 0) return null;
  if (list[index + 1]) return list[index + 1];
  if (list[index - 1]) return list[index - 1];
  return null;
}
