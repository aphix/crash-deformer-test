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
 * The next shot's spot search and a held shot's re-ask each spend about this many sight-line samples a frame (a sight
 * line never splits, so a frame's first one may run over), so neither costs a frame more than ~1 ms: the old shot holds
 * meanwhile, a few frames (a whole search is 1–20 of them, a whole ask up to 3).
 */
const PICK_BUDGET = 250;
/** The pose before the first shot is found. */
const CHASE_SHOT: Shot = { kind: "chase", mount: 0, angle: 0, seed: 0 };

/**
 * The spectator "Auto" cam: the results reel's shot director (`ShotCam`, the same shot kinds and pool order: an
 * opener, then run-in shots, an aftermath once the crash cam hands back) run live on the watched car. A shot is held
 * until its spot is no longer usable (`camUsable`: out of every solid and seeing the car now and `SHOT_AHEAD` s on,
 * re-asked every `RECHECK` s), the crash cam hands back, or `CINE.maxShot` s (the trackside cam's longest hold). The
 * next shot's spot is searched over the frames after that decision (`PICK_BUDGET` a frame, into `next`), then swapped
 * in. The crash cam takes each hit itself (`Cinematics.direct` runs before any spectator cam). No spot for a cut: the
 * chase.
 */
export class AutoCam {
  /** Shots decided so far (the Auto driver counts them: it switches cars every few). */
  cuts = 0;
  /** The shot director holding the shot in play, and the shot (null before the first one is found): what the cut sequence is made of. */
  cam = new ShotCam();
  shot: Shot | null = null;
  /** The search in progress: its director and shot (null: none). */
  private next = new ShotCam();
  private pending: Shot | null = null;
  private car: DeformableCar | null = null;
  private readonly last = new THREE.Vector3();
  private age = 0;
  private ask = 0;
  private crash = false;

  /** Forget the shot and any search; the next `update` opens a new sequence. */
  reset(): void {
    this.shot = null;
    this.pending = null;
  }

  /** Frame `car` (or the car the scene hands over at a cut); the shot stands until it ends, then the next one. */
  update(camera: THREE.PerspectiveCamera, car: DeformableCar, scene: AutoScene, dt: number): void {
    const crash = scene.crashing();
    const handed = this.crash && !crash;
    this.crash = crash;
    // A new car or a respawn jump: a new sequence.
    if (this.car !== car || this.last.distanceToSquared(car.group.position) > 64) this.reset();
    this.age += dt;
    this.ask -= dt;
    if (this.pending === null) {
      let due = this.shot === null || handed || this.age > CINE.maxShot;
      if (!due && this.ask <= 0) {
        // The scene's solids are read when the ask begins; the next frames go on with those.
        const r = this.cam.usable(this.cam.asking ? null : scene.sight(), car, PICK_BUDGET);
        if (r !== "more") this.ask = RECHECK;
        due = r === "blocked";
      }
      if (due) {
        const to = scene.cut(car);
        const kinds = this.shot === null || to !== car ? OPENERS : handed ? AFTERS : RUN_INS;
        car = to;
        this.pending = pickShot(kinds, to === this.car ? this.shot?.kind : undefined, mulberry32(Math.imul(++this.cuts, 0x9e3779b9)));
        this.next.start(this.pending, scene.sight());
      }
    }
    if (this.pending !== null) {
      const p = car.group.position;
      if (this.next.step(this.pending, car, p.x, p.z, PICK_BUDGET)) {
        [this.cam, this.next] = [this.next, this.cam];
        this.shot = this.pending;
        this.pending = null;
        this.age = 0;
        this.ask = RECHECK;
      }
    }
    this.car = car;
    this.last.copy(car.group.position);
    this.cam.pose(camera, car, this.shot ?? CHASE_SHOT);
  }
}
