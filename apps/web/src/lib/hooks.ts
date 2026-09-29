import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

/** Re-render after mutating engine state held in a ref. */
export function useForceRender(): () => void {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  return bump;
}

/** setInterval that always calls the latest callback; `delay: null` pauses it. */
export function useInterval(callback: () => void, delay: number | null) {
  const saved = useRef(callback);
  useEffect(() => {
    saved.current = callback;
  }, [callback]);
  useEffect(() => {
    if (delay === null) return;
    const id = window.setInterval(() => saved.current(), delay);
    return () => window.clearInterval(id);
  }, [delay]);
}

/** setTimeout helper that clears pending timers on unmount. */
export function useTimeouts() {
  const ids = useRef<number[]>([]);
  useEffect(() => () => ids.current.forEach((id) => window.clearTimeout(id)), []);
  return useCallback((fn: () => void, ms: number) => {
    ids.current.push(window.setTimeout(fn, ms));
  }, []);
}

export const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/**
 * Holds a mutable engine model (LevelRun, SpinState, RoomState, …) in React state.
 *
 * Engine models are plain mutable objects — the same code runs on the room server — so the UI
 * mutates them through engine functions inside event handlers/effects and then calls `commit()`
 * to re-render. `replace()` swaps in a new model (new round). Never mutate during render.
 */
export function useModel<T>(init: () => T): { model: T; commit(): void; replace(next: T): void } {
  const [holder, setHolder] = useState(() => ({ model: init(), version: 0 }));
  const commit = useCallback(() => setHolder((h) => ({ model: h.model, version: h.version + 1 })), []);
  const replace = useCallback((next: T) => setHolder((h) => ({ model: next, version: h.version + 1 })), []);
  return { model: holder.model, commit, replace };
}

/** Current time, refreshed every `intervalMs` (keeps render pure). */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Monotonic clock for event handlers (reaction times). */
export const clock = (): number => performance.now();
