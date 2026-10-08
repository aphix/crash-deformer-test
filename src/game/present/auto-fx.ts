// Automatic FX tier (docs/HIGHLIGHTS.md "FX tier"), decided by how full the frame is, not by the frame rate (`present/frame-work.ts`):
// a quick check after boot lifts a capable desktop with room to spare to "high"; two windows too full for 60 fps step it down
// high → low → minimal; a run of windows with room climbs back one tier (never into "ultra": that one is the user's pick); a match
// starts on minimal and runs the load check again 3 s after green. A manual pick turns it off.
import type { FxTier } from "./engine-post.ts";
import { FrameWork } from "./frame-work.ts";

const SOFTWARE_GPU = /swiftshader|llvmpipe|softpipe|basic render/i;

/** True only on a fine-pointer device whose GPU is known and is not a software rasterizer. */
export function hardwareDesktop(renderer: string | null, pointerFine: boolean): boolean {
  return pointerFine && renderer !== null && !SOFTWARE_GPU.test(renderer);
}

/** A tier holds while its windows can hold this wall rate where no GPU reading exists: the owner's 60 fps less 10. */
const DROP_FPS = 50;
/** Slow windows in a row that drop a tier: one hitch, however long, ends only one window, so it never drops. */
const SLOW_WINDOWS = 2;
/** Windows with room in a row that climb one tier above any that held. */
const UP_STREAK = 8;
/** Windows with room in a row that lift a match's minimal back to the ceiling (a tier that held before). */
const RESTORE_STREAK = 2;
/** Windows after a step down before any climb (a reversal inside it is hunting a boundary), and the windows a climb has to survive. */
const REVERSAL_WINDOWS = 20;
/** A climb that is dropped again inside `REVERSAL_WINDOWS` doubles the streak the next climb needs, up to this. */
const MAX_UP_STREAK = 64;
/** A match's own load check starts this long (s) after its green light (match clock 0). */
const MATCH_PROBE_AT = 3;
const STEP_DOWN: Partial<Record<FxTier, FxTier>> = { high: "low", low: "minimal" };
/** The tiers auto reaches, lowest first: "ultra" is never among them. */
const LADDER: readonly FxTier[] = ["minimal", "low", "high"];
const STEP_UP: Partial<Record<FxTier, FxTier>> = { minimal: "low", low: "high" };

export class AutoFx {
  /** False for the rest of the session once the user picks a tier (or passes `?fx=`). */
  auto: boolean;
  /** The last finished window's fps (0 before one). */
  fps = 0;
  /** The last finished window's busier side (CPU or GPU median) as a share of the 60 fps frame budget. */
  busy = 0;
  /** The highest tier that held this session, where a match's end returns; null until the load check decides. */
  private ceiling: FxTier | null;
  private readonly capable: boolean;
  private tier: FxTier = "minimal";
  /** The last frame's match state; null forces the next frame to apply the target tier. */
  private match: boolean | null = null;
  /** The current match's post-green load check has run. */
  private probed = false;
  private readonly win = new FrameWork();
  private slow = 0;
  private upRun = 0;
  private upNeed = UP_STREAK;
  /** Finished windows so far, and the counts at the last step down and the last climb (-1000: never). */
  private windows = 0;
  private downAt = -1000;
  private climbedAt = -1000;

  constructor(capable: boolean, auto: boolean) {
    this.auto = auto;
    this.capable = capable;
    this.ceiling = capable ? null : "minimal";
  }

  /**
   * Fit to host a public match for others (docs/MULTIPLAYER.md "Matchmaking"): the highest tier this session held
   * is "high" or "low", or the load check has not yet judged a capable (hardware, fine-pointer) device. A phone, a
   * software GPU, and a desktop that measured or fell to minimal are not: they search longer and host a smaller field.
   */
  canHost(): boolean {
    return this.ceiling !== "minimal";
  }

  /**
   * Every rendered frame after boot: its wall interval (ms), the main thread's ms for the last frame, the newest GPU ms (-1: no
   * timer or no reading yet); returns the tier to switch to, or null. `matchTime` is the race's or derby's clock (s, negative
   * before green, 0 at green), null outside a match.
   */
  frame(ms: number, workMs: number, gpuMs: number, matchTime: number | null): FxTier | null {
    if (!this.auto) return null;
    const match = matchTime !== null;
    if (match !== this.match) {
      this.match = match;
      this.probed = false;
      return this.switch(match ? "minimal" : (this.ceiling ?? "minimal"));
    }
    if (match && !this.probed) return this.probe(ms, workMs, gpuMs, matchTime);
    if (!this.capable || !this.win.add(ms, workMs, gpuMs)) return null;
    return this.verdict();
  }

  /** The load check and every later window: step down when too full, climb when there is room. */
  private verdict(): FxTier | null {
    const w = this.win;
    this.fps = w.fps;
    this.busy = w.busy;
    this.windows++;
    const roomy = w.roomy();
    if (this.ceiling === null) {
      this.ceiling = roomy ? "high" : "minimal";
      return this.switch(this.ceiling);
    }
    if (w.slow(DROP_FPS)) {
      this.upRun = 0;
      const down = STEP_DOWN[this.tier];
      if (++this.slow < SLOW_WINDOWS || down === undefined) return null;
      if (this.windows - this.climbedAt <= REVERSAL_WINDOWS) this.upNeed = Math.min(MAX_UP_STREAK, this.upNeed * 2);
      this.downAt = this.windows;
      this.ceiling = down;
      return this.switch(down);
    }
    this.slow = 0;
    // Under the ceiling (a match start's minimal that the load check did not lift) the way back is short: that tier held before.
    const restoring = LADDER.indexOf(this.tier) < LADDER.indexOf(this.ceiling);
    const up = restoring ? this.ceiling : STEP_UP[this.tier];
    if (up === undefined || !roomy) {
      this.upRun = 0;
      return null;
    }
    if (++this.upRun < (restoring ? RESTORE_STREAK : this.upNeed) || this.windows - this.downAt < REVERSAL_WINDOWS) return null;
    this.climbedAt = this.windows;
    if (LADDER.indexOf(up) > LADDER.indexOf(this.ceiling)) this.ceiling = up;
    return this.switch(up);
  }

  /** The match's load check: minimal until green + 3 s, then one 1 s window; room to spare lifts to the ceiling. */
  private probe(ms: number, workMs: number, gpuMs: number, matchTime: number): FxTier | null {
    if (matchTime < MATCH_PROBE_AT) {
      this.win.restart(0);
      return null;
    }
    if (!this.win.add(ms, workMs, gpuMs)) return null;
    this.fps = this.win.fps;
    this.busy = this.win.busy;
    this.probed = true;
    const roomy = this.win.roomy();
    // A first check that finds no room leaves the ceiling undecided: the load check after it judges again.
    if (roomy) this.ceiling ??= "high";
    return this.switch(roomy ? this.ceiling! : "minimal");
  }

  /** Auto back on from tier `current`; the next frame applies its target. */
  resume(current: FxTier): void {
    this.auto = true;
    this.tier = current;
    this.match = null;
  }

  private switch(to: FxTier): FxTier | null {
    this.win.restart();
    this.slow = 0;
    this.upRun = 0;
    if (to === this.tier) return null;
    this.tier = to;
    return to;
  }
}
