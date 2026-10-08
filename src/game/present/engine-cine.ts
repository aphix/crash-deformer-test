import { hypot2 } from "../kernel/physics-core.js";
import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import { DRIVE } from "../vehicle/car-drive.ts";
import type { ChaseCamera } from "./engine-camera.ts";
import { TireSmokeSystem, type GlassDotSystem, type SparkSystem } from "./engine-fx.ts";
import { SkidMarks } from "./engine-marks.ts";
import { PostFX, type FxTier } from "./engine-post.ts";
import { GpuTimer } from "./gpu-timer.ts";
import { inFrame } from "./highlight-cam.ts";
import { camUsable, type Sight } from "./spectate-cam.ts";
import type { Ultra } from "./ultra/ultra.ts";
import { FX_REACH, type Witness } from "./witness.ts";
import { NO_FLOOR } from "../world/ground.ts";
import { SLOMO_HOLD } from "../match/phase.ts";

/** Mark-map edge (texels) per tier: 2048 over the 96 m sandbox is 4.7 cm a texel. */
const MARK_RES: Record<FxTier, number> = { off: 0, minimal: 1024, low: 1024, high: 2048, ultra: 2048 };

/** Per-frame speed change (m/s) of one car that counts as a hit, and where it is full strength. */
const HIT_DV = 4.5;
const HIT_FULL = 14;
/** Hit-stop: wall seconds of near-freeze on the driven car's big hits, and the sim rate during it. */
const HIT_STOP = 0.09;
const HIT_STOP_SCALE = 0.05;

/** Crash cam: cut times (wall s after the first impact) for the three replay angles, then hand back, under the sandbox's `SLOMO_HOLD`. */
export const CUTS = [1.3, 2.9, 4.5, 6.1] as const;
/**
 * Wall s after the impact when the crash cam hands the camera back (`direct` false again) under a slow-mo held `hold` wall s:
 * `CUTS[3]`, later by as much as a longer hold (a highlight reel's) runs, so the cuts stay on the hit until the slow-mo hands back.
 */
export function crashCamEnd(hold: number): number {
  return CUTS[3] + Math.max(0, hold - SLOMO_HOLD);
}

const DUST = new THREE.Color(0.78, 0.64, 0.46);
const TURF = new THREE.Color(0.5, 0.58, 0.36);

const _v = new THREE.Vector3();
const _side = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _eye = new THREE.Vector3();
/** The hit holds still: `camUsable`'s target velocity for a crash-cam eye. */
const STILL = { x: 0, y: 0, z: 0 };
/** Crash cam: it aims this high (m) over the ground at the impact. */
const AIM_UP = 0.55;
/** Impact-axis turns (cos, sin) tried in order for a clear crash cam: as hit, reversed, then the quarter turns. */
const TURNS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;
/** Shares of a crash-cam eye's flat offset from the hit tried in order, the eye pulled in toward a hit by a wall. */
const REACH = [1, 0.75, 0.55, 0.35] as const;
/** No pulled-in eye stands closer (m, flat) to the hit: the cars are not in the sight lines, and a closer one sat under the wreck. */
const REACH_MIN = 3;
/** Times through a cut (start to end, the middle among them) at which an eye must be usable. */
const CUT_SAMPLES = 9;
/** The crash cam's pick spends this many `camUsable` calls a wall second (about 15 % of a frame), and finishes whatever is left this long (s) before its first cut. */
const PICK_RATE = 1000;
const PICK_DEADLINE = 0.05;
/** A reel's held crash cam prefers the crane (widest, highest, the cut least often in the way), then the long lens, then the bumper cam. */
const HOLD_ORDER = [1, 2, 0] as const;
/** A held eye's room and sight are asked again this often (wall s): `camUsable` costs about 0.15 ms a call. */
const HOLD_CHECK = 0.25;
/** The held cam turns toward its car this fast (1/s). */
const HOLD_AIM = 4;

/**
 * The crash cam's eye at `t` (`CUTS[0]` ≤ t < `CUTS[3]`) about impact point `at` and axis `n`, its flat offset from
 * `at` scaled by `reach`; returns its lens (deg).
 */
export function crashEye(out: THREE.Vector3, t: number, at: THREE.Vector3, n: THREE.Vector3, drift: number, reach: number): number {
  _side.crossVectors(n, _up);
  const floor = at.y - AIM_UP;
  let fov: number;
  if (t < CUTS[1]) {
    // Bumper cam: low and side-on to the impact axis, creeping along it.
    out.copy(at).addScaledVector(_side, 5.4).addScaledVector(n, -1.1 + (t - CUTS[0]) * drift * 0.4);
    out.y = floor + 0.32;
    fov = 34;
  } else if (t < CUTS[2]) {
    // Crane: high over the wreck, turning slowly.
    const a = Math.atan2(_side.x, _side.z) + 0.7 + (t - CUTS[1]) * 0.22 * drift;
    out.set(at.x + Math.sin(a) * 6.5, floor + 7.2, at.z + Math.cos(a) * 6.5);
    fov = 46;
  } else {
    // Long lens from a quarter angle, panning a touch.
    _v.copy(_side).multiplyScalar(0.72).addScaledVector(n, -0.7).normalize();
    out.copy(at).addScaledVector(_v, 19).addScaledVector(_side, (t - CUTS[2]) * 0.6 * drift);
    out.y = floor + 1.5;
    fov = 21;
  }
  out.x = at.x + (out.x - at.x) * reach;
  out.z = at.z + (out.z - at.z) * reach;
  return fov;
}

/** Where a crash's camera aims at a hit at (x, z) by a car at height `y`: `AIM_UP` over the car, or over the ground there (on a course, `sight`) when the car is no higher. */
export function hitAim(out: THREE.Vector3, x: number, y: number, z: number, sight: Sight | null): THREE.Vector3 {
  const g = sight ? sight.ground.heightAt(x, z, y + 1) : 0;
  return out.set(x, (g === NO_FLOOR ? y : Math.max(g, y)) + AIM_UP, z);
}

/**
 * The crash cam's pick as a search that can pause between two `camUsable` calls (`run`): the cut eyes are only needed
 * `CUTS[0]` s after the hit, and the whole search, at 1-15 ms, would drop a frame at the impact. For each impact-axis turn
 * (`TURNS`; as hit, reversed, then the quarter turns) and each cut: the longest `REACH` whose eye is usable (`camUsable`:
 * `CLEAR.radius` m of room, in sight of `at`) at `CUT_SAMPLES` times from the cut's start to its end, the middle among them.
 * The eye pans and turns through its cut (a held cut stands at its start, a still one at its middle), so a spot only the middle
 * passes drifts into a wall or behind a corner: measured on the courses, 7 (stunt) to 74 (city) cuts lost their room or sight at
 * one end of a middle-only pick (engine-cine.test.ts). The axis kept is the turn whose cuts see `at` from furthest out (summed
 * reach), the first at full reach on all three. A race hit on a wall or beside one put the side-on eyes behind it: the replay
 * showed the wall's back, never the cars. The answer does not depend on how `run` is sliced.
 */
export class CrashPick {
  private s: Sight | null = null;
  private at = new THREE.Vector3();
  private n = new THREE.Vector3();
  private out: Float32Array = new Float32Array(3);
  private readonly base = new THREE.Vector3();
  private readonly axis = new THREE.Vector3();
  private readonly turnReach = new Float32Array(3);
  private readonly best = new THREE.Vector3();
  private readonly bestReach = new Float32Array(3);
  private most = -1;
  private turns = 0;
  private turn = 0;
  private cut = 0;
  private ri = 0;
  private i = 0;

  /** A search is under way (`begin` ran, `run` has not finished it). */
  get pending(): boolean {
    return this.s !== null;
  }

  /** Start a search over `turns` of `TURNS`; it leaves the chosen axis in `n` (turned in place) and each cut's reach in `reach` when `run` finishes it. */
  begin(s: Sight, at: THREE.Vector3, n: THREE.Vector3, reach: Float32Array, turns: number = TURNS.length): void {
    this.s = s;
    this.at = at;
    this.n = n;
    this.out = reach;
    this.base.copy(n);
    this.turns = turns;
    this.most = -1;
    this.turn = -1;
    this.nextTurn();
  }

  /** Drop an unfinished search. */
  cancel(): void {
    this.s = null;
  }

  /** Spend up to `units` `camUsable` calls (about 0.15 ms each) on the search; true when it is finished. */
  run(units: number): boolean {
    for (; this.s && units > 0; units--) this.step();
    return this.s === null;
  }

  private nextTurn(): void {
    this.turn++;
    const [c, sn] = TURNS[this.turn]!;
    this.axis.set(c * this.base.x - sn * this.base.z, 0, c * this.base.z + sn * this.base.x);
    this.turnReach.fill(0);
    this.cut = 0;
    this.ri = 0;
    this.i = 0;
  }

  /** One `camUsable` call (or the cheap distance check that ends a cut's search) on the current cut, reach and time. */
  private step(): void {
    const s = this.s!;
    const from = CUTS[this.cut]!;
    const span = CUTS[this.cut + 1]! - from;
    const r = REACH[this.ri]!;
    if (this.i === 0) {
      crashEye(_eye, from + span / 2, this.at, this.axis, 1, r);
      if (r < 1 && hypot2(_eye.x - this.at.x, _eye.z - this.at.z) < REACH_MIN) return this.nextCut();
    }
    crashEye(_eye, from + (span * this.i) / (CUT_SAMPLES - 1), this.at, this.axis, 1, r);
    if (!camUsable(s, _eye, this.at, STILL, 0)) {
      this.i = 0;
      if (++this.ri === REACH.length) this.nextCut();
      return;
    }
    if (++this.i < CUT_SAMPLES) return;
    this.turnReach[this.cut] = r;
    this.nextCut();
  }

  private nextCut(): void {
    this.i = 0;
    this.ri = 0;
    if (++this.cut < 3) return;
    const score = this.turnReach[0]! + this.turnReach[1]! + this.turnReach[2]!;
    if (score > this.most) {
      this.most = score;
      this.best.copy(this.axis);
      this.bestReach.set(this.turnReach);
    }
    if (score === 3 || this.turn + 1 === this.turns) {
      // A cut with no usable eye keeps `reach` 0: `direct` leaves that cut to the chase / reel camera.
      this.n.copy(this.best);
      this.out.set(this.bestReach);
      this.s = null;
    } else this.nextTurn();
  }
}

/**
 * The crash-cam cut a reel holds through one crash: `current` while its eye (still at the cut's start) is usable, that
 * is `CLEAR.radius` m of room round it and sight of `target` (`camUsable`), and of every impact of `later` from `ahead` on
 * (those still to come) with the impact before each in its frame as it turns to it (`inFrame`: the viewer keeps the place);
 * otherwise the first of `HOLD_ORDER` that is. When no cut sees every later impact so, the cuts that see
 * `target` alone count as before. -1 when none is (the reel camera keeps the shot). `reach`: `crashAxis`'s, 0 = no eye on that
 * cut. `hit`: the hit itself is still to come, so a cut whose eye sees it (`crashAxis` checked that eye's room and its sight
 * of `at`) holds even when no eye sees the car (a car in the way, the other car of a head-on): `current` if it has one, else the first.
 */
export function heldCut(s: Sight, at: THREE.Vector3, n: THREE.Vector3, reach: Float32Array, target: THREE.Vector3, current: number, hit = false, later: LaterHits = NO_LATER, ahead = 0): number {
  const usable = (cut: number, every: boolean): boolean => {
    if (reach[cut] === 0) return false;
    const fov = crashEye(_eye, CUTS[cut]!, at, n, 0, reach[cut]!);
    if (!camUsable(s, _eye, target, STILL, 0)) return false;
    if (every) for (let k = ahead; k < later.n; k++) if (!camUsable(s, _eye, later.at[k]!, STILL, 0) || !inFrame(_eye, later.at[k]!, k === 0 ? at : later.at[k - 1]!, fov)) return false;
    return true;
  };
  // First the cuts that see every impact still to come, then those that see the car alone.
  for (let pass = 0; pass < 2; pass++) {
    const every = pass === 0;
    if (every && ahead >= later.n) continue;
    if (current >= 0 && usable(current, every)) return current;
    for (const cut of HOLD_ORDER) if (cut !== current && usable(cut, every)) return cut;
  }
  if (!hit) return -1;
  if (current >= 0 && reach[current]! > 0) return current;
  for (const cut of HOLD_ORDER) if (reach[cut]! > 0) return cut;
  return -1;
}

/**
 * The impacts of a clip's scope after its first that fall inside the crash cam's window, in time order (`n` of them): per
 * impact the wall second (into the crash cam) the held cam starts to look at it and the one it stops, and where it lands.
 */
type LaterHits = { n: number; from: Float64Array; until: Float64Array; at: THREE.Vector3[] };

/** Room for `max` later impacts. */
export function laterHits(max: number): LaterHits {
  return { n: 0, from: new Float64Array(max), until: new Float64Array(max), at: Array.from({ length: max }, () => new THREE.Vector3()) };
}

const NO_LATER = laterHits(0);

/**
 * What a held crash cam asks of the reel clip: the point it aims at once the hit has landed (the clip's focus car; the hit
 * itself before), the scene's solids round it, built when asked, until when (wall s into the crash cam) the hit itself
 * is still to come (`heldCut`'s `hit`), and the clip's later impacts of the window (`LaterHits`): it looks at each as it comes.
 */
export type CrashHold = { target: THREE.Vector3; sight: () => Sight; hit: number; later: LaterHits };

/** What a held crash cam looks at `t` wall s in: the first hit until it has landed, a later impact from its `from` to its `until`, else the car. */
function holdAim(hold: CrashHold, at: THREE.Vector3, t: number): THREE.Vector3 {
  if (t < hold.hit) return at;
  const l = hold.later;
  for (let k = 0; k < l.n; k++) if (t >= l.from[k]! && t < l.until[k]!) return l.at[k]!;
  return hold.target;
}

/**
 * The Burnout-style crash cam: the camera half of `Cinematics`, with no GPU in it (the headless reel harness runs this very
 * one). From a hit (`begin`) it letterboxes in, takes the camera for its three replay cuts in slow-mo and hands it back at
 * `crashCamEnd` of the slow-mo's hold, its cuts spread evenly from `CUTS[0]` to then; in a reel (`direct`'s `hold`) it keeps one cut for the whole crash.
 */
export class CrashCam {
  /** Wall seconds into the crash cam; < 0 when it is not running. */
  camT = -1;
  /** The letterbox's share this frame (0 to 1), set by `direct`. */
  letterbox = 0;
  private readonly reduceMotion: boolean;
  private readonly camAt = new THREE.Vector3();
  private readonly camN = new THREE.Vector3(1, 0, 0);
  /** Per crash-cam cut: the share of its eye's offset from the hit that sees it (`crashAxis`). */
  private readonly camReach = new Float32Array([1, 1, 1]);
  private readonly pick = new CrashPick();
  /** A reel's held crash cam: the cut it stands on (-1 none usable), when it is asked again (`camT`), and where it aims. */
  private heldAt = -1;
  private held = -1;
  private aimSet = false;
  private readonly aim = new THREE.Vector3();
  /** Wall s into the crash cam at which it hands the camera back (`crashCamEnd` of `begin`'s hold). */
  private end: number = CUTS[3];

  constructor(reduceMotion: boolean) {
    this.reduceMotion = reduceMotion;
  }

  /**
   * The crash cam on a hit at `contact` along `normal`, its slow-mo held `hold` wall s. `sight` (a course): it stands on its
   * ground and turns its axis so its eyes see the hit.
   */
  begin(contact: THREE.Vector3, normal: THREE.Vector3, sight: Sight | null, hold: number): void {
    this.end = crashCamEnd(hold);
    hitAim(this.camAt, contact.x, contact.y, contact.z, sight);
    this.camN.set(normal.x, 0, normal.z);
    if (this.camN.lengthSq() < 1e-6) this.camN.set(1, 0, 0);
    this.camN.normalize();
    // On a course the pick runs over the lead-in frames (`direct`): no eye on any cut until it is done.
    this.camReach.fill(sight ? 0 : 1);
    if (sight) this.pick.begin(sight, this.camAt, this.camN, this.camReach);
    else this.pick.cancel();
    this.camT = 0;
    this.held = -1;
    this.heldAt = -1;
    this.aimSet = false;
  }

  /** Off, with no letterbox. */
  reset(): void {
    this.camT = -1;
    this.letterbox = 0;
  }

  /** The crash cam is on a cut (not just letterboxing in or out): it holds the camera this frame. */
  get cutting(): boolean {
    return this.camT >= CUTS[0] && this.camT < this.end;
  }

  /**
   * Takes the camera for the replay cuts. False when the orbit / chase camera should run. With `hold` (the results reel)
   * it keeps ONE cut for the whole crash, its eye where its cut begins, turning smoothly toward the car, and moves to
   * another only when its eye has no room or no sight of the car (`heldCut`); no usable eye: the reel camera.
   */
  direct(camera: THREE.PerspectiveCamera, wallDt: number, allowed: boolean, hold: CrashHold | null = null): boolean {
    if (this.camT < 0) return false;
    if (!allowed) this.camT = -1;
    else this.camT += wallDt;
    const t = this.camT;
    const end = this.end;
    this.letterbox = t < 0 ? 0 : t < CUTS[0] ? THREE.MathUtils.clamp(t / 0.4, 0, 1) : t < end ? 1 : Math.max(0, 1 - (t - end) / 0.5);
    if (t < 0 || t >= end + 0.5) {
      this.camT = -1;
      this.pick.cancel();
      this.letterbox = 0;
      return false;
    }
    if (this.pick.pending) this.pick.run(t >= CUTS[0] - PICK_DEADLINE ? Infinity : wallDt * PICK_RATE);
    if (t < CUTS[0] || t >= end) return false;
    // Where wall `t` falls on the `CUTS` schedule, stretched from `CUTS[0]` to the hand-back.
    const u = CUTS[0] + ((t - CUTS[0]) * (CUTS[3] - CUTS[0])) / (end - CUTS[0]);
    let cut = u < CUTS[1] ? 0 : u < CUTS[2] ? 1 : 2;
    let eyeT = u;
    let aim = this.camAt;
    if (hold) {
      if (t >= this.heldAt) {
        this.heldAt = t + HOLD_CHECK;
        let ahead = 0;
        while (ahead < hold.later.n && hold.later.until[ahead]! <= t) ahead++;
        this.held = heldCut(hold.sight(), this.camAt, this.camN, this.camReach, hold.target, this.held, t < hold.hit, hold.later, ahead);
      }
      cut = this.held;
      eyeT = cut < 0 ? u : CUTS[cut]!;
      // The hit itself until it has landed (the reel's moment, framed at the lens's centre), each later impact of the window as it comes, else the car.
      const want = holdAim(hold, this.camAt, t);
      if (this.aimSet) this.aim.lerp(want, 1 - Math.exp(-wallDt * HOLD_AIM));
      else this.aim.copy(want);
      this.aimSet = true;
      aim = this.aim;
    }
    // No usable eye on this cut (a wall or a building in the way, all round): the chase / reel camera keeps the shot.
    if (cut < 0 || this.camReach[cut] === 0) return false;
    const fov = crashEye(camera.position, eyeT, this.camAt, this.camN, this.reduceMotion ? 0 : 1, this.camReach[cut]!);
    camera.lookAt(aim);
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    return true;
  }
}

type FxRefs = { sparks: SparkSystem; glass: GlassDotSystem; witness: Witness };

/**
 * Cinematic director: the quality tier, the post chain, the tyre-mark map and every effect that only reads
 * sim state: impact punch (shake, FOV kick, flash, chromatic split), hit-stop on the driven car's big hits,
 * the Burnout-style crash cam (three cut angles in slow-mo, letterboxed), boost radial blur, tyre smoke
 * and hub-scrape sparks from wheel slip. Reduced motion: no shake, flash, punch, blur or camera moves.
 */
export class Cinematics {
  readonly post: PostFX;
  readonly marks: SkidMarks;
  /** Thin wide tyre smoke, separate from the dense crash plumes. */
  readonly tyreSmoke: TireSmokeSystem;
  private tierNow: FxTier = "off";
  /** The Ultra look, once loaded (`CrashEngine.loadUltra`); the tier "ultra" needs it. */
  ultra: Ultra | null = null;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly view: ChaseCamera;
  private readonly fx: FxRefs;
  private readonly reduceMotion: boolean;
  private readonly pvx: Float32Array;
  private readonly pvz: Float32Array;
  private readonly hitCool: Float32Array;
  private readonly smokeAcc: Float32Array;
  private readonly sparkAcc: Float32Array;
  private havePrev = false;
  private hitStop = 0;
  private flash = 0;
  private punch = 0;
  /** The crash cam (the camera half of the crash): `impact` starts it, `direct` runs it. */
  readonly crash: CrashCam;
  private readonly gpu: GpuTimer | null;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, view: ChaseCamera, fx: FxRefs, maxCars: number, reduceMotion: boolean) {
    this.renderer = renderer;
    this.gpu = GpuTimer.create(renderer.getContext() as WebGL2RenderingContext);
    this.view = view;
    this.fx = fx;
    this.reduceMotion = reduceMotion;
    this.crash = new CrashCam(reduceMotion);
    this.post = new PostFX(renderer);
    this.marks = new SkidMarks(maxCars);
    this.tyreSmoke = new TireSmokeSystem(scene, 360, true);
    this.pvx = new Float32Array(maxCars);
    this.pvz = new Float32Array(maxCars);
    this.hitCool = new Float32Array(maxCars);
    this.smokeAcc = new Float32Array(maxCars * 4);
    this.sparkAcc = new Float32Array(maxCars * 4);
  }

  get tier(): FxTier {
    return this.tierNow;
  }

  setTier(tier: FxTier): void {
    if (tier === "ultra" && this.ultra === null) throw new Error("FX tier ultra needs the Ultra chunk: await CrashEngine.loadUltra() first");
    const was = this.tierNow;
    this.tierNow = tier;
    this.post.setTier(tier);
    this.marks.setResolution(MARK_RES[tier]);
    const on = tier !== "off";
    // Streaks and over-bright glow are for the bloom; the canvas-only tiers draw plain dots.
    const bloom = tier === "low" || tier === "high" || tier === "ultra";
    this.fx.sparks.streaked = bloom;
    this.fx.sparks.glow(bloom ? 2.6 : 1);
    this.fx.glass.glow(bloom ? 1.8 : 1);
    if (tier === "ultra") this.ultra!.enable();
    else if (was === "ultra") this.ultra?.disable();
    if (!on) this.reset();
  }

  /** Sim time multiplier for this frame: below 1 during a hit-stop. */
  get timeWarp(): number {
    return this.hitStop > 0 ? HIT_STOP_SCALE : 1;
  }

  /** Scene reset: wipe marks, drop the crash cam and hit history. */
  reset(): void {
    this.marks.clear();
    this.havePrev = false;
    this.hitStop = 0;
    this.flash = 0;
    this.punch = 0;
    this.crash.reset();
    this.post.flash = 0;
    this.post.punch = 0;
    this.post.radial = 0;
    this.post.letterbox = 0;
    this.smokeAcc.fill(0);
    this.sparkAcc.fill(0);
    this.tyreSmoke.reset();
  }

  /**
   * The first big impact of a crash run (fleet / barrier): punch, FOV kick and, unless the user framed the shot, the
   * crash cam, its cuts over a slow-mo held `hold` wall s. `sight` (a course): the crash cam stands on its ground and turns its axis so its eyes see the hit.
   */
  impact(contact: THREE.Vector3, normal: THREE.Vector3, impulse: number, crashCam: boolean, sight: Sight | null, hold: number): void {
    if (this.tierNow === "off") return;
    const k = THREE.MathUtils.clamp(impulse / 30, 0.35, 1);
    this.kick(k);
    if (crashCam) this.crash.begin(contact, normal, sight, hold);
  }

  /**
   * After the physics and FX steps: hits from each car's velocity jump, tyre marks / smoke / scrape sparks
   * from wheel slip, boost blur for the driven car, and the decay of every punch value.
   */
  update(wallDt: number, simDt: number, cars: readonly DeformableCar[], followed: DeformableCar | null, driving: boolean, fxDensity: number): void {
    if (this.tierNow === "off") return;
    this.hitStop = Math.max(0, this.hitStop - wallDt);
    if (simDt > 1e-5) this.detectHits(cars, followed, driving, wallDt);
    this.marks.update(cars, simDt);
    if (this.marks.slipping) this.emitSlipFx(cars.length, wallDt, fxDensity);
    this.tyreSmoke.update(Math.max(simDt, wallDt * 0.6), this.view.camera);

    this.flash = Math.max(0, this.flash - wallDt * 4);
    this.punch = Math.max(0, this.punch - wallDt * 2.2);
    const calm = this.reduceMotion;
    this.post.flash = calm ? 0 : this.flash;
    this.post.punch = calm ? 0 : this.punch;
    let radial = 0;
    if (!calm && driving && followed) {
      radial = THREE.MathUtils.clamp((followed.speed - DRIVE.maxFwd * 1.02) / (DRIVE.maxFwd * 0.4), 0, 1) * 0.05;
    }
    this.post.radial += (radial - this.post.radial) * Math.min(1, wallDt * 6);
  }

  /** The crash cam is on a cut (not just letterboxing in or out): it holds the camera this frame. */
  get cutting(): boolean {
    return this.crash.cutting;
  }

  /** The crash cam's `direct`, its letterbox drawn by the post chain. */
  direct(camera: THREE.PerspectiveCamera, wallDt: number, allowed: boolean, hold: CrashHold | null = null): boolean {
    const on = this.crash.direct(camera, wallDt, allowed, hold);
    this.post.letterbox = this.crash.letterbox;
    return on;
  }

  /** Stamp the mark map, then draw the frame through the post chain (timed on the GPU where the browser has a timer). */
  render(scene: THREE.Scene, camera: THREE.Camera, wallDt: number): void {
    this.gpu?.begin();
    this.marks.flush(this.renderer, wallDt);
    this.post.render(scene, camera);
    this.gpu?.end();
  }

  /** GPU ms of the newest finished draw since the last call; -1 when none finished or the browser has no timer. */
  gpuMs(): number {
    return this.gpu ? this.gpu.take() : -1;
  }

  dispose(): void {
    this.gpu?.dispose();
    this.ultra?.dispose();
    this.post.dispose();
    this.marks.dispose();
    this.tyreSmoke.dispose();
  }

  private kick(k: number): void {
    this.flash = Math.max(this.flash, 0.55 * k);
    this.punch = Math.max(this.punch, k);
    if (this.reduceMotion) return;
    this.view.trauma = Math.max(this.view.trauma, 0.35 + 0.55 * k);
    const cam = this.view.camera;
    cam.fov += 7 * k;
    cam.updateProjectionMatrix();
  }

  private detectHits(cars: readonly DeformableCar[], followed: DeformableCar | null, driving: boolean, wallDt: number): void {
    const n = Math.min(cars.length, this.pvx.length);
    for (let i = 0; i < n; i++) {
      const v = cars[i]!.velocity;
      const dv = hypot2(v.x - this.pvx[i]!, v.z - this.pvz[i]!);
      this.pvx[i] = v.x;
      this.pvz[i] = v.z;
      this.hitCool[i] = Math.max(0, this.hitCool[i]! - wallDt);
      if (!this.havePrev || dv < HIT_DV || this.hitCool[i]! > 0) continue;
      const k = THREE.MathUtils.clamp((dv - HIT_DV) / (HIT_FULL - HIT_DV), 0, 1);
      const mine = cars[i] === followed;
      if (!mine && (followed || k < 0.5)) continue;
      this.hitCool[i] = 0.3;
      this.kick(mine ? 0.3 + 0.7 * k : 0.25 * k);
      if (mine && driving && k > 0.3) this.hitStop = HIT_STOP;
    }
    this.havePrev = true;
  }

  /** Tyre smoke from every slipping wheel (surface-tinted) and sparks off a scraping hub. */
  private emitSlipFx(nCars: number, wallDt: number, fxDensity: number): void {
    const w = this.marks.wheels;
    const slots = Math.min(nCars * 4, w.slip.length);
    for (let s = 0; s < slots; s++) {
      const slip = w.slip[s]!;
      if (slip < 0.2) {
        this.smokeAcc[s] = 0;
        continue;
      }
      _v.set(w.px[s]!, 0.14, w.pz[s]!);
      if (!this.fx.witness.sees(_v, FX_REACH.smoke)) {
        this.smokeAcc[s] = 0;
        this.sparkAcc[s] = 0;
        continue;
      }
      this.smokeAcc[s]! += slip * slip * wallDt * 60 * fxDensity;
      if (this.smokeAcc[s]! >= 1) {
        const count = this.smokeAcc[s]! | 0;
        this.smokeAcc[s]! -= count;
        const ch = w.channel[s]!;
        _side.set(w.vx[s]!, 0, w.vz[s]!);
        this.tyreSmoke.emitAt(_v, _side, count, ch === 1 ? DUST : ch === 2 ? TURF : undefined);
      }
      if (!w.scrape[s]) continue;
      this.sparkAcc[s]! += wallDt * 70 * fxDensity;
      if (this.sparkAcc[s]! < 1) continue;
      const count = this.sparkAcc[s]! | 0;
      this.sparkAcc[s]! -= count;
      _side.set(w.vx[s]!, 0, w.vz[s]!).normalize();
      _v.y = 0.05;
      this.fx.sparks.poof(_v, _side, count);
    }
  }
}
