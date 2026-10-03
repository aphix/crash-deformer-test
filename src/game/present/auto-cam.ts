import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import { mulberry32 } from "../world/placements.ts";
import { CINE, type Sight } from "./spectate-cam.ts";
import { AFTERS, OPENERS, pickShot, RUN_INS, ShotCam, type Shot } from "./shot-cam.ts";

/** What the Auto cam reads from the scene, only when it cuts or re-asks. */
export type AutoScene = {
  /** The scene's solids (every other car where it stands now). */
  sight(): Sight;
  /** The crash cam is on (its letterbox and replay cuts, from the first impact until it hands back). */
  crashing(): boolean;
  /**
   * The cam is about to cut: the car to frame next. The Auto driver may hand over another one here (a driver switch
   * happens on a camera cut); otherwise `car` comes back.
   */
  cut(car: DeformableCar): DeformableCar;
};

/** Seconds between re-asking a held shot whether it is still usable. */
const RECHECK = 0.5;

/**
 * The spectator "Auto" cam: the results reel's shot director (`ShotCam`, the same shot kinds and pool order: an
 * opener, then run-in shots, an aftermath once the crash cam hands back) run live on the watched car. A shot is held
 * until its spot is no longer usable (`camUsable`: out of every solid and seeing the car now and `SHOT_AHEAD` s on,
 * re-asked every `RECHECK` s), the crash cam hands back, or `CINE.maxShot` s (the trackside cam's longest hold). The
 * crash cam takes each hit itself (`Cinematics.direct` runs before any spectator cam). No spot for a cut: the chase.
 */
export class AutoCam {
  /** Shots started so far (the Auto driver counts them: it switches cars every few). */
  cuts = 0;
  /** The shot director and the shot in play (null before the first cut): what the cut sequence is made of. */
  readonly cam = new ShotCam();
  shot: Shot | null = null;
  private car: DeformableCar | null = null;
  private readonly last = new THREE.Vector3();
  private age = 0;
  private ask = 0;
  private crash = false;

  /** Forget the shot; the next `update` opens a new sequence. */
  reset(): void {
    this.shot = null;
  }

  /** Frame `car` (or the car the scene hands over at a cut); the shot stands until it ends, then the next one. */
  update(camera: THREE.PerspectiveCamera, car: DeformableCar, scene: AutoScene, dt: number): void {
    const crash = scene.crashing();
    const handed = this.crash && !crash;
    this.crash = crash;
    let kinds = RUN_INS;
    // A new car or a respawn jump: a new sequence.
    if (this.car !== car || this.last.distanceToSquared(car.group.position) > 64) this.shot = null;
    this.age += dt;
    this.ask -= dt;
    let due = this.shot === null || handed || this.age > CINE.maxShot;
    if (!due && this.ask <= 0) {
      this.ask = RECHECK;
      due = !this.cam.usable(scene.sight(), car);
    }
    if (due) {
      const to = scene.cut(car);
      if (this.shot === null || to !== car) kinds = OPENERS;
      else if (handed) kinds = AFTERS;
      car = to;
      const p = car.group.position;
      this.shot = pickShot(kinds, to === this.car ? this.shot?.kind : undefined, mulberry32(Math.imul(++this.cuts, 0x9e3779b9)));
      this.cam.frame(this.shot, car, scene.sight(), p.x, p.z);
      this.age = 0;
      this.ask = RECHECK;
    }
    this.car = car;
    this.last.copy(car.group.position);
    this.cam.pose(camera, car, this.shot!);
  }
}
