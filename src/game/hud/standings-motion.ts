import type { RaceHudRow } from "../match/types.ts";

/** Wall ms a row that left the standings stays on screen to fade out (the row's `--motion-fast`, 250 ms, plus a frame). */
export const LEAVE_MS = 300;

/**
 * The classes every standings row (`li`) carries (masterclass 23:34, "fade them in or out"): a row slides to its new place
 * (`useSlide` hands it its old offset, the transform transition takes it home), and fades in from `data-fading` when it
 * arrives and out to it while it leaves. A transition, not a keyframe animation: a row the DOM moves on a pass would
 * restart an animation and blink.
 */
export const STANDING_LI = "transition-[transform,opacity] duration-[var(--motion-fast)] ease-[var(--ease-out)] data-[fading]:pointer-events-none data-[fading]:opacity-0";

export type StandingSlot = { row: RaceHudRow; leaving: boolean };

/** `rows` (live order) with each of `gone` (rows that left, in the order they stood) put back at its last place, flagged leaving. A row that is back in `rows` is not a leaver. */
export function withLeavers(rows: readonly RaceHudRow[], gone: readonly RaceHudRow[]): StandingSlot[] {
  const out: StandingSlot[] = rows.map((row) => ({ row, leaving: false }));
  for (const g of gone) {
    if (rows.some((r) => r.id === g.id)) continue;
    out.splice(Math.min(out.length, g.place - 1), 0, { row: g, leaving: true });
  }
  return out;
}
