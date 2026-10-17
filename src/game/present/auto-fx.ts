// Automatic FX tier (docs/HIGHLIGHTS.md "FX tier"), decided by how full the frame's RENDER is, not by the frame rate or the sim
// (`present/frame-work.ts`): a quick check after boot lifts a device with a hardware GPU and render time to spare to "high"; two
// windows too full step it down high → low → minimal; a run of windows with room climbs back one tier (never into "ultra": that
// one is the user's pick, on every device class); a match starts on minimal and runs the load check again 3 s after green. A
// manual pick turns it off. Whether the device may host a public match is judged on the main thread's total, sim included.
import { SLOW_WINDOWS } from "./constants.ts";
import type { FxTier } from "./engine-post.ts";
import { FRAME_BUDGET_MS, FrameWork, type Judge } from "./frame-work.ts";

const SOFTWARE_GPU = /swiftshader|llvmpipe|softpipe|basic render/i;

/**
 * What the device is, from the signals the browser gives: `software` (no GPU named, or a software rasterizer: Auto stays on
 * minimal), `mobile` (a coarse primary pointer, or the user agent says mobile: Auto judges its render, it never hosts a match,
 * and its memory-heavy tier items are capped, `RIVAL_SPRAY_MAX_SCALE`), else `desktop`. The one place the class is decided.
 */
export type DeviceClass = "desktop" | "mobile" | "software";

export function deviceClass(renderer: string | null, pointerFine: boolean, uaMobile: boolean): DeviceClass {
  if (renderer === null || SOFTWARE_GPU.test(renderer)) return "software";
  return pointerFine && !uaMobile ? "desktop" : "mobile";
}

/** What `gl.RENDERER` says when the browser withholds the GPU (Chrome, a fingerprint-resistant Firefox). */
const MASKED_RENDERER = /^(webkit webgl|mozilla|)$/i;

/**
 * The GPU's name, or null when the browser gives none. `gl.RENDERER` is the real name in Firefox, which deprecates
 * `WEBGL_debug_renderer_info` (a console warning on the lookup), so the extension is asked only where `RENDERER` is masked.
 */
export function gpuRenderer(gl: WebGLRenderingContext | WebGL2RenderingContext): string | null {
  const plain = String(gl.getParameter(gl.RENDERER));
  if (!MASKED_RENDERER.test(plain)) return plain;
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : null;
}

/** A tier holds while its windows can hold this wall rate where no GPU reading exists: the owner's 60 fps less 10. */
const DROP_FPS = 50;
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
  /** The last finished window's busier side (render main-thread or GPU median) as a share of the render budget (`frame-work.ts`). */
  busy = 0;
  /** The last finished window's render ms and the rest of its main-thread ms (the sim), each as a share of the 60 fps frame budget. */
  renderShare = 0;
  simShare = 0;
  /** The highest tier that held this session, where a match's end returns; null until the load check decides. */
  private ceiling: FxTier | null;
  private readonly capable: boolean;
  /** The same policy fed the same frames but judged on the main thread's total (sim included): its ceiling is `canHost`'s. Null in itself. */
  private readonly host: AutoFx | null;
  private tier: FxTier = "minimal";
  /** The last frame's match state; null forces the next frame to apply the target tier. */
  private match: boolean | null = null;
  /** The current match's post-green load check has run. */
  private probed = false;
  private readonly win: FrameWork;
  private slow = 0;
  private upRun = 0;
  private upNeed = UP_STREAK;
  /** Finished windows so far, and the counts at the last step down and the last climb (-1000: never). */
  private windows = 0;
  private downAt = -1000;
  private climbedAt = -1000;

  /**
   * `capable`: the load check runs (not a software GPU). `hostable`: may host a public match (a desktop; a phone never does).
   * `judge` is the basis the tiers are judged on; only the policy's own host copy passes "work".
   */
  constructor(capable: boolean, auto: boolean, hostable = capable, judge: Judge = "render") {
    this.auto = auto;
    this.capable = capable;
    this.ceiling = capable ? null : "minimal";
    this.win = new FrameWork(judge);
    this.host = judge === "render" ? new AutoFx(hostable, auto, hostable, "work") : null;
  }

  /**
   * Fit to host a public match for others (docs/MULTIPLAYER.md "Matchmaking"): the highest tier this session held on the main
   * thread's TOTAL (sim included: a phone whose render has room still has no room to host) is "high" or "low", or the load
   * check has not yet judged a hostable desktop. A phone, a software GPU, and a desktop that measured or fell to minimal are
   * not: they search longer and host a smaller field.
   */
  canHost(): boolean {
    return (this.host ?? this).ceiling !== "minimal";
  }

  /**
   * Every rendered frame after boot: its wall interval (ms), the main thread's ms for the last frame, the draw submit's ms inside
   * it, the newest GPU ms (-1: no timer or no reading yet); returns the tier to switch to, or null. `matchTime` is the race's or
   * derby's clock (s, negative before green, 0 at green), null outside a match.
   */
  frame(ms: number, workMs: number, renderMs: number, gpuMs: number, matchTime: number | null): FxTier | null {
    if (!this.auto) return null;
    this.host?.frame(ms, workMs, renderMs, gpuMs, matchTime);
    const match = matchTime !== null;
    if (match !== this.match) {
      this.match = match;
      this.probed = false;
      return this.switch(match ? "minimal" : (this.ceiling ?? "minimal"));
    }
    if (match && !this.probed) return this.probe(ms, workMs, renderMs, gpuMs, matchTime);
    if (!this.capable || !this.win.add(ms, workMs, renderMs, gpuMs)) return null;
    return this.verdict();
  }

  /** The load check and every later window: step down when too full, climb when there is room. */
  private verdict(): FxTier | null {
    const w = this.win;
    this.record();
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
  private probe(ms: number, workMs: number, renderMs: number, gpuMs: number, matchTime: number): FxTier | null {
    if (matchTime < MATCH_PROBE_AT) {
      this.win.restart(0);
      return null;
    }
    if (!this.win.add(ms, workMs, renderMs, gpuMs)) return null;
    this.record();
    this.probed = true;
    const roomy = this.win.roomy();
    // A first check that finds no room leaves the ceiling undecided: the load check after it judges again.
    if (roomy) this.ceiling ??= "high";
    return this.switch(roomy ? this.ceiling! : "minimal");
  }

  /** Publishes the window that just finished (the console line and the HUD read it). */
  private record(): void {
    const w = this.win;
    this.fps = w.fps;
    this.busy = w.busy;
    this.renderShare = w.renderMs / FRAME_BUDGET_MS;
    this.simShare = w.simMs / FRAME_BUDGET_MS;
  }

  /** Auto back on from tier `current`; the next frame applies its target. */
  resume(current: FxTier): void {
    this.auto = true;
    this.tier = current;
    this.match = null;
    this.host?.resume(current);
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
