import { DETAIL_LEVELS } from "./car-detail.ts";
import { SLOW_WINDOWS } from "./constants.ts";
import { FrameWork } from "./frame-work.ts";

/**
 * The distance detail's rung (`DETAIL_LEVELS`) chosen by how the match runs, the way `AutoFx` chooses the FX tier: windows of
 * the frames the match plays (`FrameWork`). A window is slow when the frame cannot hold the 60 fps budget (the main thread's or
 * the GPU's median over it is too long; with no GPU reading, a wall rate under `SLOW_FPS`, the 60 fps of a plain screen less 5 %)
 * or the pacer gave up more than `LOST_SHARE` of its time (a sim that cannot keep its clock). `SLOW_WINDOWS` slow windows in a row
 * step one rung nearer (a cheaper draw); `holdWindows` windows in a row with room to spare step one rung back (a pinned display
 * shows 60 fps at any headroom, so "not slow" is not room). A step back that is followed by a step nearer within twice its hold was
 * too soon: the hold doubles (to `MAX_HOLD`), so a device that cannot afford a rung stops trying it. A hitch ends one window and
 * never steps, a match's first `SETTLE_MS` and every rung change's are not counted (the draw's new cost takes a moment to show),
 * and outside a match nothing is counted at all.
 */
const SLOW_FPS = 57;
const LOST_SHARE = 0.02;
const FIRST_HOLD = 10;
const MAX_HOLD = 80;
const LAST = DETAIL_LEVELS.length - 1;

export class DetailGovernor {
  /** The rung in force: an index into `DETAIL_LEVELS` (0: the farthest cuts). */
  level: number;
  /** Windows with room in a row that step one rung back, doubled by a too-early step back. */
  holdWindows = FIRST_HOLD;
  private readonly win = new FrameWork();
  private lostMs = 0;
  private slow = 0;
  private fine = 0;
  /** Windows since the last step back (-1: none yet); it only matters while it is within twice the hold. */
  private sinceBack = -1;

  /** `start`: the rung a match opens on (an index into `DETAIL_LEVELS`, clamped). */
  constructor(start: number) {
    this.level = Math.min(LAST, Math.max(0, start));
  }

  /**
   * One rendered frame: its wall interval (ms), the sim time the pacer gave up in it (ms), the main thread's ms for the last frame,
   * the newest GPU ms (-1: none) and whether a match is running. Returns the rung to switch to, or null.
   */
  frame(ms: number, lostMs: number, workMs: number, gpuMs: number, matching: boolean): number | null {
    if (!matching) {
      this.win.restart();
      this.lostMs = this.slow = this.fine = 0;
      return null;
    }
    const counted = !this.win.settling;
    const done = this.win.add(ms, workMs, gpuMs);
    if (!counted) return null;
    this.lostMs += lostMs;
    if (!done) return null;
    const slow = this.win.slow(SLOW_FPS) || this.lostMs > LOST_SHARE * this.win.wallMs;
    this.lostMs = 0;
    if (this.sinceBack >= 0) this.sinceBack++;
    if (slow) {
      this.fine = 0;
      this.slow++;
      if (this.slow < SLOW_WINDOWS || this.level >= LAST) return null;
      // Too soon after a step back: the next try waits longer.
      if (this.sinceBack >= 0 && this.sinceBack <= 2 * this.holdWindows) this.holdWindows = Math.min(MAX_HOLD, this.holdWindows * 2);
      this.sinceBack = -1;
      return this.move(this.level + 1);
    }
    this.slow = 0;
    if (this.level <= 0 || !this.win.roomy()) {
      this.fine = 0;
      return null;
    }
    if (++this.fine < this.holdWindows) return null;
    this.sinceBack = 0;
    return this.move(this.level - 1);
  }

  private move(to: number): number {
    this.level = to;
    this.win.restart();
    this.lostMs = this.slow = this.fine = 0;
    return to;
  }
}
