import * as THREE from "three";
import { hypot2 } from "../kernel/physics-core.js";
import type { DeformableCar } from "../vehicle/car.ts";
import { BARRIER_HALF, BARRIER_TOP } from "../contact/sat.ts";
import { KNOCK, PROP, RIG, Surface } from "../world/surfaces.ts";
import { BALL_EXPOSE, type JerseyBarrier, type LampPole, type RampBall } from "./engine-props.ts";
import { PLATE } from "./compactor.ts";

/** A sandbox lamp post's height (m) and mass (kg): a thin steel upright a car knocks over. */
const LAMP_POST_HEIGHT = 5.3;
const LAMP_POST_MASS = 60;
/** The closing speed (m/s) from which a body meeting a ramp ball's side shatters it. */
export const BALL_BREAK_CLOSING = 7.5;
/** The closing speed (m/s) above which a body meeting a lamp post folds it (main's `resolveLampPoles`: 3.5); slower, the post stands and the body meets it as a solid. */
export const POLE_FOLD_CLOSING = 3.5;

/** The patches of the rigs, in order: the slab, the two press plates, the six lamp posts, the three ramp balls (a prism's `id` is its patch). */
const RIG_SLAB = 0;
const RIG_PLATE_FRONT = 1;
const RIG_PLATE_REAR = 2;
export const RIG_POLE_FIRST = 3;
export const RIG_POLES = 6;
export const RIG_BALL_FIRST = RIG_POLE_FIRST + RIG_POLES;
export const RIG_BALLS = 3;

/**
 * The scene's rigs as prisms of one store (`armSolids`), so what a loose part, an FX bit, a tyre or a hull point meets of them is
 * what it meets of any prop: the jersey slab and the compactor's two plates (moving boxes, `RIG`: the rig's own response meets the cars),
 * the lamp posts (knockable circles) and the ramp balls (the exposed cap of each: a circle `E` r high, a kerb a tyre mounts and a wall to
 * a body it meets higher). One `sync` a step puts each where its rig is now; an absent rig is out of play.
 */
export class RigSolids extends Surface {
  constructor() {
    super();
    this.addPrism({ x: 0, z: 0, yaw: 0, hx: BARRIER_HALF.x, hz: BARRIER_HALF.z, base: 0, top: BARRIER_TOP, id: RIG_SLAB, role: RIG, moves: true });
    for (const id of [RIG_PLATE_FRONT, RIG_PLATE_REAR]) this.addPrism({ x: 0, z: 0, yaw: 0, hx: PLATE.hx, hz: PLATE.hz, base: PLATE.y - PLATE.hy, top: PLATE.y + PLATE.hy, id, role: RIG, moves: true });
    for (let k = 0; k < RIG_POLES; k++) this.addPrism({ x: 0, z: 0, yaw: 0, hx: 0.12, hz: 0.12, circle: true, base: 0, top: LAMP_POST_HEIGHT, id: RIG_POLE_FIRST + k, role: KNOCK, mass: LAMP_POST_MASS, knockSpeed: POLE_FOLD_CLOSING, moves: true });
    for (let k = 0; k < RIG_BALLS; k++) this.addPrism({ x: 0, z: 0, yaw: 0, hx: 0.5, hz: 0.5, circle: true, base: 0, top: 0.2, id: RIG_BALL_FIRST + k, role: PROP, moves: true });
    for (let i = 0; i < this.count; i++) this.disable(i);
    this.seal();
  }

  /** The slab as it is now (it crumples and slides), or out of play with no slab. */
  syncSlab(barrier: JerseyBarrier | null): void {
    if (!barrier) {
      this.disable(RIG_SLAB);
      return;
    }
    this.resizePrism(RIG_SLAB, barrier.hx(), BARRIER_HALF.z, 0, BARRIER_TOP);
    this.movePrism(RIG_SLAB, barrier.group.position.x, barrier.group.position.z, barrier.yaw, barrier.vel.x, barrier.vel.z);
  }

  /** The plates with their faces `face` m either side of z = 0, closing at `speed` m/s (NaN: no press: both out of play). */
  syncPlates(face: number, speed: number): void {
    if (Number.isNaN(face)) {
      this.disable(RIG_PLATE_FRONT);
      this.disable(RIG_PLATE_REAR);
      return;
    }
    const z = face + PLATE.hz;
    this.movePrism(RIG_PLATE_FRONT, 0, z, 0, 0, -speed);
    this.movePrism(RIG_PLATE_REAR, 0, -z, 0, 0, speed);
  }

  /** Each lamp post standing where it stands (a folded one is out of play), and its knocked flag in `knocked`. */
  syncPoles(poles: readonly LampPole[], knocked: Uint8Array): void {
    for (let k = 0; k < RIG_POLES; k++) {
      const pole = poles[k]!;
      const id = RIG_POLE_FIRST + k;
      knocked[id] = pole.intact ? 0 : 1;
      if (pole.intact && pole.group.visible) this.movePrism(id, pole.group.position.x, pole.group.position.z, 0, 0, 0);
      else this.disable(id);
    }
  }

  /** Each ramp ball whole and shown: its cap on the asphalt (the circle where the sphere meets it, its height above); else out of play. */
  syncBalls(balls: readonly RampBall[], up: boolean): void {
    for (let k = 0; k < RIG_BALLS; k++) {
      const ball = balls[k]!;
      const id = RIG_BALL_FIRST + k;
      if (!up || !ball.intact || !ball.mesh.visible) {
        this.disable(id);
        continue;
      }
      const r = ball.radius;
      this.resizePrism(id, r * Math.sqrt(1 - (1 - BALL_EXPOSE) ** 2), r * Math.sqrt(1 - (1 - BALL_EXPOSE) ** 2), 0, BALL_EXPOSE * r);
      this.movePrism(id, ball.mesh.position.x, ball.mesh.position.z, 0, 0, 0);
    }
  }
}

const _hubAt = new THREE.Vector3();

/** Height (m) over the road of the point the shattered ball's kick reaches the car at (main's `resolveRampBalls` read the hull's nearest point to the ball's middle at this height). */
const BALL_HIT_Y = 0.28;

/**
 * A ramp ball hit by `car` closing at `closing` m/s: from `BALL_BREAK_CLOSING` it shatters (gone, undrawn) and the hub nearest the ball's middle is kicked up
 * (impulse `closing` × 1.6, 3 to 14) and torn off, as main's `resolveRampBalls` did. Whether it shattered.
 */
export function shatterBall(ball: RampBall, car: DeformableCar, closing: number): boolean {
  if (closing < BALL_BREAK_CLOSING) return false;
  ball.intact = false;
  ball.mesh.visible = false;
  if (!car.deform.massActive) car.deform.armMasses(car.group, car.velocity, car.angular);
  const hub = car.deform.kickNearestHub(_hubAt.set(ball.mesh.position.x, BALL_HIT_Y, ball.mesh.position.z), Math.min(14, Math.max(3, closing * 1.6)));
  const node = hub ? car.deform.masses.find((m) => m.name === hub) : undefined;
  if (node) car.deform.popHub(node);
  return true;
}

/** How far (rad) a folded lamp post lies over. */
const POLE_FOLD = 1.1;

/** Lamp post `pole` knocked over by a body leaving it at (`vx`, `vz`) m/s: it falls along that heading. */
export function foldPole(pole: LampPole, vx: number, vz: number): void {
  pole.intact = false;
  const speed = hypot2(vx, vz) || 1;
  pole.group.rotation.set((vz / speed) * POLE_FOLD, 0, (-vx / speed) * POLE_FOLD);
}
