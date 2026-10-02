import { useSyncExternalStore } from "react";

const COARSE = "(pointer: coarse)";

function subscribe(onChange: () => void): () => void {
  const m = matchMedia(COARSE);
  m.addEventListener("change", onChange);
  return () => m.removeEventListener("change", onChange);
}

/** A touch-first device (phone, tablet): the on-screen pad renders only there, so a desktop keeps its DOM. */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(subscribe, () => matchMedia(COARSE).matches, () => false);
}
