import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import { CINE, CLEAR_COST, CineCam, DUTCH, DutchCam, EyePull, SightLines, sightLine, solid, type Sight } from "./spectate-cam.ts";

/**
 * The shot director both the results reel (`ReelDirector`, from clip time) and the Auto spectator cam (`AutoCam`, live)
 * run: which kind of shot comes next (`pickShot`), where its camera stands (`ShotCam.frame`: a spot that is clear and sees
 * the car, searched when the shot starts) and how it is posed each frame (`ShotCam.pose`). Timing (when a shot cuts) is the
 * caller's.
 */
export type ShotKind = "chase" | "cine" | "dutch" | "high";
/** A camera: its kind and the seeded picks it frames with. */
export type Shot = { kind: ShotKind; mount: number; angle: number; seed: number };

export const OPENERS: readonly ShotKind[] = ["chase", "cine", "high", "dutch"];
export const RUN_INS: readonly ShotKind[] = ["cine", "dutch", "chase"];
export const AFTERS: readonly ShotKind[] = ["high", "cine", "chase"];

/** The next shot from `kinds` (never `prev` again), its picks from `rand` (four draws: kind, mount, angle, seed). */
export function pickShot(kinds: readonly ShotKind[], prev: ShotKind | undefined, rand: () => number): Shot {
  const pool = kinds.filter((k) => k !== prev);
  return { kind: pool[Math.floor(rand() * pool.length)]!, mount: Math.floor(rand() * 8), angle: rand() * Math.PI * 2, seed: Math.floor(rand() * 1e6) };
}

/** The high shot: its eye stands this far (m) off the subject, and this high (m) over the car. */
const HIGH = { dist: 22, up: 9, fov: 42 };
/** A held static eye (cine, high) loses the car past this range (m). */
const SHOT_RANGE = 90;
/** How far ahead (s) a shot's spot must keep seeing the car (`camUsable`'s horizon). */
const SHOT_AHEAD = 2;
/** The dutch cam's wheel mounts (four wells, looking forward and back). */
const DUTCH_MOUNTS = 8;
/** The chase shot: behind the car along its travel, this far (m) and this high, looking this far (m) ahead of it. */
const CHASE = { back: 8, up: 2.8, look: 3, fov: 55 };
/** The chase heading (`foldHeading`) is low-passed over this many seconds. */
const HEADING_TAU = 0.3;

const _a = new THREE.Vector3();
const _e = new THREE.Vector3();
const _d = new THREE.Vector3();

/**
 * Fold `car`'s travel direction (flat, unit: its velocity, its body's heading when nearly still) into `heading`, low-passed over
 * `HEADING_TAU` for a step of `h` s (an empty `heading` takes it whole): a wreck's own velocity swings 4° and more between
 * frames, and a car sliding to a stop flips its velocity's direction, which a camera behind it must not copy. The one
 * heading of both chase rigs: the reel's (`ClipSim.heading`, per sim step) and the Auto cam's (`AutoCam`, per frame).
 */
export function foldHeading(heading: THREE.Vector2, car: Pick<DeformableCar, "velocity" | "fwdFlat">, h: number): void {
  const speed = Math.hypot(car.velocity.x, car.velocity.z);
  const dx = speed > 2 ? car.velocity.x / speed : car.fwdFlat.x;
  const dz = speed > 2 ? car.velocity.z / speed : car.fwdFlat.z;
  const k = heading.lengthSq() < 1e-9 ? 1 : 1 - Math.exp(-h / HEADING_TAU);
  const hx = heading.x + (dx - heading.x) * k;
  const hz = heading.y + (dz - heading.y) * k;
  const len = Math.hypot(hx, hz);
  if (len > 1e-6) heading.set(hx / len, hz / len);
  else heading.set(dx, dz);
}

function lens(cam: THREE.PerspectiveCamera, fov: number): void {
  if (Math.abs(cam.fov - fov) < 0.01) return;
  cam.fov = fov;
  cam.updateProjectionMatrix();
}

export class ShotCam {
  /** The trackside search; its spot is `cine.eye`. */
  readonly cine = new CineCam();
  private readonly dutch = new DutchCam();
  private readonly probe = new THREE.PerspectiveCamera();
  private readonly highEye = new THREE.Vector3();
  private sight: Sight | null = null;
  private kind: ShotKind = "chase";
  private mount = 0;
  /** The next eighth-turn the high search tries. */
  private turn = 0;
  /** The sight lines being checked, over several calls: the high search's candidate, or the held shot's re-ask (`usable`). */
  private readonly lines = new SightLines();
  /** The shot's own spot was found (cine, high, dutch); false: it poses as the chase. */
  found = false;
  /** The chase's pull-in past the sight's solids. */
  private readonly pull = new EyePull();

  /**
   * Begin the search for `shot`'s spot: a cine shot resets its trackside search, a high shot its eight turns. Chase
   * shots are found at once. Continue with `step`.
   */
  start(shot: Shot, sight: Sight): void {
    this.sight = sight;
    this.pull.reset();
    this.kind = shot.kind;
    this.found = shot.kind === "chase";
    this.turn = 0;
    this.lines.cancel();
    if (shot.kind === "cine") this.cine.reset(shot.seed);
  }

  /**
   * Search on for `shot`'s spot, until about `budget` sight-line samples are spent (a candidate's sight lines go on over
   * the calls, one line at a time): a cine shot tries `CINE.tries` trackside spots, a high shot the eight eighth-turns
   * round the shot's centre (cx, cz), each clear and seeing the car (`camUsable`; its room costs `CLEAR_COST`); a dutch
   * shot takes the first of the eight wheel mounts from its seeded one whose eye is out of every solid and looks down a
   * clear 8 m. True when the search is over: `found`, or false for a shot with no usable spot, which poses as the
   * chase. No allocation.
   */
  step(shot: Shot, car: DeformableCar, cx: number, cz: number, budget: number): boolean {
    const sight = this.sight!;
    if (shot.kind === "cine") {
      const r = this.cine.pick(sight, car, budget);
      this.found = r === "found";
      return r !== "more";
    }
    if (shot.kind === "high") {
      const pos = car.group.position;
      const e = this.highEye;
      const l = this.lines;
      for (let spent = 0; this.turn < 8 && spent < budget; ) {
        if (!l.active) {
          const a = shot.angle + (this.turn * Math.PI) / 4;
          e.set(cx + Math.cos(a) * HIGH.dist, pos.y + HIGH.up, cz + Math.sin(a) * HIGH.dist);
          spent += CLEAR_COST;
          if (!l.begin(sight, e, _a.set(pos.x, pos.y + CINE.aimUp, pos.z), car.velocity, SHOT_AHEAD)) {
            this.turn++;
            continue;
          }
        }
        const r = l.run(budget - spent);
        spent += l.spent;
        if (r === "more") return false;
        this.turn++;
        if (r === "clear") {
          this.found = true;
          return true;
        }
      }
      return this.turn >= 8;
    }
    if (shot.kind === "dutch") {
      const p = this.probe;
      for (let d = 0; d < DUTCH_MOUNTS && !this.found; d++) {
        this.mount = (shot.mount + d) % DUTCH_MOUNTS;
        this.dutch.place(p, car, this.mount);
        p.getWorldDirection(_e);
        this.found = !solid(sight, p.position.x, p.position.y, p.position.z, 0.1) && sightLine(sight, p.position.x, p.position.y, p.position.z, p.position.x + _e.x * 8, p.position.y + _e.y * 8, p.position.z + _e.z * 8) >= 0;
      }
    }
    return true;
  }

  /** The whole search now (the reel: the pick depends only on the poses and the seed, never on frame times). `sight`: the scene's solids, kept for the chase's per-frame push-out. */
  frame(shot: Shot, car: DeformableCar, sight: Sight, cx: number, cz: number): void {
    this.start(shot, sight);
    this.step(shot, car, cx, cz, Infinity);
  }

  /**
   * The found spot has a clear line to `p` in `s`: a trackside or high eye, which stands still, so the line it will have at
   * a moment to come is the one it has now. A wheel mount moves with the car, so it cannot be told ahead: no.
   */
  sees(s: Sight, p: THREE.Vector3): boolean {
    const eye = !this.found ? null : this.kind === "cine" ? this.cine.eye : this.kind === "high" ? this.highEye : null;
    return eye !== null && sightLine(s, eye.x, eye.y, eye.z, p.x, p.y, p.z) >= 0;
  }

  /** The held shot's spot is being re-asked: `usable` answered "more". */
  get asking(): boolean {
    return this.lines.active;
  }

  /**
   * Is the held shot's spot still usable (within `SHOT_RANGE`, clear, sees `car` now and `SHOT_AHEAD` s on)? "clear" or
   * "blocked", or "more" when `budget` samples ran out first: ask again (`sight` null) to go on with the lines, which
   * keep the solids the ask began with. The chase and the wheel mount always are usable. No allocation.
   */
  usable(sight: Sight | null, car: DeformableCar, budget = Infinity): "clear" | "blocked" | "more" {
    const l = this.lines;
    if (!l.active) {
      const eye = !this.found ? null : this.kind === "cine" ? this.cine.eye : this.kind === "high" ? this.highEye : null;
      if (eye === null || sight === null) return "clear";
      const pos = car.group.position;
      if (eye.distanceToSquared(pos) >= SHOT_RANGE * SHOT_RANGE || !l.begin(sight, eye, _a.set(pos.x, pos.y + CINE.aimUp, pos.z), car.velocity, SHOT_AHEAD)) return "blocked";
    }
    return l.run(budget);
  }

  /**
   * `cam` on `shot`'s camera for `car`. `heading` (flat, unit): the travel direction the chase follows, folded over the
   * frames by `foldHeading` (the reel's `ClipSim.heading`, the Auto cam's own). `dt`: seconds since the last call, which
   * eases the chase's pull-in back out; Infinity (the reel: its camera depends only on the poses): no easing.
   */
  pose(cam: THREE.PerspectiveCamera, car: DeformableCar, shot: Shot, heading: { x: number; y: number }, dt = Infinity): void {
    const pos = car.group.position;
    if (shot.kind === "cine" && this.found) {
      cam.position.copy(this.cine.eye);
      cam.lookAt(pos.x, pos.y + CINE.aimUp, pos.z);
      lens(cam, THREE.MathUtils.clamp(2 * THREE.MathUtils.radToDeg(Math.atan2(CINE.frame, this.cine.eye.distanceTo(pos))), CINE.fov[0]!, CINE.fov[1]!));
    } else if (shot.kind === "dutch" && this.found) {
      this.dutch.place(cam, car, this.mount);
      lens(cam, DUTCH.fov);
    } else if (shot.kind === "high" && this.found) {
      cam.position.copy(this.highEye);
      cam.lookAt(pos.x, pos.y + CINE.aimUp, pos.z);
      lens(cam, HIGH.fov);
    } else {
      // Chase (and a cine or high shot with no usable spot): behind the car along its travel, pulled in along its view
      // while a solid is at the eye (a street corner, a wall).
      _e.set(pos.x - heading.x * CHASE.back, pos.y + CHASE.up, pos.z - heading.y * CHASE.back);
      _a.set(pos.x + heading.x * CHASE.look, pos.y + 0.8, pos.z + heading.y * CHASE.look);
      cam.position.copy(_e);
      if (this.sight) this.pull.apply(this.sight, cam.position, _d.subVectors(_a, _e).normalize(), dt);
      cam.lookAt(_a);
      lens(cam, CHASE.fov);
    }
  }
}
