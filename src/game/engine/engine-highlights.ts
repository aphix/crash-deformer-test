import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import { beginImpact, easeTimeScale, phaseClock, PRE_IMPACT_LEAD, stepPhase, type CrashPhase, type PhaseClock } from "../match/phase.ts";
import { clipTitle, type HighlightClip, type Reel } from "../match/highlights.ts";
import type { ReelHud, SaveResult } from "../match/types.ts";
import { mulberry32 } from "../world/placements.ts";
import { CINE, CineCam, DUTCH, DutchCam, type Sight } from "../present/spectate-cam.ts";
import { CRASH_CAM_END } from "../present/engine-cine.ts";
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

/** A clip's wall timeline from the phase.ts slow-mo: per `TL_DT` the clip time, the time scale and the crash phase. */
type Timeline = {
  /** Wall seconds the clip plays. */
  wall: number;
  sim: Float64Array;
  scale: Float32Array;
  phase: CrashPhase[];
  /** Wall s of the hit: slow-mo begins `PRE_IMPACT_LEAD` sim s before the recorded first impact. */
  impact: number;
};

/** The phase clock run at fixed wall steps over a `length` s clip: 1× to the impact, the auto slow-mo, then back to 1×. */
export function clipTimeline(firstImpact: number, length: number): Timeline {
  const c = phaseClock();
  const lead = firstImpact - PRE_IMPACT_LEAD;
  const sim: number[] = [];
  const scale: number[] = [];
  const phase: CrashPhase[] = [];
  let impact = Infinity;
  for (let t = 0; ; ) {
    if (c.phase === "approach" && t >= lead) {
      beginImpact(c, true);
      impact = sim.length * TL_DT;
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
  return { wall: (sim.length - 1) * TL_DT, sim: Float64Array.from(sim), scale: Float32Array.from(scale), phase, impact };
}

/** Clip time at wall `w` s into the timeline. */
export function simAt(tl: Timeline, w: number): number {
  const k = Math.max(0, w) / TL_DT;
  const i = Math.min(Math.floor(k), tl.sim.length - 1);
  const j = Math.min(i + 1, tl.sim.length - 1);
  return tl.sim[i]! + (tl.sim[j]! - tl.sim[i]!) * Math.min(1, k - i);
}

type ShotKind = "chase" | "cine" | "dutch" | "high";
/** A camera from clip time `at`: its kind and the seeded picks it frames with. */
type Shot = { at: number; kind: ShotKind; mount: number; angle: number; seed: number };

const OPENERS: readonly ShotKind[] = ["chase", "cine", "high", "dutch"];
const RUN_INS: readonly ShotKind[] = ["cine", "dutch", "chase"];
const AFTERS: readonly ShotKind[] = ["high", "cine", "chase"];

/**
 * A clip's shots, picked from the reel's seed (docs/HIGHLIGHTS.md "Cameras"): an opener, a run-in about a second before
 * the hit (the crash cam takes the hit itself), and the aftermath once the crash cam hands back. Same seed, same shots.
 */
function shotsFor(clip: HighlightClip, tl: Timeline, rand: () => number): Shot[] {
  const shots: Shot[] = [];
  const add = (at: number, kinds: readonly ShotKind[]): void => {
    const prev = shots[shots.length - 1]?.kind;
    const pool = kinds.filter((k) => k !== prev);
    shots.push({ at, kind: pool[Math.floor(rand() * pool.length)]!, mount: Math.floor(rand() * 8), angle: rand() * Math.PI * 2, seed: Math.floor(rand() * 1e6) });
  };
  add(0, OPENERS);
  const runIn = clip.firstImpact - 1 - rand() * 0.8;
  if (runIn > 0.8) add(runIn, RUN_INS);
  const after = simAt(tl, tl.impact + CRASH_CAM_END);
  if (after < tl.sim[tl.sim.length - 1]!) add(after, AFTERS);
  return shots;
}

/** What the reel needs from the engine. */
export type ReelHost = {
  /** The cars a clip replays on, in its `cars` order. */
  carsOf(clip: HighlightClip): DeformableCar[];
  live(): readonly DeformableCar[];
  scene: ReplayScene;
  /** Every knocked prop back on its spot before a clip plays. */
  resetProps(): void;
  /** The course's solids with every visible car but `focus` (the cinematic eye's sight lines). */
  sight(focus: DeformableCar): Sight;
  /** The engine's crash clock: the reel mirrors its slow-mo into it (letterbox, HUD). */
  clock: PhaseClock;
  /** A clip's first impact as its slow-mo begins: the crash cam, flash and burst. */
  impact(contact: THREE.Vector3, normal: THREE.Vector3, closing: number): void;
  /** A replay's car–car hit: sparks. */
  hit(contact: THREE.Vector3, normal: THREE.Vector3, impulse: number): void;
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
  private readonly cine = new CineCam();
  private readonly dutch = new DutchCam();
  private cineFound = false;
  private readonly highEye = new THREE.Vector3();
  /** Every live car's visibility when the reel took them. */
  private shown: boolean[] | null = null;

  constructor(host: ReelHost) {
    this.host = host;
  }

  /** A results reel is set (it may not have started yet); a saved clip's solo view alone is not one. */
  get hasReel(): boolean {
    return this.clips.length > 0;
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
    }
    const c = this.host.clock;
    c.phase = "approach";
    c.timeScale = 1;
    c.targetScale = 1;
    c.wallSinceImpact = 0;
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

  /** The reel's camera when the crash cam does not hold it: the flight, or the clip's current shot. */
  camera(cam: THREE.PerspectiveCamera): void {
    if (this.flying) {
      const f = this.flight;
      overheadPose(cam, f.ax, f.az, f.bx, f.bz, f.u);
      return;
    }
    const p = this.cur;
    if (!p) return;
    const car = p.sim.cars[p.clip.focus]!;
    const pos = car.group.position;
    const shot = p.shots[Math.max(0, this.shot)]!;
    const kind = shot.kind;
    if (kind === "cine" && this.cineFound) {
      cam.position.copy(this.cine.eye);
      cam.lookAt(pos.x, pos.y + CINE.aimUp, pos.z);
      lens(cam, THREE.MathUtils.clamp(2 * THREE.MathUtils.radToDeg(Math.atan2(CINE.frame, this.cine.eye.distanceTo(pos))), CINE.fov[0]!, CINE.fov[1]!));
    } else if (kind === "dutch") {
      this.dutch.place(cam, car, shot.mount);
      lens(cam, DUTCH.fov);
    } else if (kind === "high") {
      cam.position.copy(this.highEye);
      cam.lookAt(pos.x, pos.y + CINE.aimUp, pos.z);
      lens(cam, 42);
    } else {
      // Chase (and a cine shot with no clear spot): behind the car along its travel.
      const v = car.velocity;
      const speed = Math.hypot(v.x, v.z);
      const fx = speed > 2 ? v.x / speed : car.fwdFlat.x;
      const fz = speed > 2 ? v.z / speed : car.fwdFlat.z;
      cam.position.set(pos.x - fx * 8, pos.y + 2.8, pos.z - fz * 8);
      cam.lookAt(pos.x + fx * 3, pos.y + 0.8, pos.z + fz * 3);
      lens(cam, 55);
    }
  }

  /** The car the shot follows (the sun's shadow box goes with it); null in a flight. */
  focus(): DeformableCar | null {
    const p = this.cur;
    return p && !this.flying ? p.sim.cars[p.clip.focus]! : null;
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
    const tl = clipTimeline(clip.firstImpact, sim.length);
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
    if (!this.impacted && w >= tl.impact) {
      this.impacted = true;
      this.impact(p);
    }
    const target = simAt(tl, w);
    const before = sim.time;
    const deadline = performance.now() + this.stepBudgetMs;
    // Each shot is framed from the car as it stands at the shot's own clip time: every peer picks the same.
    while (this.shot + 1 < shots.length && shots[this.shot + 1]!.at <= target) {
      const next = shots[this.shot + 1]!;
      sim.advanceTo(next.at, deadline);
      if (!sim.done && sim.time + sim.clip.h[sim.step]! <= next.at + 1e-9) return sim.time - before;
      this.shot++;
      this.frameShot(p, next);
    }
    sim.advanceTo(target, deadline);
    const hit = sim.world.strongest;
    if (hit.contact && hit.normal && hit.impulse > 1.2 && performance.now() / 1000 - this.sparkAt > SPARK_GAP) {
      this.sparkAt = performance.now() / 1000;
      this.host.hit(hit.contact, hit.normal, hit.impulse);
    }
    return sim.time - before;
  }

  private frameShot(p: Prepared, s: Shot): void {
    const car = p.sim.cars[p.clip.focus]!;
    if (s.kind === "cine") {
      this.cine.reset(s.seed);
      // No budget: the whole search runs now, so the pick depends only on the poses and the seed.
      this.cineFound = this.cine.pick(this.host.sight(car), car) === "found";
    } else if (s.kind === "high") {
      const y = car.group.position.y;
      this.highEye.set(p.clip.x + Math.cos(s.angle) * 22, y + 9, p.clip.z + Math.sin(s.angle) * 22);
    }
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

function lens(cam: THREE.PerspectiveCamera, fov: number): void {
  if (Math.abs(cam.fov - fov) < 0.01) return;
  cam.fov = fov;
  cam.updateProjectionMatrix();
}
