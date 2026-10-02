/** Spatial focus maths for the race menus (gamepad D-pad / stick and arrow keys). DOM-free. */

export type NavDir = "up" | "down" | "left" | "right";

/** The part of a `DOMRect` the maths reads, in CSS pixels (y down). */
export type NavRect = { readonly left: number; readonly top: number; readonly width: number; readonly height: number };

/** A cross-axis gap between the spans costs this much more than distance along the move. */
const OFF_AXIS_WEIGHT = 2;
/** Cross-axis centre offset, so the more centred of several overlapping items wins. */
const CENTRE_WEIGHT = 0.1;
/** Sub-pixel tolerance on the leading-edge test (layout rounding). */
const EDGE_SLOP = 1;

/** Gap between two 1-D spans, 0 when they overlap. */
function spanGap(a: number, aLen: number, b: number, bLen: number): number {
  return Math.max(0, a - (b + bLen), b - (a + aLen));
}

/**
 * Index of the item focus moves to from `rects[from]` in `dir`, or `from` when nothing lies
 * that way (no wrapping). A candidate must lie wholly past the source's leading edge (so a
 * taller neighbour in the same row is not "below", and the next row is not "right" of a wide
 * item). Score: centre distance along the move + weighted gap between the cross-axis spans
 * (0 when they overlap) + a small centre offset term; lowest wins, ties to the lower index.
 */
export function navTarget(rects: readonly NavRect[], from: number, dir: NavDir): number {
  const src = rects[from];
  if (!src) return from;
  const sx = src.left + src.width / 2;
  const sy = src.top + src.height / 2;
  const vertical = dir === "up" || dir === "down";
  let best = from;
  let bestScore = Infinity;
  for (let i = 0; i < rects.length; i++) {
    if (i === from) continue;
    const r = rects[i]!;
    const inside =
      dir === "down"
        ? r.top >= src.top + src.height - EDGE_SLOP
        : dir === "up"
          ? r.top + r.height <= src.top + EDGE_SLOP
          : dir === "right"
            ? r.left >= src.left + src.width - EDGE_SLOP
            : r.left + r.width <= src.left + EDGE_SLOP;
    if (!inside) continue;
    const dx = Math.abs(r.left + r.width / 2 - sx);
    const dy = Math.abs(r.top + r.height / 2 - sy);
    const score = vertical
      ? dy + OFF_AXIS_WEIGHT * spanGap(r.left, r.width, src.left, src.width) + CENTRE_WEIGHT * dx
      : dx + OFF_AXIS_WEIGHT * spanGap(r.top, r.height, src.top, src.height) + CENTRE_WEIGHT * dy;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/** Stick deflection (after `readPad`'s deadzone and curve) that counts as a direction. */
export const STICK_NAV = 0.35;

/** Dominant stick direction, null inside `STICK_NAV`. DOM signs: +x right, +y down. */
export function stickDir(x: number, y: number): NavDir | null {
  if (Math.abs(x) >= Math.abs(y)) return x > STICK_NAV ? "right" : x < -STICK_NAV ? "left" : null;
  return y > STICK_NAV ? "down" : y < -STICK_NAV ? "up" : null;
}

/** Held-direction repeat (ms): fire on press, again after `NAV_REPEAT_DELAY`, then every `NAV_REPEAT_RATE`. */
export const NAV_REPEAT_DELAY = 350;
export const NAV_REPEAT_RATE = 120;

export class NavRepeat {
  private dir: NavDir | null = null;
  private nextAt = 0;

  /** Feed the held direction once per poll; true when a move should fire now. */
  step(dir: NavDir | null, now: number): boolean {
    if (dir !== this.dir) {
      this.dir = dir;
      this.nextAt = now + NAV_REPEAT_DELAY;
      return dir !== null;
    }
    if (dir === null || now < this.nextAt) return false;
    this.nextAt = now + NAV_REPEAT_RATE;
    return true;
  }
}
