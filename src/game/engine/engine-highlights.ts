import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import type { Ejection } from "../vehicle/ejection.ts";
import { beginImpact, CONTACT_HOLD, easeTimeScale, phaseClock, PRE_IMPACT_LEAD, SLOMO_HOLD, stepPhase, THROW_HOLD, type CrashPhase, type PhaseClock } from "../match/phase.ts";
import { clipTitle, ownThrow, type HighlightClip, type Reel } from "../match/highlights.ts";
import type { ReelHud, SaveResult, ViewBox } from "../match/types.ts";
import { mulberry32 } from "../world/placements.ts";
import { AFTERS, OPENERS, pickShot, RUN_INS, ShotCam, type Shot as PickedShot, type ShotKind } from "../present/shot-cam.ts";
import { CINE, type Sight } from "../present/spectate-cam.ts";
import { crashCamEnd, hitAim, type CrashCam, type CrashHold } from "../present/engine-cine.ts";
import { overheadPose } from "../present/highlight-cam.ts";
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

/** A clip's wall timeline from the phase.ts slow-mo: per `TL_DT` the clip time, the time scale and the crash phase. */
type Timeline = {
  /** Wall seconds the clip plays. */
  wall: number;
  sim: Float64Array;
  scale: Float32Array;
  phase: CrashPhase[];
  /** Wall s of the hit: slow-mo begins `PRE_IMPACT_LEAD` sim s before the recorded first impact. */
  impact: number;
  /** Wall s of the recorded first impact itself (the cars meet). */
  contact: number;
  /** Wall s from `impact` to the slow-mo's hand-back to 1× (or to the clip's end, if it comes first). */
  hold: number;
};

/**
 * The phase clock run at fixed wall steps over a `length` s clip: 1× to the impact, the auto slow-mo held over the cars
 * meeting and every throw (clip s, in order) that comes while it runs, then back to 1×.
 */
export function clipTimeline(firstImpact: number, length: number, throws: readonly number[]): Timeline {
  const c = phaseClock();
  // The slow-mo holds until the cars meeting sets its hand-back.
  c.hold = Infinity;
  const lead = firstImpact - PRE_IMPACT_LEAD;
  const sim: number[] = [];
  const scale: number[] = [];
  const phase: CrashPhase[] = [];
  let impact = Infinity;
  let contact = Infinity;
  let next = 0;
  for (let t = 0; ; ) {
    if (c.phase === "approach" && t >= lead) {
      beginImpact(c, true);
      impact = sim.length * TL_DT;
    }
    if (contact === Infinity && t >= firstImpact) {
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
  const hold = (back < 0 ? sim.length - 1 : back) * TL_DT - impact;
  return { wall: (sim.length - 1) * TL_DT, sim: Float64Array.from(sim), scale: Float32Array.from(scale), phase, impact, contact, hold };
}

/** Clip time at wall `w` s into the timeline. */
export function simAt(tl: Timeline, w: number): number {
  const k = Math.max(0, w) / TL_DT;
  const i = Math.min(Math.floor(k), tl.sim.length - 1);
  const j = Math.min(i + 1, tl.sim.length - 1);
  return tl.sim[i]! + (tl.sim[j]! - tl.sim[i]!) * Math.min(1, k - i);
}

/** A camera from clip time `at`: a picked shot (`present/shot-cam.ts`, the director the Auto spectator cam shares); `hit`: the cars meet while it is on. */
type Shot = PickedShot & { at: number; hit: boolean };

/**
 * A clip's shots, picked from the reel's seed (docs/HIGHLIGHTS.md "Cameras"): an opener, a run-in about a second before
 * the hit (the crash cam takes the hit itself), and the aftermath once the crash cam hands back. Same seed, same shots.
 */
function shotsFor(clip: HighlightClip, tl: Timeline, rand: () => number): Shot[] {
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
  return shots;
}

/**
 * `camera`'s lens over the canvas box `view` with the results sheet's box `cover` over part of it (null: none). The lens
 * frames the largest strip of the canvas beside the sheet as if that strip were the screen (its aspect, the projection
 * centre at its middle) and the rest of the canvas shows what lies past the strip's edges: the reel's cameras centre
 * their subject, so it plays in the part of the view the sheet leaves free.
 */
export function coverLens(camera: THREE.PerspectiveCamera, view: ViewBox, cover: ViewBox | null): void {
  const w = Math.max(1, view.right - view.left);
  const h = Math.max(1, view.bottom - view.top);
  let x = 0;
  let y = 0;
  let fw = w;
  let fh = h;
  if (cover) {
    const clamp = THREE.MathUtils.clamp;
    const l = clamp(cover.left - view.left, 0, w);
    const r = clamp(cover.right - view.left, 0, w);
    const t = clamp(cover.top - view.top, 0, h);
    const b = clamp(cover.bottom - view.top, 0, h);
    // The strips left of, right of, above and below the sheet: the largest is the frame.
    const best = Math.max(l * h, (w - r) * h, t * w, (h - b) * w);
    if (r > l && b > t && best > 0) {
      if (best === l * h) fw = l;
      else if (best === (w - r) * h) [x, fw] = [r, w - r];
      else if (best === t * w) fh = t;
      else [y, fh] = [b, h - b];
    }
  }
  camera.aspect = fw / fh;
  if (fw < w || fh < h) camera.setViewOffset(fw, fh, -x, -y, w, h);
  else camera.clearViewOffset();
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
  /** A clip's first impact as its slow-mo begins: the crash cam, flash and burst. */
  impact(contact: THREE.Vector3, normal: THREE.Vector3, closing: number): void;
  /** A replay's car–car hit: sparks. */
  hit(contact: THREE.Vector3, normal: THREE.Vector3, impulse: number): void;
  /** A driver in the clip was thrown out (`ClipSim.take`, `e.car` the engine slot): his dummy flies, from the recording's numbers; `ride`: he was thrown in the clip's own crash, so the camera follows his flight (only such a driver is ever framed by the ride). */
  eject(e: Ejection, ride: boolean): void;
  /** The thrown drivers' ride-along places `camera` on them this frame (`subject`: the clip's focus car); false when no ride is on. */
  ride(camera: THREE.PerspectiveCamera, wallDt: number, subject: DeformableCar): boolean;
};

type Prepared = { clip: HighlightClip; sim: ClipSim; tl: Timeline; shots: Shot[] };
type Solo = Prepared & { startAt: number; back: () => void };

const _c = new THREE.Vector3();
const _n = new THREE.Vector3();

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
  private impacted = false;
  private sparkAt = -Infinity;
  /** Reel clip on screen, −1 in a flight. */
  private showing = -1;
  private flying = false;
  private readonly flight = { ax: 0, az: 0, bx: 0, bz: 0, u: 0 };
  private readonly shotCam = new ShotCam();
  /** What the held crash cam asks about the clip's focus car (`crashHold`). */
  private readonly hold: CrashHold = { target: new THREE.Vector3(), sight: () => this.host.sight(this.focus()!), hit: 0 };
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

  /** Play `reel` from `startAt` on, looping, replacing any reel. */
  play(reel: Reel, startAt: number): void {
    this.stop();
    if (reel.clips.length === 0) return;
    this.clips = reel.clips.map((clip, i) => this.prepare(clip, mulberry32(reel.seed ^ Math.imul(i + 1, 0x9e3779b9))));
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
    this.soloOf(this.prepare(clip, mulberry32(Math.floor(clip.score * 1000))), now, back);
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
    this.shotCam.pose(cam, p.sim.cars[p.clip.focus]!, p.shots[Math.max(0, this.shot)]!, p.sim.heading);
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

  hud(): { reel: ReelHud | null; solo: string | null } {
    return {
      reel:
        this.clips.length > 0
          ? {
              clips: this.clips.map((p, i) => ({ title: clipTitle(p.clip), score: p.clip.score, cars: p.clip.cars.length, saved: this.saved.get(i) ?? null })),
              playing: this.showing,
            }
          : null,
      solo: this.solo ? clipTitle(this.solo.clip) : null,
    };
  }

  private prepare(clip: HighlightClip, rand: () => number): Prepared {
    const sim = new ClipSim(clip, this.host.carsOf(clip), this.host.scene);
    // The clip's own throws (`ownThrow`), each at the end of its step, where `ClipSim.take` hands it over.
    const ends = clip.ejections.map((x) => {
      let at = 0;
      for (let s = 0; s <= x.step; s++) at += clip.h[s]!;
      return at;
    });
    const throws = ends.filter((at, i) => ownThrow(clip, at, clip.ejections[i]!.e.pos.x, clip.ejections[i]!.e.pos.z));
    const tl = clipTimeline(clip.firstImpact, sim.length, throws);
    return { clip, sim, tl, shots: shotsFor(clip, tl, rand) };
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
    this.impacted = false;
    this.host.resetProps();
    // The race's leftovers, torn parts of the cars hidden next and any dummy included, stay out of the clip; the clip's cars respawn after.
    this.host.clear();
    for (const c of this.host.live()) c.group.visible = false;
    p.sim.restart();
  }

  /** Clip `p` at wall `w` s into its timeline. */
  private run(p: Prepared, w: number): number {
    this.flying = false;
    const { tl, sim, shots } = p;
    const k = Math.min(Math.floor(w / TL_DT), tl.phase.length - 1);
    const c = this.host.clock;
    c.phase = tl.phase[k]!;
    c.timeScale = tl.scale[k]!;
    c.targetScale = c.timeScale;
    c.wallSinceImpact = w >= tl.impact ? w - tl.impact : 0;
    // The crash cam's cuts follow the clip's hold (`crashCamEnd`) from the hit on.
    c.hold = tl.hold;
    if (!this.impacted && w >= tl.impact) {
      this.impacted = true;
      this.impact(p);
    }
    const target = simAt(tl, w);
    const before = sim.time;
    const deadline = performance.now() + this.stepBudgetMs;
    // Each shot is framed from the car as drawn at the shot's own clip time: every peer picks the same.
    while (this.shot + 1 < shots.length && shots[this.shot + 1]!.at <= target) {
      const next = shots[this.shot + 1]!;
      sim.advanceTo(next.at, deadline);
      this.launch(p);
      if (!sim.done && sim.time < next.at - 1e-9) return sim.time - before;
      sim.present(next.at);
      this.shot++;
      this.frameShot(p, next);
    }
    sim.advanceTo(target, deadline);
    this.launch(p);
    sim.present(target);
    const hit = sim.world.strongest;
    if (hit.contact && hit.normal && hit.impulse > 1.2 && performance.now() / 1000 - this.sparkAt > SPARK_GAP) {
      this.sparkAt = performance.now() / 1000;
      this.host.hit(hit.contact, hit.normal, hit.impulse);
    }
    return sim.time - before;
  }

  /**
   * The dummies the clip's steps threw since the last look fly; a driver thrown in the clip's own crash (`ownThrow`) gets
   * the ride-along, the subject's or not, so his launch is on screen. One thrown before it, or far off in its tail, is another crash's.
   */
  private launch(p: Prepared): void {
    for (const e of p.sim.take()) this.host.eject(e, ownThrow(p.clip, p.sim.time, e.pos.x, e.pos.z));
  }

  private frameShot(p: Prepared, s: Shot): void {
    const { clip, sim } = p;
    const car = sim.cars[clip.focus]!;
    const cam = this.shotCam;
    cam.frame(s, car, this.host.sight(car), clip.x, clip.z);
    if (!s.hit) return;
    // The shot the cars meet in: its spot must see where they will meet (the record says where), else it is the chase.
    const still = this.host.still();
    if (!cam.sees(still, hitAim(_c, clip.x, sim.cars[clip.firstA]!.group.position.y, clip.z, still))) cam.found = false;
  }

  private impact(p: Prepared): void {
    const { clip, sim } = p;
    const a = sim.cars[clip.firstA]!.group.position;
    const b = clip.firstB >= 0 ? sim.cars[clip.firstB]!.group.position : null;
    if (b) _n.set(b.x - a.x, 0, b.z - a.z);
    else _n.set(sim.cars[clip.firstA]!.velocity.x, 0, sim.cars[clip.firstA]!.velocity.z);
    if (_n.lengthSq() < 1e-6) _n.set(1, 0, 0);
    _n.normalize();
    this.host.impact(_c.set(clip.x, a.y, clip.z), _n, clip.peakKph / 3.6);
  }
}
