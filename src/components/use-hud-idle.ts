import { useEffect, useState } from "react";

/** Quiet time before the touch HUD mutes itself. */
const HUD_IDLE_MS = 5000;

/**
 * True once `armed` has held for `HUD_IDLE_MS` with no tap anywhere on the page (a tap on the view wakes the HUD too).
 * Touches on an element marked `data-keep-idle` (the thumb pad) don't count, so driving doesn't un-mute it.
 */
export function useHudIdle(armed: boolean): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    setIdle(false);
    if (!armed) return;
    let timer = setTimeout(() => setIdle(true), HUD_IDLE_MS);
    const wake = (e: PointerEvent) => {
      if ((e.target as Element).closest?.("[data-keep-idle]")) return;
      clearTimeout(timer);
      setIdle(false);
      timer = setTimeout(() => setIdle(true), HUD_IDLE_MS);
    };
    window.addEventListener("pointerdown", wake, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", wake, true);
    };
  }, [armed]);
  return idle && armed;
}
