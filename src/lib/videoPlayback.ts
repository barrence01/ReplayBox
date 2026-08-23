/** play() rejects with AbortError when pause/seek supersedes a pending play. */
export function isPlayInterruptedError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
