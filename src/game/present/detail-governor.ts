import { DETAIL_LEVELS } from "./car-detail.ts";

/**
 * The distance detail's rung (`DETAIL_LEVELS`) chosen by how the match runs, the way `AutoFx` chooses the FX tier: windows of
 * `WINDOW_MS` of the frames the match plays. A window is slow when its frame rate is under `SLOW_FPS` (the 60 fps of a plain
 * screen less 5 %) or the pacer gave up more than `LOST_SHARE` of its time (a sim that cannot keep its clock). `SLOW_WINDOWS` slow
 * windows in a row step one rung nearer (a cheaper draw); `holdWindows` fine windows in a row step one rung back. A step back that
 * is followed by a step nearer within twice its hold was too soon: the hold doubles (to `MAX_HOLD`), so a device that cannot afford a
 * rung stops trying it. A hitch ends one window and never steps, a match's first `SETTLE_MS` and every rung change's are not
 * counted (the draw's new cost takes a moment to show), and outside a match nothing is counted at all.
 */
const SETTLE_MS = 1500;
const WINDOW_MS = 1000;
const SLOW_FPS = 57;
const LOST_SHARE = 0.02;
const SLOW_WINDOWS = 2;
const FIRST_HOLD = 10;
const MAX_HOLD = 80;
const LAST = DETAIL_LEVELS.length - 1;

export class DetailGovernor {
  /** The rung in force: an index into `DETAIL_LEVELS` (0: the farthest cuts). */
  level: number;
  /** Fine windows in a row that step one rung back, doubled by a too-early step back. */
  holdWindows = FIRST_HOLD;
  private settle = SETTLE_MS;
  private winMs = 0;
  private lostMs = 0;
  private frames = 0;
  private slow = 0;
  private fine = 0;
  /** Windows since the last step back (-1: none yet); it only matters while it is within twice the hold. */
  private sinceBack = -1;

  /** `start`: the rung a match opens on (an index into `DETAIL_LEVELS`, clamped). */
  constructor(start: number) {
    this.level = Math.min(LAST, Math.max(0, start));
  }

  /**
   * One rendered frame: its wall interval (ms), the sim time the pacer gave up in it (ms) and whether a match is running.
   * Returns the rung to switch to, or null.
   */
  frame(ms: number, lostMs: number, matching: boolean): number | null {
    if (!matching) {
      this.settle = SETTLE_MS;
      this.winMs = this.lostMs = this.frames = this.slow = this.fine = 0;
      return null;
    }
    if (this.settle > 0) {
      this.settle -= ms;
      return null;
    }
    this.winMs += ms;
    this.lostMs += lostMs;
    this.frames++;
    if (this.winMs < WINDOW_MS) return null;
    const slow = (this.frames * 1000) / this.winMs < SLOW_FPS || this.lostMs > LOST_SHARE * this.winMs;
    this.winMs = this.lostMs = this.frames = 0;
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
    if (this.level <= 0 || ++this.fine < this.holdWindows) return null;
    this.sinceBack = 0;
    return this.move(this.level - 1);
  }

  private move(to: number): number {
    this.level = to;
    this.settle = SETTLE_MS;
    this.slow = this.fine = 0;
    return to;
  }
}
