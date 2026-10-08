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

/**
 * One attribute the crush skin writes (a mesh's positions or normals) and its last two writes: `cur` the latest, `prev`
 * the one before, the skin at `from` and at `to` on `PoseBlend`'s step count. Writes are seen by the attribute's version.
 */
class SkinTrack {
  readonly attr: THREE.BufferAttribute;
  prev: Float32Array;
  cur: Float32Array;
  private version: number;
  from = 0;
  to = 0;
  /** `show` put a blend in the attribute, which `restore` takes out. */
  private drawn = false;

  constructor(attr: THREE.BufferAttribute) {
    this.attr = attr;
    this.cur = new Float32Array(attr.array as Float32Array);
    this.prev = new Float32Array(this.cur);
    this.version = attr.version;
  }

  /** A write since the last frame becomes `cur`, the skin as of step `steps`; the one it replaces, `prev`, held from the last write until then. */
  take(steps: number): void {
    if (this.attr.version === this.version) return;
    const last = this.prev;
    this.prev = this.cur;
    this.cur = last;
    last.set(this.attr.array as Float32Array);
    this.version = this.attr.version;
    this.from = this.to;
    this.to = steps;
  }

  /** Draw the skin at step time `now`: as written once `now` reaches `to` (or no step came between the two writes), else that far between `prev` and `cur`. */
  show(now: number): void {
    if (this.to === this.from || !(now < this.to)) return;
    const t = (now - this.from) / (this.to - this.from);
    const { prev, cur } = this;
    const out = this.attr.array as Float32Array;
    for (let i = 0; i < out.length; i++) out[i] = prev[i]! + (cur[i]! - prev[i]!) * t;
    this.attr.needsUpdate = true;
    this.version = this.attr.version;
    this.drawn = true;
  }

  /** The written skin back in the attribute, unless something wrote it while the blend was on show (that write stands). */
  restore(): void {
    if (!this.drawn) return;
    this.drawn = false;
    if (this.attr.version !== this.version) return;
    (this.attr.array as Float32Array).set(this.cur);
    this.attr.needsUpdate = true;
    this.version = this.attr.version;
  }
}

/** One car's bodies (its group first, then the parts and wheels it has put in the world) and their poses around the last step, and its skin's last two writes. */
class CarBlend {
  /** The car's group, then its free objects (`DeformableCar.freeObjects`): `count` of them live. */
  readonly bodies: THREE.Object3D[] = [];
  count = 0;
  /** The group `present` drew, which `restore` puts back. */
  private group: THREE.Object3D | null = null;
  private orders: THREE.EulerOrder[] = [];
  /** Before the last step, after it, and the sim's own while a blended pose is on show. */
  from = new Float64Array(N);
  to = new Float64Array(N);
  kept = new Float64Array(N);
  /** Per body: 1 when it is drawn as the sim has it (placed, or moved since the step). */
  private skip = new Uint8Array(1);
  /** Positions and normals of every mesh the skin writes (`DeformableCar.skinGeometries`). */
  private readonly skin: SkinTrack[] = [];
  /** The last step ran on these bodies. */
  stepped = false;
  drawn = false;

  constructor(car: DeformableCar) {
    for (const geometry of car.skinGeometries()) {
      for (const name of ["position", "normal"]) {
        const attr = geometry.getAttribute(name);
        if (attr instanceof THREE.BufferAttribute && attr.array instanceof Float32Array) this.skin.push(new SkinTrack(attr));
      }
    }
  }

  begin(car: DeformableCar): void {
    this.bodies[0] = car.group;
    const n = car.freeObjects(this.bodies, 1);
    this.count = n;
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
    for (let i = 0; i < this.count; i++) read(this.bodies[i]!, this.to, i);
    this.stepped = true;
  }

  /** Body `i` is drawn as it stands: placed in the last step (> `TELEPORT`), or moved since it. */
  private stays(i: number): boolean {
    const { from, to } = this;
    const k = i * N;
    const dx = to[k]! - from[k]!;
    const dy = to[k + 1]! - from[k + 1]!;
    const dz = to[k + 2]! - from[k + 2]!;
    return !same(this.bodies[i]!, to, i) || dx * dx + dy * dy + dz * dz > TELEPORT * TELEPORT;
  }

  /**
   * The skin's writes since the last frame taken at step count `steps`, and, `shown`, drawn at step time `now` (a placed
   * car's as written); with `alpha` < 1 the bodies too, `alpha` of the way through the last step.
   */
  present(group: THREE.Object3D, alpha: number, steps: number, now: number, shown: boolean): void {
    const placed = this.stays(0);
    for (let i = 0; i < this.skin.length; i++) {
      const track = this.skin[i]!;
      track.take(steps);
      if (placed) track.from = track.to;
      else if (shown) track.show(now);
    }
    if (!shown || !(alpha < 1)) return;
    const { bodies, from, to, kept } = this;
    this.group = group;
    for (let i = 0; i < this.count; i++) {
      const o = bodies[i]!;
      const k = i * N;
      read(o, kept, i);
      this.orders[i] = o.rotation.order;
      const stay = this.stays(i);
      this.skip[i] = stay ? 1 : 0;
      if (stay) continue;
      o.position.set(from[k]! + (to[k]! - from[k]!) * alpha, from[k + 1]! + (to[k + 1]! - from[k + 1]!) * alpha, from[k + 2]! + (to[k + 2]! - from[k + 2]!) * alpha);
      _q0.set(from[k + 3]!, from[k + 4]!, from[k + 5]!, from[k + 6]!);
      _q1.set(to[k + 3]!, to[k + 4]!, to[k + 5]!, to[k + 6]!);
      o.quaternion.copy(_q0.slerp(_q1, alpha));
    }
    // The root's matrix is what a first-person eye and the lamps read before the renderer composes the scene.
    group.updateWorldMatrix(false, false);
    this.drawn = true;
  }

  restore(): void {
    for (let i = 0; i < this.skin.length; i++) this.skin[i]!.restore();
    if (!this.drawn) return;
    for (let i = 0; i < this.count; i++) if (this.skip[i] === 0) write(this.bodies[i]!, this.kept, i, this.orders[i]!);
    this.group!.updateWorldMatrix(false, false);
    this.drawn = false;
  }
}

/**
 * Cars drawn between the last two sim states. The sim steps in whole slices (`SimPacer`), so a frame mostly lands inside
 * one: `present` puts every car (its group, and the torn parts and popped wheels flying free of it) where the frame's
 * time puts it between the pose before the last step and the one it left, `alpha` of the way, and `restore` hands the
 * sim its own poses back, exactly (`write`), once the frame is drawn. The sim never runs from, or is changed by, a drawn pose.
 *
 * The crush skin is written once a frame, after its steps (`DeformableCar.updateSkin`): `present` draws each skinned
 * mesh's positions and normals at the frame's time between that write and the one before it, on the steps counted
 * between them (`SkinTrack`); a frame that ran one step draws `alpha` of the way, as the bodies. `restore` puts the
 * written skin back.
 *
 * Per step: `begin` before it and `end` after it. A body that was placed (> `TELEPORT`) or moved since the step (a respawn
 * between frames) is drawn as it stands, and a placed car's skin as written.
 */
export class PoseBlend {
  private readonly cars = new WeakMap<DeformableCar, CarBlend>();
  /** The blends `present` drew this frame (`shownCount` of them), for `restore`. */
  private readonly shown: CarBlend[] = [];
  private shownCount = 0;
  /** Steps run so far (`end` calls): the clock the skin's writes are placed on. */
  private steps = 0;

  begin(cars: readonly DeformableCar[]): void {
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i]!;
      let c = this.cars.get(car);
      if (!c) this.cars.set(car, (c = new CarBlend(car)));
      c.begin(car);
    }
  }

  end(cars: readonly DeformableCar[]): void {
    this.steps++;
    for (let i = 0; i < cars.length; i++) this.cars.get(cars[i]!)?.end();
  }

  present(cars: readonly DeformableCar[], alpha: number): void {
    const a = alpha < 1 ? Math.max(0, alpha) : 1;
    const now = this.steps - 1 + a;
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i]!;
      const c = this.cars.get(car);
      if (!c?.stepped) continue;
      c.present(car.group, a, this.steps, now, car.group.visible);
      this.shown[this.shownCount++] = c;
    }
  }

  restore(): void {
    for (let i = 0; i < this.shownCount; i++) this.shown[i]!.restore();
    this.shownCount = 0;
  }
}
