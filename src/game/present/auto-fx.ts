// Automatic FX tier (docs/HIGHLIGHTS.md "FX tier"): a quick check after boot lifts a capable desktop to "high"; a
// sustained fall under 50 fps steps it down high → low → minimal; a match starts on minimal and runs the same check
// again 3 s after green. A manual pick turns it off.
import type { FxTier } from "./engine-post.ts";

const SOFTWARE_GPU = /swiftshader|llvmpipe|softpipe|basic render/i;

/** True only on a fine-pointer device whose GPU is known and is not a software rasterizer. */
export function hardwareDesktop(renderer: string | null, pointerFine: boolean): boolean {
  return pointerFine && renderer !== null && !SOFTWARE_GPU.test(renderer);
}

/** Frames ignored after boot or a switch (ms): shader links and the first post-chain allocations land here. */
const SETTLE_MS = 1500;
/** One fps sample: frames / wall time over at least this long (ms). */
const WINDOW_MS = 1000;
/** A tier holds while windows average at least this: the owner's 60 fps less 10, whatever the display's refresh. */
const DROP_FPS = 50;
/** Slow windows in a row that drop a tier: one hitch, however long, ends only one window, so it never drops. */
const SLOW_WINDOWS = 2;
/** The load check lifts to "high" only if minimal holds 60 fps (5% for timer noise), leaving headroom for the post chain. */
const PROBE_FPS = 57;
/** A match's own load check starts this long (s) after its green light (match clock 0). */
const MATCH_PROBE_AT = 3;
const STEP_DOWN: Partial<Record<FxTier, FxTier>> = { high: "low", low: "minimal" };

export class AutoFx {
  /** False for the rest of the session once the user picks a tier (or passes `?fx=`). */
  auto: boolean;
  /** The last finished window's fps (0 before one). */
  fps = 0;
  /** The highest tier that held this session, where a match's end returns; null until the load check decides. */
  private ceiling: FxTier | null;
  private tier: FxTier = "minimal";
  /** The last frame's match state; null forces the next frame to apply the target tier. */
  private match: boolean | null = null;
  /** The current match's post-green load check has run. */
  private probed = false;
  private settle = SETTLE_MS;
  private winMs = 0;
  private frames = 0;
  private slow = 0;

  constructor(capable: boolean, auto: boolean) {
    this.auto = auto;
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
   * Every rendered frame's wall interval (ms) after boot; returns the tier to switch to, or null. `matchTime` is the
   * race's or derby's clock (s, negative before green, 0 at green), null outside a match.
   */
  frame(ms: number, matchTime: number | null): FxTier | null {
    if (!this.auto) return null;
    const match = matchTime !== null;
    if (match !== this.match) {
      this.match = match;
      this.probed = false;
      return this.switch(match ? "minimal" : (this.ceiling ?? "minimal"));
    }
    if (match && !this.probed) return this.probe(ms, matchTime);
    if (this.ceiling !== null && STEP_DOWN[this.tier] === undefined) return null;
    if (this.settle > 0) {
      this.settle -= ms;
      return null;
    }
    this.winMs += ms;
    this.frames++;
    if (this.winMs < WINDOW_MS) return null;
    this.fps = (this.frames * 1000) / this.winMs;
    this.winMs = 0;
    this.frames = 0;
    if (this.ceiling === null) {
      this.ceiling = this.fps >= PROBE_FPS ? "high" : "minimal";
      return this.switch(this.ceiling);
    }
    this.slow = this.fps < DROP_FPS ? this.slow + 1 : 0;
    if (this.slow < SLOW_WINDOWS) return null;
    this.ceiling = STEP_DOWN[this.tier]!;
    return this.switch(this.ceiling);
  }

  /** The match's load check: minimal until green + 3 s, then one 1 s window; 57 fps or more lifts to the ceiling. */
  private probe(ms: number, matchTime: number): FxTier | null {
    if (matchTime < MATCH_PROBE_AT) return null;
    this.winMs += ms;
    this.frames++;
    if (this.winMs < WINDOW_MS) return null;
    this.fps = (this.frames * 1000) / this.winMs;
    this.probed = true;
    const held = this.fps >= PROBE_FPS;
    this.ceiling ??= held ? "high" : "minimal";
    return this.switch(held ? this.ceiling : "minimal");
  }

  /** Auto back on from tier `current`; the next frame applies its target. */
  resume(current: FxTier): void {
    this.auto = true;
    this.tier = current;
    this.match = null;
  }

  private switch(to: FxTier): FxTier | null {
    this.settle = SETTLE_MS;
    this.winMs = 0;
    this.frames = 0;
    this.slow = 0;
    if (to === this.tier) return null;
    this.tier = to;
    return to;
  }
}
