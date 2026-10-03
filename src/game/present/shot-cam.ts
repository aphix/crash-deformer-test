import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import { camUsable, CINE, CineCam, DUTCH, DutchCam, sightLine, solid, type Sight } from "./spectate-cam.ts";

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
/** Shares of the chase offset tried in order when a solid is at the eye (the last stands whatever is there). */
const PULL = [1, 0.75, 0.55, 0.35] as const;

const _a = new THREE.Vector3();
const _e = new THREE.Vector3();

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
  /** The shot's own spot was found (cine, high, dutch); false: it poses as the chase. */
  found = false;

  /**
   * Set `shot` up for `car` as it stands now: a cine or high shot searches its spot (`CINE.tries` trackside spots, the
   * eight eighth-turns round the high shot's centre (cx, cz), each clear and seeing the car, `camUsable`); a dutch shot
   * takes the first of the eight wheel mounts from its seeded one whose eye is out of every solid and looks down a
   * clear 8 m; a shot with no usable spot falls back to the chase. `sight`: the scene's solids, kept for the chase's
   * per-frame push-out.
   */
  frame(shot: Shot, car: DeformableCar, sight: Sight, cx: number, cz: number): void {
    this.sight = sight;
    this.kind = shot.kind;
    this.found = shot.kind === "chase";
    if (shot.kind === "cine") {
      this.cine.reset(shot.seed);
      // No budget: the whole search runs now, so the pick depends only on the poses and the seed.
      this.found = this.cine.pick(sight, car) === "found";
    } else if (shot.kind === "high") {
      const pos = car.group.position;
      const e = this.highEye;
      for (let k = 0; k < 8 && !this.found; k++) {
        const a = shot.angle + (k * Math.PI) / 4;
        e.set(cx + Math.cos(a) * HIGH.dist, pos.y + HIGH.up, cz + Math.sin(a) * HIGH.dist);
        this.found = camUsable(sight, e, _a.set(pos.x, pos.y + CINE.aimUp, pos.z), car.velocity, SHOT_AHEAD);
      }
    } else if (shot.kind === "dutch") {
      const p = this.probe;
      for (let d = 0; d < DUTCH_MOUNTS && !this.found; d++) {
        this.mount = (shot.mount + d) % DUTCH_MOUNTS;
        this.dutch.place(p, car, this.mount);
        p.getWorldDirection(_e);
        this.found = !solid(sight, p.position.x, p.position.y, p.position.z, 0.1) && sightLine(sight, p.position.x, p.position.y, p.position.z, p.position.x + _e.x * 8, p.position.y + _e.y * 8, p.position.z + _e.z * 8) >= 0;
      }
    }
  }

  /** The held shot's spot is still usable (within `SHOT_RANGE`, clear, sees `car` now and `SHOT_AHEAD` s on); the chase and the wheel mount always are. */
  usable(sight: Sight, car: DeformableCar): boolean {
    if (!this.found) return true;
    const pos = car.group.position;
    const eye = this.kind === "cine" ? this.cine.eye : this.kind === "high" ? this.highEye : null;
    return eye === null || (eye.distanceToSquared(pos) < SHOT_RANGE * SHOT_RANGE && camUsable(sight, eye, _a.set(pos.x, pos.y + CINE.aimUp, pos.z), car.velocity, SHOT_AHEAD));
  }

  /** `cam` on `shot`'s camera for `car`. */
  pose(cam: THREE.PerspectiveCamera, car: DeformableCar, shot: Shot): void {
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
      // Chase (and a cine or high shot with no usable spot): behind the car along its travel, pulled in toward it while
      // a solid is at the eye (a street corner, a wall).
      const v = car.velocity;
      const speed = Math.hypot(v.x, v.z);
      const fx = speed > 2 ? v.x / speed : car.fwdFlat.x;
      const fz = speed > 2 ? v.z / speed : car.fwdFlat.z;
      const s = this.sight;
      for (const r of PULL) {
        _e.set(pos.x - fx * CHASE.back * r, pos.y + CHASE.up, pos.z - fz * CHASE.back * r);
        if (!s || r === PULL[PULL.length - 1] || !solid(s, _e.x, _e.y, _e.z, CINE.pad)) break;
      }
      cam.position.copy(_e);
      cam.lookAt(pos.x + fx * CHASE.look, pos.y + 0.8, pos.z + fz * CHASE.look);
      lens(cam, CHASE.fov);
    }
  }
}
