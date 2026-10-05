/** Quiet time before the touch HUD collapses itself to its short bar. */
export const HUD_IDLE_MS = 5000;

/** An options object: Node's EventTarget ignores a bare `true` when removing the listener. */
const CAPTURE = { capture: true };

/**
 * Calls `onIdle` once `target` has seen no tap for `HUD_IDLE_MS` (a tap restarts the countdown), and returns the stop function.
 * Touches on an element marked `data-keep-idle` (the thumb pad) don't count, so driving doesn't hold the menu open.
 *
 * It only ever collapses. Expanding is an explicit gesture on the collapsed bar (a click or a slide up), never a pointerdown:
 * a pointerdown that re-laid the HUD out would put a different control under the finger for the same tap's click.
 */
export function watchHudIdle(target: EventTarget, onIdle: () => void, ms = HUD_IDLE_MS): () => void {
  let timer = setTimeout(onIdle, ms);
  const tapped = (e: Event) => {
    if ((e.target as Element).closest?.("[data-keep-idle]")) return;
    clearTimeout(timer);
    timer = setTimeout(onIdle, ms);
  };
  target.addEventListener("pointerdown", tapped, CAPTURE);
  return () => {
    clearTimeout(timer);
    target.removeEventListener("pointerdown", tapped, CAPTURE);
  };
}
