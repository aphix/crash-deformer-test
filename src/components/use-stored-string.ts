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
 */
export function useStoredString(key: string, phone: string, wide: string): [string, (next: string) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => window.localStorage.getItem(key) ?? (window.matchMedia("(min-width: 768px)").matches ? wide : phone),
    () => "",
  );
  return [
    value,
    (next) => {
      window.localStorage.setItem(key, next);
      for (const listener of listeners) listener();
    },
  ];
}
