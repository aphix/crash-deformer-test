import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";

/** A body that moved further than this (m) in one step was placed (a respawn), not driven: it is drawn where it landed. */
const TELEPORT = 5;
/** Floats per body: position (3), quaternion (4), Euler angles (3). */
const N = 10;
const noop = (): void => {};
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();

function read(o: THREE.Object3D, a: Float64Array, i: number): void {
  const k = i * N;
  a[k] = o.position.x;
  a[k + 1] = o.position.y;
  a[k + 2] = o.position.z;
  a[k + 3] = o.quaternion.x;
  a[k + 4] = o.quaternion.y;
  a[k + 5] = o.quaternion.z;
  a[k + 6] = o.quaternion.w;
  a[k + 7] = o.rotation.x;
  a[k + 8] = o.rotation.y;
  a[k + 9] = o.rotation.z;
}

/** True when `o` is still exactly as `read` left it in `a` at `i`. */
function same(o: THREE.Object3D, a: Float64Array, i: number): boolean {
  const k = i * N;
  return (
    a[k] === o.position.x &&
    a[k + 1] === o.position.y &&
    a[k + 2] === o.position.z &&
    a[k + 3] === o.quaternion.x &&
    a[k + 4] === o.quaternion.y &&
    a[k + 5] === o.quaternion.z &&
    a[k + 6] === o.quaternion.w
  );
}

/**
 * Put body `i` of `a` back as it was read: position, quaternion and Euler angles each as stored. The change callbacks are
 * switched off for it, or setting the quaternion would recompute the angles (and the angles the quaternion) a rounding
 * away from what the sim left.
 */
function write(o: THREE.Object3D, a: Float64Array, i: number, order: THREE.EulerOrder): void {
  const k = i * N;
  const qc = o.quaternion._onChangeCallback;
  const ec = o.rotation._onChangeCallback;
  o.quaternion._onChangeCallback = noop;
  o.rotation._onChangeCallback = noop;
  o.position.set(a[k]!, a[k + 1]!, a[k + 2]!);
  o.quaternion.set(a[k + 3]!, a[k + 4]!, a[k + 5]!, a[k + 6]!);
  o.rotation.set(a[k + 7]!, a[k + 8]!, a[k + 9]!, order);
  o.quaternion._onChangeCallback = qc;
  o.rotation._onChangeCallback = ec;
}

/** One car's bodies (its group first, then the parts and wheels it has put in the world) and their poses around the last step. */
class CarBlend {
  readonly bodies: THREE.Object3D[] = [];
  private orders: THREE.EulerOrder[] = [];
  /** Before the last step, after it, and the sim's own while a blended pose is on show. */
  from = new Float64Array(N);
  to = new Float64Array(N);
  kept = new Float64Array(N);
  /** Per body: 1 when it is drawn as the sim has it (placed, or moved since the step). */
  private skip = new Uint8Array(1);
  /** The last step ran on these bodies. */
  stepped = false;
  drawn = false;

  begin(car: DeformableCar): void {
    this.bodies.length = 0;
    this.bodies.push(car.group);
    car.freeObjects(this.bodies);
    const n = this.bodies.length;
    if (this.from.length < n * N) {
      this.from = new Float64Array(n * N);
      this.to = new Float64Array(n * N);
      this.kept = new Float64Array(n * N);
      this.skip = new Uint8Array(n);
    }
    for (let i = 0; i < n; i++) read(this.bodies[i]!, this.from, i);
    this.stepped = false;
  }

  end(): void {
    for (let i = 0; i < this.bodies.length; i++) read(this.bodies[i]!, this.to, i);
    this.stepped = true;
  }

  present(group: THREE.Object3D, alpha: number): void {
    const { bodies, from, to, kept } = this;
    for (let i = 0; i < bodies.length; i++) {
      const o = bodies[i]!;
      const k = i * N;
      read(o, kept, i);
      this.orders[i] = o.rotation.order;
      const dx = to[k]! - from[k]!;
      const dy = to[k + 1]! - from[k + 1]!;
      const dz = to[k + 2]! - from[k + 2]!;
      const stay = !same(o, to, i) || dx * dx + dy * dy + dz * dz > TELEPORT * TELEPORT;
      this.skip[i] = stay ? 1 : 0;
      if (stay) continue;
      o.position.set(from[k]! + dx * alpha, from[k + 1]! + dy * alpha, from[k + 2]! + dz * alpha);
      _q0.set(from[k + 3]!, from[k + 4]!, from[k + 5]!, from[k + 6]!);
      _q1.set(to[k + 3]!, to[k + 4]!, to[k + 5]!, to[k + 6]!);
      o.quaternion.copy(_q0.slerp(_q1, alpha));
    }
    // The root's matrix is what a first-person eye and the lamps read before the renderer composes the scene.
    group.updateWorldMatrix(false, false);
    this.drawn = true;
  }

  restore(group: THREE.Object3D): void {
    for (let i = 0; i < this.bodies.length; i++) if (this.skip[i] === 0) write(this.bodies[i]!, this.kept, i, this.orders[i]!);
    group.updateWorldMatrix(false, false);
    this.drawn = false;
  }
}

/**
 * Cars drawn between the last two sim states. The sim steps in whole slices (`SimPacer`), so a frame mostly lands inside
 * one: `present` puts every car (its group, and the torn parts and popped wheels flying free of it) where the frame's
 * time puts it between the pose before the last step and the one it left, `alpha` of the way, and `restore` hands the
 * sim its own poses back, exactly (`write`), once the frame is drawn. The sim never runs from, or is changed by, a drawn pose.
 *
 * Per step: `begin` before it and `end` after it. A body that was placed (> `TELEPORT`) or moved since the step (a respawn
 * between frames) is drawn as it stands.
 */
export class PoseBlend {
  private readonly cars = new WeakMap<DeformableCar, CarBlend>();
  private readonly shown: [DeformableCar, CarBlend][] = [];

  begin(cars: readonly DeformableCar[]): void {
    for (const car of cars) {
      let c = this.cars.get(car);
      if (!c) this.cars.set(car, (c = new CarBlend()));
      c.begin(car);
    }
  }

  end(cars: readonly DeformableCar[]): void {
    for (const car of cars) this.cars.get(car)?.end();
  }

  present(cars: readonly DeformableCar[], alpha: number): void {
    if (!(alpha < 1)) return;
    const a = Math.max(0, alpha);
    for (const car of cars) {
      const c = this.cars.get(car);
      if (!c?.stepped || !car.group.visible) continue;
      c.present(car.group, a);
      this.shown.push([car, c]);
    }
  }

  restore(): void {
    for (const [car, c] of this.shown) c.restore(car.group);
    this.shown.length = 0;
  }
}
