import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import type { Ejection } from "../vehicle/ejection.ts";
import type { CarSurfaces } from "../vehicle/car-surfaces.ts";
import { beginImpact, CONTACT_HOLD, easeTimeScale, FUDGE_GAP, impactScale, phaseClock, PRE_IMPACT_LEAD, SLOMO_HOLD, stepPhase, THROW_HOLD, type CrashPhase, type PhaseClock } from "../match/phase.ts";
import { clipTitle, MAX_HITS, type HighlightClip, type Reel } from "../match/highlights.ts";
import type { ReelHud, SaveResult, ViewBox } from "../match/types.ts";
import { mulberry32 } from "../world/placements.ts";
import { AFTERS, OPENERS, pickShot, RUN_INS, ShotCam, type Shot as PickedShot, type ShotKind } from "../present/shot-cam.ts";
import { CINE, type Sight } from "../present/spectate-cam.ts";
import { crashCamEnd, CUTS, hitAim, laterHits, type CrashCam, type CrashHold } from "../present/engine-cine.ts";
import { contextEye, contextPose, overheadPose } from "../present/highlight-cam.ts";
import { ClipSim, type ReplayScene } from "./engine-replay.ts";

/** Wall seconds of the far-overhead flight into each clip. */
export const FLIGHT_S = 3;
/** Solo view: wall seconds a clip's last frame holds before it plays again. */
const SOLO_HOLD = 1.5;
/** A clip's timeline steps the phase clock at this fixed wall rate: the same curve on every peer, whatever its frame rate. */
const TL_DT = 1 / 120;
/**
 * A peer that reaches a clip more than this far in (wall s: a late join, back from the solo view, a stalled tab)
 * hovers over it until the next flight rather than replaying seconds of it in one frame.
 */
const JOIN_LATE = 0.25;
/** A car–car hit in a replay throws sparks at most this often (wall s), as a race does. */
const SPARK_GAP = 0.16;
/**
 * The held crash cam keeps a cut whose eye sees the hit this long (wall s) past the cars meeting, the car in its sight or
 * not (`CrashHold.hit`): longer than its re-ask (`HOLD_CHECK`), so an ask just before the hit cannot hand the shot off on it.
 */
const HIT_KEEP = 0.3;
/** The held crash cam turns to a later impact of the window this long (wall s) before it lands: its aim takes about 0.75 s to settle (`HOLD_AIM`). */
const HIT_LEAD = 0.75;

/** A clip's wall timeline from the phase.ts slow-mo: per `TL_DT` the clip time, the time scale and the crash phase. */
type Timeline = {
  /** Wall seconds the clip plays. */
  wall: number;
  sim: Float64Array;
  scale: Float32Array;
  phase: CrashPhase[];
  /** Wall s the crash cam begins: `CUTS[0]` before `onset`, so its first cut lands as the slow-mo starts easing in (never before the clip). */
  impact: number;
  /** Wall s the slow-mo starts easing in, `PRE_IMPACT_LEAD` sim s before the recorded first impact. */
  onset: number;
  /** Wall s of the recorded first impact itself (the cars meet): the ease has reached the slow scale, the crash clock's `impact` phase starts, the flash and burst go off. */
  contact: number;
  /** Wall s from `impact` to the slow-mo's hand-back to 1× (or to the clip's end, if it comes first). */
  hold: number;
};

/**
 * The phase clock run at fixed wall steps over a `length` s clip: 1× to `PRE_IMPACT_LEAD` before the first impact, the
 * ease into the auto slow-mo (the live sandbox's `preImpact`), the slow-mo held over the cars meeting and every throw
 * (clip s, in order) that comes while it runs, then back to 1×.
 */
export function clipTimeline(firstImpact: number, length: number, throws: readonly number[]): Timeline {
  const c = phaseClock();
  // The slow-mo holds until the cars meeting sets its hand-back.
  c.hold = Infinity;
  const lead = firstImpact - PRE_IMPACT_LEAD;
  const sim: number[] = [];
  const scale: number[] = [];
  const phase: CrashPhase[] = [];
  let onset = Infinity;
  let contact = Infinity;
  let next = 0;
  for (let t = 0; ; ) {
    if (onset === Infinity && t >= lead) {
      c.targetScale = impactScale(c);
      onset = sim.length * TL_DT;
    }
    if (contact === Infinity && t >= firstImpact) {
      beginImpact(c, true);
      contact = sim.length * TL_DT;
      c.hold = c.wallSinceImpact + CONTACT_HOLD;
    }
    // A throw before the cars meet is an earlier crash's; one after the hand-back plays at 1×.
    for (; next < throws.length && throws[next]! <= t; next++) {
      if (contact !== Infinity && (c.phase === "impact" || c.phase === "slowmo")) c.hold = Math.max(c.hold, c.wallSinceImpact + THROW_HOLD);
    }
    sim.push(Math.min(t, length));
    scale.push(c.timeScale);
    phase.push(c.phase);
    if (t >= length) break;
    // tickInner's order: ease, step the sim at the eased scale, then the phase.
    easeTimeScale(c, TL_DT);
    t += TL_DT * c.timeScale;
    stepPhase(c, TL_DT);
  }
  const back = phase.indexOf("aftermath");
  const impact = Math.max(0, onset - CUTS[0]);
  const hold = (back < 0 ? sim.length - 1 : back) * TL_DT - impact;
  return { wall: (sim.length - 1) * TL_DT, sim: Float64Array.from(sim), scale: Float32Array.from(scale), phase, impact, onset, contact, hold };
}

/** Clip time at wall `w` s into the timeline. */
export function simAt(tl: Timeline, w: number): number {
  const k = Math.max(0, w) / TL_DT;
  const i = Math.min(Math.floor(k), tl.sim.length - 1);
  const j = Math.min(i + 1, tl.sim.length - 1);
  return tl.sim[i]! + (tl.sim[j]! - tl.sim[i]!) * Math.min(1, k - i);
}

/** Wall seconds into the timeline at which the clip reaches clip time `t` (the first step that does; the timeline's end when none does). */
function wallAt(tl: Timeline, t: number): number {
  let lo = 0;
  let hi = tl.sim.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tl.sim[mid]! >= t) hi = mid;
    else lo = mid + 1;
  }
  return lo * TL_DT;
}

/** Clip time at which the replay starts showing a hit recorded at `t`: the start of the recorded step that ended on it (`ReplaySim.advanceTo` runs whole steps and `present` draws the cars between a step's ends). */
function shownFrom(clip: HighlightClip, t: number): number {
  let start = 0;
  let end = 0;
  for (let i = 0; i < clip.h.length && end < t - 1e-9; i++) {
    start = end;
    end += clip.h[i]!;
  }
  return start;
}

/** A camera from clip time `at`: a picked shot (`present/shot-cam.ts`, the director the Auto spectator cam shares), or a context shot (`ctx`: a fixed eye over two impact points); `hit`: the cars meet while it is on. */
type Shot = PickedShot & { at: number; hit: boolean; ctx?: { eye: THREE.Vector3; aim: THREE.Vector3; fov: number } };

/** A context shot cuts in this long (clip s) before the hit it is for. */
const CONTEXT_LEAD = 0.8;

/**
 * A clip's shots, picked from the reel's seed (docs/HIGHLIGHTS.md "Cameras"): an opener, a run-in about a second before
 * the hit (the crash cam takes the hit itself), and the aftermath once the crash cam hands back. Same seed, same shots.
 * Camera lookahead: each later hit of the clip's scope after that hand-back (`ClipHit`) gets a context shot cut in just ahead
 * of it, a fixed eye that keeps the hit before it in frame with it (`contextEye`, over the course's static solids `still`);
 * where no eye does, the aftermath shot stays.
 */
function shotsFor(clip: HighlightClip, tl: Timeline, rand: () => number, still: () => Sight): Shot[] {
  const shots: Shot[] = [];
  const add = (at: number, kinds: readonly ShotKind[]): void => {
    shots.push({ at, hit: false, ...pickShot(kinds, shots[shots.length - 1]?.kind, rand) });
  };
  add(0, OPENERS);
  const runIn = clip.firstImpact - 1 - rand() * 0.8;
  if (runIn > 0.8) add(runIn, RUN_INS);
  shots[shots.length - 1]!.hit = true;
  const after = simAt(tl, tl.impact + crashCamEnd(tl.hold));
  if (after < tl.sim[tl.sim.length - 1]!) add(after, AFTERS);
  for (let k = 1; k < clip.hits.length; k++) {
    const h = clip.hits[k]!;
    if (shownFrom(clip, h.t) <= after) continue;
    const g = clip.hits[k - 1]!;
    const turn = rand() * 2 * Math.PI;
    const s = still();
    const ctx = { eye: new THREE.Vector3(), aim: new THREE.Vector3(), fov: 0 };
    ctx.fov = contextEye(s, hitAim(_p, g.x, g.y, g.z, s), hitAim(_q, h.x, h.y, h.z, s), turn, ctx.eye, ctx.aim);
    if (ctx.fov === 0) continue;
    const at = Math.max(after, h.t - CONTEXT_LEAD);
    const shot: Shot = { at, hit: false, kind: "high", mount: 0, angle: 0, seed: 0, ctx };
    if (at <= shots[shots.length - 1]!.at + 1e-6) shots[shots.length - 1] = shot;
    else shots.push(shot);
  }
  return shots;
}

/** A framed subject keeps this share of the view's width (height) from a panel's edge, as from the view's own edges. */
const COVER_MARGIN = 0.1;

/**
 * `camera`'s lens over the canvas box `view` with the boxes `covers` of the panels open over it. Of the strips of the
 * canvas clear of every panel whose edges are the canvas's and the panels', it takes the one with the most room for a
 * subject kept `COVER_MARGIN` from every edge (then the largest), and frames that room as a bare canvas's inner
 * `1 - 2 * COVER_MARGIN`: the screen is the room grown about its middle (its aspect, the projection centre there) and the
 * rest of the canvas shows what lies past the screen's edges. The reel's cameras keep their subject inside that inner share
 * of their screen, so it plays in the part of the view the panels leave free, clear of them as of the canvas's edges.
 */
export function coverLens(camera: THREE.PerspectiveCamera, view: ViewBox, covers: readonly ViewBox[]): void {
  const w = Math.max(1, view.right - view.left);
  const h = Math.max(1, view.bottom - view.top);
  const clamp = THREE.MathUtils.clamp;
  const boxes = covers
    .map((c) => ({ l: clamp(c.left - view.left, 0, w), r: clamp(c.right - view.left, 0, w), t: clamp(c.top - view.top, 0, h), b: clamp(c.bottom - view.top, 0, h) }))
    .filter((c) => c.r > c.l && c.b > c.t);
  const xs = [0, w, ...boxes.flatMap((c) => [c.l, c.r])];
  const ys = [0, h, ...boxes.flatMap((c) => [c.t, c.b])];
  const mx = COVER_MARGIN * w;
  const my = COVER_MARGIN * h;
  let room = -1;
  let area = -1;
  let [x, y, fw, fh] = [0, 0, w, h];
  for (const x0 of xs) {
    for (const x1 of xs) {
      if (x1 <= x0) continue;
      for (const y0 of ys) {
        for (const y1 of ys) {
          if (y1 <= y0 || boxes.some((c) => c.l < x1 && c.r > x0 && c.t < y1 && c.b > y0)) continue;
          const r = Math.max(0, x1 - x0 - 2 * mx) * Math.max(0, y1 - y0 - 2 * my);
          const a = (x1 - x0) * (y1 - y0);
          if (r < room || (r === room && a <= area)) continue;
          [room, area, x, y, fw, fh] = [r, a, x0, y0, x1 - x0, y1 - y0];
        }
      }
    }
  }
  if (fw >= w && fh >= h) {
    camera.aspect = w / h;
    camera.clearViewOffset();
    return;
  }
  // The room (a strip too thin for one: the strip itself), grown about the strip's middle.
  const grow = 1 / (1 - 2 * COVER_MARGIN);
  const sw = fw > 2 * mx ? (fw - 2 * mx) * grow : fw;
  const sh = fh > 2 * my ? (fh - 2 * my) * grow : fh;
  camera.aspect = sw / sh;
  camera.setViewOffset(sw, sh, sw / 2 - (x + fw / 2), sh / 2 - (y + fh / 2), w, h);
}

/** What the reel needs from the engine. */
export type ReelHost = {
  /** The cars a clip replays on, in its `cars` order. */
  carsOf(clip: HighlightClip): DeformableCar[];
  live(): readonly DeformableCar[];
  scene: ReplayScene;
  /** Every knocked prop back on its spot before a clip plays. */
  resetProps(): void;
  /** Empties the scene (`CrashEngine.clearLocal`): torn parts, loose wheels, dummies, fx and downed poles that the race or an earlier clip left. */
  clear(): void;
  /** The course's solids with every visible car but `focus` (the cinematic eye's sight lines). */
  sight(focus: DeformableCar): Sight;
  /** The course's own solids, no car in them: what a sight line to a moment to come is checked against. */
  still(): Sight;
  /** The engine's crash clock: the reel mirrors its slow-mo into it (letterbox, HUD). */
  clock: PhaseClock;
  /** A clip's crash cam begins (`CUTS[0]` before the slow-mo eases in): its letterbox, then its cut at the hit's point. */
  crash(contact: THREE.Vector3, normal: THREE.Vector3): void;
  /** A clip's first impact, the cars meet: the kick, flash and burst. */
  impact(contact: THREE.Vector3, normal: THREE.Vector3, closing: number): void;
  /** The clip's first impact is still ahead, the slow-mo easing in: sparks and dust on its point (called every `FUDGE_GAP` wall s until the cars meet). */
  fudge(contact: THREE.Vector3, normal: THREE.Vector3): void;
  /** A replay's car–car hit: sparks. */
  hit(contact: THREE.Vector3, normal: THREE.Vector3, impulse: number): void;
  /** A driver in the clip was thrown out (`ClipSim.take`, `e.car` the engine slot): his dummy flies, from the recording's numbers; `ride`: he was thrown in the clip's own crash, so the camera follows his flight (only such a driver is ever framed by the ride). */
  eject(e: Ejection, ride: boolean): void;
  /** The thrown drivers' ride-along places `camera` on them this frame (`subject`: the clip's focus car); false when no ride is on. */
  ride(camera: THREE.PerspectiveCamera, wallDt: number, subject: DeformableCar): boolean;
};

/** A clip ready to play. `id` names it for as long as the director holds it (every loop of a reel, and its solo view, are the same id); `from` is how it came (the results reel, a saved highlight). */
type Prepared = { id: number; from: "reel" | "saved"; clip: HighlightClip; sim: ClipSim; tl: Timeline; shots: Shot[] };
type Solo = Prepared & { startAt: number; back: () => void };

const _c = new THREE.Vector3();
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();

/**
 * The results reel (docs/HIGHLIGHTS.md): from `startAt` (this browser's `performance.now()` seconds) it loops
 * [overhead flight → clip] over the reel's clips. Wall time decides everything (the clip, its clip time through the
 * slow-mo timeline, the shot), so peers that share the reel and its start show the same frames at the same moment.
 * While it plays the engine's own sim is paused; the reel hides every car but the clip's and gives them back after.
 */
export class ReelDirector {
  /** A reel or solo clip drew this frame (`frame` returned non-null). */
  playing = false;
  /** Replay stepping per frame (ms); a frame behind its target catches up over the next ones (tests: Infinity). */
  stepBudgetMs = 6;
  private readonly host: ReelHost;
  private clips: Prepared[] = [];
  private startAt = Infinity;
  private loopWall = 0;
  private solo: Solo | null = null;
  /** Each reel clip's last Save result (the HUD shows it). */
  private readonly saved = new Map<number, SaveResult>();
  /** The clip being replayed, and which pass of it (a new pass restarts it). */
  private cur: Prepared | null = null;
  private pass = -1;
  private shot = -1;
  /** The crash cam has begun / the cars have met (the flash and burst have gone off) on this pass of the clip. */
  private began = false;
  private met = false;
  /** Wall s into the clip's timeline of the last fudge before its first impact. */
  private fudgedAt = -Infinity;
  /** The clip time (s) the replay was last drawn at: what the ragdolls, debris and FX advance by, not the steps the replay ran to get there. */
  private presentedAt = 0;
  private sparkAt = -Infinity;
  /** Reel clip on screen, −1 in a flight. */
  private showing = -1;
  /** The last clip id handed out (`prepare`). */
  private serial = 0;
  private flying = false;
  private readonly flight = { ax: 0, az: 0, bx: 0, bz: 0, u: 0 };
  private readonly shotCam = new ShotCam();
  /** What the held crash cam asks about the clip's focus car (`crashHold`). */
  private readonly hold: CrashHold = { target: new THREE.Vector3(), sight: () => this.host.sight(this.focus()!), hit: 0, later: laterHits(MAX_HITS) };
  /** Every live car's visibility when the reel took them. */
  private shown: boolean[] | null = null;

  constructor(host: ReelHost) {
    this.host = host;
  }

  /** A results reel is set (it may not have started yet); a saved clip's solo view alone is not one. */
  get hasReel(): boolean {
    return this.clips.length > 0;
  }

  /** The driver-look seed of the clip on screen (`driverLook`), null while no clip plays: its drivers look as they did in the race. */
  get look(): number | null {
    return this.playing ? (this.cur?.clip.look ?? null) : null;
  }

  /** The cars' tops of the clip on screen's replay world (`World.surfaces`), null while no clip plays. */
  get surfaces(): CarSurfaces | null {
    return this.playing ? (this.cur?.sim.world.surfaces ?? null) : null;
  }

  /** Play `reel` from `startAt` on, looping, replacing any reel. */
  play(reel: Reel, startAt: number): void {
    this.stop();
    if (reel.clips.length === 0) return;
    this.clips = reel.clips.map((clip, i) => this.prepare(clip, mulberry32(reel.seed ^ Math.imul(i + 1, 0x9e3779b9)), "reel"));
    this.loopWall = this.clips.reduce((a, p) => a + FLIGHT_S + p.tl.wall, 0);
    this.startAt = startAt;
  }

  /** The reel's clip `i` alone (solo view), from `now`; the reel resumes at its next flight after `back`. */
  view(i: number, now: number): void {
    const p = this.clips[i];
    if (p) this.soloOf(p, now, () => {});
  }

  /** A saved clip alone from `now`, on cars `cars`; `back` gives the field back when the solo view ends. */
  viewSaved(clip: HighlightClip, now: number, back: () => void): void {
    this.soloOf(this.prepare(clip, mulberry32(Math.floor(clip.score * 1000)), "saved"), now, back);
  }

  /** Leave the solo view (to the reel, or nothing). */
  back(): void {
    const s = this.solo;
    if (!s) return;
    this.solo = null;
    this.cur = null;
    if (this.clips.length === 0) this.stop();
    s.back();
  }

  /** Reel clip `i`'s Save came back `res` (the HUD marks it saved, or says why not). */
  markSaved(i: number, res: SaveResult): void {
    this.saved.set(i, res);
  }

  clip(i: number): HighlightClip | null {
    return this.clips[i]?.clip ?? null;
  }

  /** The clip with `id`, as the director holds it now (the solo clip, or a reel clip); null once it is gone (another reel replaced it, or its view ended). */
  clipById(id: number): Pick<Prepared, "clip" | "from"> | null {
    if (this.solo?.id === id) return this.solo;
    return this.clips.find((p) => p.id === id) ?? null;
  }

  /** Stop: the cars' visibility and the crash clock as they were. */
  stop(): void {
    const s = this.solo;
    this.solo = null;
    this.clips = [];
    this.saved.clear();
    this.startAt = Infinity;
    this.cur = null;
    this.showing = -1;
    this.playing = false;
    const shown = this.shown;
    this.shown = null;
    if (shown) {
      const live = this.host.live();
      for (let i = 0; i < live.length && i < shown.length; i++) live[i]!.group.visible = shown[i]!;
      // What the clips left (torn parts, dummies, sparks) must not reach the race or setup the player returns to.
      this.host.clear();
    }
    const c = this.host.clock;
    c.phase = "approach";
    c.timeScale = 1;
    c.targetScale = 1;
    c.wallSinceImpact = 0;
    c.hold = SLOMO_HOLD;
    s?.back();
  }

  /**
   * Once per rendered frame at `now` (s): runs the reel's replay to where wall time puts it and mirrors its slow-mo into
   * the crash clock. The sim seconds it advanced (the frame's sim dt), or null when no reel plays (the engine simulates).
   */
  frame(now: number): number | null {
    const solo = this.solo;
    const live = solo !== null || (this.clips.length > 0 && now >= this.startAt);
    this.playing = live;
    if (!live) return null;
    this.shown ??= this.host.live().map((c) => c.group.visible);
    if (solo) {
      const lap = solo.tl.wall + SOLO_HOLD;
      // A frame's timestamp can precede the click that set `startAt`: a negative t would run pass −1 to its end (its hit).
      const t = Math.max(0, now - solo.startAt);
      const pass = Math.floor(t / lap);
      if (this.cur !== solo || this.pass !== pass) this.setup(solo, pass);
      this.showing = -1;
      return this.run(solo, Math.min(t - pass * lap, solo.tl.wall));
    }
    const elapsed = now - this.startAt;
    const loop = Math.floor(elapsed / this.loopWall);
    let t = elapsed - loop * this.loopWall;
    const n = this.clips.length;
    for (let i = 0; i < n; i++) {
      const p = this.clips[i]!;
      const pass = loop * n + i;
      if (t < FLIGHT_S) {
        const from = this.clips[(i + n - 1) % n]!.clip;
        this.fly(from, p.clip, t / FLIGHT_S);
        if (this.cur !== p || this.pass !== pass) this.setup(p, pass);
        this.showing = -1;
        return 0;
      }
      t -= FLIGHT_S;
      if (t < p.tl.wall) {
        if (this.cur !== p || this.pass !== pass) {
          if (t > JOIN_LATE) {
            this.fly(p.clip, p.clip, 1);
            this.showing = -1;
            return 0;
          }
          this.setup(p, pass);
        }
        this.showing = i;
        return this.run(p, t);
      }
      t -= p.tl.wall;
    }
    return 0;
  }

  /**
   * The reel's camera this frame: the subject's thrown driver's ride-along over everything, then the crash cam (on `probe`
   * while a ride holds `camera`: its bars and clock run on), then the clip's shot or the flight.
   */
  aim(camera: THREE.PerspectiveCamera, probe: THREE.PerspectiveCamera, wallDt: number, crash: Pick<CrashCam, "direct">): void {
    const subject = this.focus();
    const ride = subject !== null && this.host.ride(camera, wallDt, subject);
    const cut = crash.direct(ride ? probe : camera, wallDt, true, this.crashHold());
    if (!ride && !cut) this.camera(camera);
  }

  /** The reel's camera when the crash cam does not hold it: the flight, or the clip's current shot. */
  camera(cam: THREE.PerspectiveCamera): void {
    if (this.flying) {
      const f = this.flight;
      overheadPose(cam, f.ax, f.az, f.bx, f.bz, f.u);
      return;
    }
    const p = this.cur;
    if (!p) return;
    const shot = p.shots[Math.max(0, this.shot)]!;
    if (shot.ctx) contextPose(cam, shot.ctx.eye, shot.ctx.aim, shot.ctx.fov);
    else this.shotCam.pose(cam, p.sim.cars[p.clip.focus]!, shot, p.sim.heading);
  }

  /** The car the shot follows (the sun's shadow box goes with it); null in a flight. */
  focus(): DeformableCar | null {
    const p = this.cur;
    return p && !this.flying ? p.sim.cars[p.clip.focus]! : null;
  }

  /** The crash cam's view of the clip: its focus car's aim point, the scene's solids, and until when its hit is to come; null in a flight. */
  crashHold(): CrashHold | null {
    const car = this.focus();
    if (!car) return null;
    const p = car.group.position;
    this.hold.target.set(p.x, p.y + CINE.aimUp, p.z);
    const tl = this.cur!.tl;
    this.hold.hit = tl.contact - tl.impact + HIT_KEEP;
    return this.hold;
  }

  hud(): { reel: ReelHud | null; solo: string | null; shown: number | null } {
    return {
      reel:
        this.clips.length > 0
          ? {
              clips: this.clips.map((p, i) => ({ title: clipTitle(p.clip), score: p.clip.score, cars: p.clip.cars.length, saved: this.saved.get(i) ?? null })),
              playing: this.showing,
            }
          : null,
      solo: this.solo ? clipTitle(this.solo.clip) : null,
      shown: this.solo ? this.solo.id : this.showing >= 0 ? (this.clips[this.showing]?.id ?? null) : null,
    };
  }

  private prepare(clip: HighlightClip, rand: () => number, from: Prepared["from"]): Prepared {
    const sim = new ClipSim(clip, this.host.carsOf(clip), this.host.scene);
    // The clip's own throws (its scope's, `ClipEjection.own`), each at the end of its step, where `ClipSim.take` hands it over.
    const ends = clip.ejections.map((x) => {
      let at = 0;
      for (let s = 0; s <= x.step; s++) at += clip.h[s]!;
      return at;
    });
    const throws = ends.filter((_, i) => clip.ejections[i]!.own);
    const tl = clipTimeline(clip.firstImpact, sim.length, throws);
    return { id: ++this.serial, from, clip, sim, tl, shots: shotsFor(clip, tl, rand, () => this.host.still()) };
  }

  private soloOf(p: Prepared, now: number, back: () => void): void {
    this.solo = { ...p, startAt: now, back };
    this.cur = null;
  }

  private fly(a: HighlightClip, b: HighlightClip, u: number): void {
    this.flying = true;
    const f = this.flight;
    f.ax = a.x;
    f.az = a.z;
    f.bx = b.x;
    f.bz = b.z;
    f.u = u;
  }

  /** Clip `p`'s cars respawned at its start, every other car hidden. */
  private setup(p: Prepared, pass: number): void {
    this.cur = p;
    this.pass = pass;
    this.shot = -1;
    this.began = false;
    this.met = false;
    this.fudgedAt = -Infinity;
    this.host.resetProps();
    // The race's leftovers, torn parts of the cars hidden next and any dummy included, stay out of the clip; the clip's cars respawn after.
    this.host.clear();
    for (const c of this.host.live()) c.group.visible = false;
    p.sim.restart();
    this.presentedAt = 0;
  }

  /** Clip `p` at wall `w` s into its timeline. */
  private run(p: Prepared, w: number): number {
    this.flying = false;
    const { tl, sim, shots } = p;
    const k = Math.min(Math.floor(w / TL_DT), tl.phase.length - 1);
    const c = this.host.clock;
    // The crash cam's cuts follow the clip's hold (`crashCamEnd`) from its start on.
    c.hold = tl.hold;
    if (!this.began && w >= tl.impact) {
      this.began = true;
      this.lookahead(p);
      this.firstHit(p);
      this.host.crash(_c, _n);
    }
    if (!this.met && w >= tl.contact) {
      this.met = true;
      this.firstHit(p);
      this.host.impact(_c, _n, p.clip.peakKph / 3.6);
    }
    // The host's flash and burst (`beginCinematic`) restarted its clock: the timeline's own state goes in after it.
    c.phase = tl.phase[k]!;
    c.timeScale = tl.scale[k]!;
    c.targetScale = c.timeScale;
    c.wallSinceImpact = w >= tl.contact ? w - tl.contact : 0;
    if (w >= tl.onset && w < tl.contact && w - this.fudgedAt >= FUDGE_GAP) {
      this.fudgedAt = w;
      this.firstHit(p);
      this.host.fudge(_c.setY(_c.y + 0.4), _n);
    }
    const target = simAt(tl, w);
    const deadline = performance.now() + this.stepBudgetMs;
    // Each shot is framed from the car as drawn at the shot's own clip time: every peer picks the same.
    while (this.shot + 1 < shots.length && shots[this.shot + 1]!.at <= target) {
      const next = shots[this.shot + 1]!;
      sim.advanceTo(next.at, deadline);
      this.launch(p);
      if (!sim.done && sim.time < next.at - 1e-9) return 0;
      sim.present(next.at);
      this.shot++;
      this.frameShot(p, next);
    }
    sim.advanceTo(target, deadline);
    this.launch(p);
    sim.present(target);
    const shownTo = Math.min(target, sim.time);
    // A seek back (the replay restarts from a keyframe) shows no time passing; the next frame counts from there.
    const shown = shownTo >= this.presentedAt ? shownTo - this.presentedAt : 0;
    this.presentedAt = shownTo;
    const hit = sim.world.strongest;
    if (hit.contact && hit.normal && hit.impulse > 1.2 && performance.now() / 1000 - this.sparkAt > SPARK_GAP) {
      this.sparkAt = performance.now() / 1000;
      this.host.hit(hit.contact, hit.normal, hit.impulse);
    }
    return shown;
  }

  /**
   * The dummies the clip's steps threw since the last look fly; a driver thrown in the clip's scope (`ClipEjection.own`) gets
   * the ride-along, the subject's or not, so his launch is on screen. One thrown in another crash of the clip's steps is not its own.
   */
  private launch(p: Prepared): void {
    for (const e of p.sim.take()) this.host.eject(e, e.own);
  }

  private frameShot(p: Prepared, s: Shot): void {
    const { clip, sim } = p;
    if (s.ctx) return;
    const car = sim.cars[clip.focus]!;
    const cam = this.shotCam;
    cam.frame(s, car, this.host.sight(car), clip.x, clip.z);
    if (!s.hit) return;
    // The shot the cars meet in: its spot must see where they will meet (the record says where), else it is the chase.
    const still = this.host.still();
    if (!cam.sees(still, hitAim(_c, clip.x, sim.cars[clip.firstA]!.group.position.y, clip.z, still))) cam.found = false;
  }

  /** Clip `p`'s first impact: `_c` its recorded point (at the first car's height), `_n` the flat line the cars meet along (the car's heading if it hit alone). */
  private firstHit(p: Prepared): void {
    const { clip, sim } = p;
    const a = sim.cars[clip.firstA]!.group.position;
    const b = clip.firstB >= 0 ? sim.cars[clip.firstB]!.group.position : null;
    if (b) _n.set(b.x - a.x, 0, b.z - a.z);
    else _n.set(sim.cars[clip.firstA]!.velocity.x, 0, sim.cars[clip.firstA]!.velocity.z);
    if (_n.lengthSq() < 1e-6) _n.set(1, 0, 0);
    _n.normalize();
    _c.set(clip.x, a.y, clip.z);
  }

  /** The clip's impacts after its first that come before the crash cam hands back (`CrashHold.later`), wall s into the crash cam, where each lands. */
  private lookahead(p: Prepared): void {
    const { clip, tl } = p;
    const l = this.hold.later;
    l.n = 0;
    if (clip.hits.length < 2) return;
    const end = crashCamEnd(tl.hold);
    const s = this.host.still();
    for (let k = 1; k < clip.hits.length; k++) {
      const h = clip.hits[k]!;
      const w = wallAt(tl, shownFrom(clip, h.t)) - tl.impact;
      if (w >= end) break;
      l.from[l.n] = w - HIT_LEAD;
      l.until[l.n] = w + HIT_KEEP;
      hitAim(l.at[l.n]!, h.x, h.y, h.z, s);
      l.n++;
    }
  }
}
