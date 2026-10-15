import type * as THREE from "three";
import { hypot3 } from "../kernel/physics-core.js";
import { CAR_HALF } from "../vehicle/car-mesh.ts";
import { CINE, gather, inside, solid, type Occluder, type Sight } from "./spectate-cam.ts";
import { Spring } from "./spring.ts";

/** Sight-line samples are `STEP` m apart, each `CINE.pad` (half a step) clear of every solid, so a line never slips between two. */
const STEP = 2 * CINE.pad;
/** The part of a line within this of the subject is the subject's own: it may be touching a wall or a car. */
const OWN = CINE.stop;
const BISECT = 6;
/** Turns tried round the subject, `SWING_STEP` apart up to a half turn. */
const SWING_STEP = Math.PI / 12;
const SWING_STEPS = 12;
/** An eye pulled in closer than a car's length to its subject swings round it instead. */
const SWING_BELOW = 2 * CAR_HALF.z;
/** After a search that found no turn with room, the next waits this long (s). */
const SEARCH_RETRY = 0.25;
/** Rates (1/s) at which a pull-in eases back out and the swing's spring settles on its turn, and the fastest (m/s) the pull-in lets go. */
const PULL_OMEGA = 8;
const SWING_OMEGA = 5;
const PULL_OUT_SPEED = 4;
/** The eye never stands more than this much (m) closer than the line needs, however fast the rig's own eye came in. */
const PULL_LAG_MAX = 3;
/** A pull-in this short (m) is none. */
const PULL_NONE = 1e-3;

type Vec3 = { x: number; y: number; z: number };

/**
 * Keeps a camera's line of sight to its subject clear of the scene's solids and of the cars' boxes: the eye is pulled in along
 * the line from the subject to just short of the first solid on it (at once as a solid closes on it, eased back out once the
 * way is clear), and when that leaves less than a car's length it swings round the subject, about its vertical axis, to the
 * nearest turn with room, eased so it never pops. The eye never ends inside a solid. The rig's own spring is untouched, and
 * where nothing is in the way the eye is exactly the rig's. No allocation.
 */
export class EyeClear {
  private pull = 0;
  private readonly swing = new Spring();
  private swingTo = 0;
  private cooldown = 0;
  private sight: Sight | null = null;
  private boxes: readonly Occluder[] = [];
  private near: readonly Occluder[] = [];
  private sx = 0;
  private sy = 0;
  private sz = 0;
  private dx = 0;
  private dy = 0;
  private dz = 0;
  private len = 0;

  reset(): void {
    this.pull = 0;
    this.swing.snap(0);
    this.swingTo = 0;
    this.cooldown = 0;
  }

  /**
   * Move `eye` (the rig's, `subject`'s line out to it) clear of `s` and of `boxes`, `dt` s after the last call. `dt` Infinity:
   * no easing, so the eye depends on where it stands alone.
   */
  apply(s: Sight, boxes: readonly Occluder[], subject: Vec3, eye: THREE.Vector3, dt: number): void {
    const len = hypot3(eye.x - subject.x, eye.y - subject.y, eye.z - subject.z);
    if (len < PULL_NONE) return;
    this.sight = s;
    this.boxes = boxes;
    this.sx = subject.x;
    this.sy = subject.y;
    this.sz = subject.z;
    this.dx = eye.x - subject.x;
    this.dy = eye.y - subject.y;
    this.dz = eye.z - subject.z;
    this.len = len;
    this.near = gather(s, this.sx - len, this.sz - len, this.sx + len, this.sz + len, CINE.pad);

    const need = Math.min(SWING_BELOW, len);
    const straight = this.reach(0);
    this.cooldown -= dt;
    if (this.swingTo === 0) {
      if (straight < need && this.cooldown <= 0) this.chooseSwing(need);
    } else if (straight >= len) {
      this.swingTo = 0;
    } else if (this.cooldown <= 0 && this.reach(this.swingTo) < need) {
      this.chooseSwing(need);
    }
    if (dt === Infinity) this.swing.snap(this.swingTo);
    else this.swing.step(this.swingTo, SWING_OMEGA, dt);
    if (this.swingTo === 0 && Math.abs(this.swing.x) < PULL_NONE && Math.abs(this.swing.v) < PULL_NONE) this.swing.snap(0);

    const turn = this.swing.x;
    const clear = turn === 0 ? straight : this.reach(turn);
    const pulledIn = len - clear;
    this.pull = pulledIn >= this.pull ? pulledIn : Math.max(pulledIn, this.pull - Math.min(this.pull * (1 - Math.exp(-PULL_OMEGA * dt)), PULL_OUT_SPEED * dt));
    this.pull = Math.min(this.pull, pulledIn + PULL_LAG_MAX);
    if (this.pull < PULL_NONE) this.pull = 0;
    if (this.pull === 0 && turn === 0) return;
    const c = Math.cos(turn);
    const sn = Math.sin(turn);
    const k = (len - this.pull) / len;
    eye.set(this.sx + (this.dx * c + this.dz * sn) * k, this.sy + this.dy * k, this.sz + (this.dz * c - this.dx * sn) * k);
  }

  /** The turn (rad) nearest the rig's, on the side it already turned if equal, with at least `need` m of clear line; else the one with most. */
  private chooseSwing(need: number): void {
    const side = this.swingTo < 0 ? -1 : 1;
    let best = -1;
    let bestTurn = 0;
    for (let k = 1; k <= SWING_STEPS; k++) {
      const first = this.reach(side * k * SWING_STEP);
      const second = this.reach(-side * k * SWING_STEP);
      const turn = (second > first ? -side : side) * k * SWING_STEP;
      const room = Math.max(first, second);
      if (room >= need) {
        this.swingTo = turn;
        return;
      }
      if (room > best) {
        best = room;
        bestTurn = turn;
      }
    }
    this.swingTo = bestTurn;
    this.cooldown = SEARCH_RETRY;
  }

  /** How far (m, at most `len`) the line from the subject, turned `turn` rad about the vertical, runs clear of every solid. */
  private reach(turn: number): number {
    const c = Math.cos(turn);
    const sn = Math.sin(turn);
    const ux = (this.dx * c + this.dz * sn) / this.len;
    const uy = this.dy / this.len;
    const uz = (this.dz * c - this.dx * sn) / this.len;
    let lo = 0;
    let d = OWN;
    for (;;) {
      const at = Math.min(d, this.len);
      if (this.blocked(this.sx + ux * at, this.sy + uy * at, this.sz + uz * at)) {
        let hi = at;
        for (let i = 0; i < BISECT; i++) {
          const mid = (lo + hi) / 2;
          if (this.blocked(this.sx + ux * mid, this.sy + uy * mid, this.sz + uz * mid)) hi = mid;
          else lo = mid;
        }
        return lo;
      }
      if (at >= this.len) return this.len;
      lo = at;
      d += STEP;
    }
  }

  private blocked(x: number, y: number, z: number): boolean {
    if (solid(this.sight!, x, y, z, CINE.pad, this.near)) return true;
    const boxes = this.boxes;
    for (let i = 0; i < boxes.length; i++) if (inside(boxes[i]!, x, y, z, CINE.pad)) return true;
    return false;
  }
}
