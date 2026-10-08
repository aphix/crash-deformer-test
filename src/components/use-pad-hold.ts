import { useEffect, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { CrashEngine } from "@/game/engine/engine";

/**
 * The touch pad's one way to press a button (`PAD_BUTTON` index): held while a finger is on the element, and a tap shorter than a frame
 * still presses. Spread the result on any button; the thumb pad's buttons and the nitrous bottle share it, so there is one boost path.
 */
export function usePadHold(engine: RefObject<CrashEngine | null>, button: number) {
  const mask = 1 << button;
  // Unmounted under a finger (the seat changed): let go, or the bit would stay held.
  useEffect(
    () => () => {
      const t = engine.current?.touch;
      if (t) t.held &= ~mask;
    },
    [engine, mask],
  );
  const release = (e: ReactPointerEvent<HTMLElement>): void => {
    delete e.currentTarget.dataset.held;
    const t = engine.current?.touch;
    if (t) t.held &= ~mask;
  };
  return {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>): void => {
      const t = engine.current?.touch;
      if (!t) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      e.currentTarget.dataset.held = "";
      t.held |= mask;
      t.tapped |= mask;
    },
    onPointerUp: release,
    onPointerCancel: release,
    onLostPointerCapture: release,
    onContextMenu: (e: { preventDefault: () => void }): void => e.preventDefault(),
  };
}
