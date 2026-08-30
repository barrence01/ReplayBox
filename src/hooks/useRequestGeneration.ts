import { useCallback, useRef } from "react";

export function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

export function useRequestGeneration() {
  const genRef = useRef(0);

  const nextGeneration = useCallback(() => {
    genRef.current += 1;
    return genRef.current;
  }, []);

  const isCurrent = useCallback((generation: number) => {
    return genRef.current === generation;
  }, []);

  const invalidate = useCallback(() => {
    genRef.current += 1;
  }, []);

  return { nextGeneration, isCurrent, invalidate };
}
