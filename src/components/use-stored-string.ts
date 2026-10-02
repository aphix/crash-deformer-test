import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * A HUD preference kept in localStorage. The server render (and hydration) sees ""; anything mounted
 * afterwards reads the stored value straight away, so a remembered open section never flashes shut.
 * Until the user picks, the value is `phone` below the md breakpoint and `wide` from it.
 * Blocked storage (site data off, sandboxed frames) or a full quota keeps the choice for this page instead.
 */
export function useStoredString(key: string, phone: string, wide: string): [string, (next: string) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => memory.get(key) ?? stored(key) ?? (window.matchMedia("(min-width: 768px)").matches ? wide : phone),
    () => "",
  );
  return [
    value,
    (next) => {
      memory.set(key, next);
      try {
        window.localStorage.setItem(key, next);
      } catch {
        /* storage unavailable: `memory` keeps it for this page */
      }
      for (const listener of listeners) listener();
    },
  ];
}

const memory = new Map<string, string>();

function stored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
