import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import { HULL, MU_TYRE } from "../vehicle/car-air.ts";
import { UNDERSIDE } from "../vehicle/car-suspension.ts";
import { CLASSES, carClass } from "../vehicle/vehicle-classes.ts";
import { DISC_GROUND, FLAT_GROUND, NO_FLOOR, type Ground } from "../world/ground.ts";
import { wallBounce, WALL_PROBES } from "../contact/pair-contact.ts";
import { TYRE_R } from "../deform/deform-state.ts";
import type { ContactHit, JerseyBarrier } from "./engine-props.ts";
import { BARRIER_HALF, BARRIER_TOP } from "../contact/sat.ts";

/**
 * The fleet's jump ramps (owner's sketch): two wedges on the jersey slab's long axis, the high end against each
 * slab end and sloping down away from it. While they are on, this is the fleet's ground: `DISC_GROUND` plus the
 * wedges and the slab's top, so the disc itself stays bit-identical with them off. Wheels and masses ride the
 * faces (and a jump that comes down on the slab rides its top) through `heightAt`; the wedges' side and back
 * faces are walls (`contact`), the slab's sides stay its own contact. Ground and wall are ONE rule (`onFace`): a
 * point either stands on the face or is in the wall, so nothing of a car, tyre or hull, is left between them.
 */
export const RAMP = { start: BARRIER_HALF.z + 0.04, len: 4.6, halfW: 1.5, top: 1.2 } as const;
/**
 * How far (m) the ground lets a body climb in one step: a face this far or less above the asking body (plus how deep it is in the
 * wall, `onFace`) is under it, higher it is the wedge's side or back. It is the lookahead of a car's support on the face (its axle
 * chord reaches half a wheelbase up the run, 1.34 m x the 0.26 slope = 0.35 m), not the step a tyre mounts (`MOUNT`).
 */
const CLIMB = 0.35;
/** Most a face pushes a car out per slice (m): a corner that came down deep in a wedge slides out, never teleports. */
const PUSH_CAP = 0.05;
/**
 * The step a tyre mounts, as a share of its radius, by grip alone. A step of height s puts the contact normal at the tyre's edge
 * asin(1 - s/r) over the horizontal, and the tyre climbs while that is steeper than the friction angle atan(1/mu): s <= r (1 - 1/sqrt(1 + mu^2)),
 * 0.26 r at the tyre's mu (a sedan's 0.32 m tyre mounts 8 cm, a monster's 0.54 m tyre 14 cm). `CLIMB` (0.35 m) was above a sedan's whole radius.
 */
const MOUNT = 1 - 1 / Math.sqrt(1 + MU_TYRE ** 2);
/** The tallest step any class's tyre mounts (m): what the ground asks of a body it cannot tell the class of. */
const MOUNT_MAX = MOUNT * TYRE_R * Math.max(...Object.values(CLASSES).map((c) => c.wheelScale));
/**
 * How far (m) from a side wall the ground is the floor for a body to whom the face above is a wall (higher than `MOUNT_MAX`):
 * on both sides of the wall's plane the ground then agrees with the wall's push, so a car pressed to the wall is not flipped
 * every slice between the face's pose (the plane's side where the face is within `CLIMB`) and the floor's. Twice the push per slice.
 */
const WALL_SKIN = 2 * PUSH_CAP;
/**
 * How far (m) under a face a body point (hull, belly) may be and still stand on it, before the wall takes it: a body does not climb
 * a kerb the way a tyre does, but it lags a face it is climbing onto (its springs, its support plane), and its low front
 * (the keel is 3 cm over the tyre plane 0.66 m ahead of the front axle) reaches a face before the tyre does. Swept 0.02 / 0.05 / 0.1 /
 * 0.2 on the drop matrix: ramp cells failing 35 / 34 / 33 / 26, the deepest belly-in-ramp rest 28 / 33 / 12 / 14 cm.
 */
const SKIN = 0.2;
/** Half the tread's width (m) at wheel scale 1: the shoulder the tyre's plan rectangle ends at (`TREAD` in car-suspension). */
const TREAD_HALF = 0.104;
const SIGNS = [-1, 1] as const;
const SLOPE = RAMP.top / RAMP.len;
const NORM = 1 / Math.hypot(1, SLOPE);

const _c = new THREE.Vector3();
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();

export class FleetRamps implements Ground {
  readonly group = new THREE.Group();
  /** Unit slab axis (plan), from the slab's yaw. */
  private ax = 0;
  private az = 1;
  /** The slab while it is in the scene (placed at the same yaw): its top is ground. */
  private slab: JerseyBarrier | null = null;
  /** The deepest wall point of the current `contact` (m inside the wall) and its push direction. */
  private pen = 0;
  private nx = 0;
  private nz = 0;

  constructor(scene: THREE.Scene) {
    const shape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(RAMP.len, 0), new THREE.Vector2(0, RAMP.top)]);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: RAMP.halfW * 2, bevelEnabled: false });
    geo.translate(0, 0, -RAMP.halfW);
    const mat = new THREE.MeshStandardMaterial({ color: 0xb08850, roughness: 0.85, metalness: 0.02 });
    for (const side of [1, -1]) {
      const m = new THREE.Mesh(geo, mat);
      // Local +x (up the run, away from the slab) along side × axis; the slab's yaw is added in `place`.
      m.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
      m.position.set(0, 0, side * RAMP.start);
      m.castShadow = true;
      m.receiveShadow = true;
      this.group.add(m);
    }
    this.group.visible = false;
    scene.add(this.group);
  }

  /** Line the wedges up on the slab's long axis (`JerseyBarrier.orient`'s yaw); `slab` while it is in the scene. */
  place(yaw: number, slab: JerseyBarrier | null): void {
    this.ax = Math.sin(yaw);
    this.az = Math.cos(yaw);
    this.group.rotation.y = yaw;
    this.slab = slab;
  }

  /**
   * The one rule for ground and wall. A point `a` m in from a wedge's high end and `side` m in from its side wall, at
   * height `y` (any when omitted), stands on the face while the face is at most `kerb` above it plus `reach` times how far it
   * already is inside the nearest wall (the way out upward is then shorter than the way out sideways); deeper under the face than
   * that the wall is nearer, and the way out is sideways (`contact`). Returns the face's height, 0 where the point is off the
   * footprint or in the wall. (`heightAt` once stopped at `CLIMB` alone, so a tyre between that and the wall probes stood on
   * the floor inside the wedge.)
   */
  private onFace(a: number, side: number, y?: number, kerb = CLIMB, reach = 1): number {
    if (a < 0 || a > RAMP.len || side < 0) return 0;
    const h = RAMP.top - a * SLOPE;
    if (y === undefined) return h;
    // Beside a side wall: the floor, to a body the face above is a wall to.
    if (side < WALL_SKIN && h - y > MOUNT_MAX) return 0;
    return h - y <= kerb + reach * Math.min(a, side) ? h : 0;
  }

  private face(x: number, z: number, y?: number): number {
    return this.onFace(Math.abs(x * this.ax + z * this.az) - RAMP.start, RAMP.halfW - Math.abs(x * this.az - z * this.ax), y);
  }

  heightAt(x: number, z: number, y?: number): number {
    if (DISC_GROUND.heightAt(x, z, y) === NO_FLOOR) return NO_FLOOR;
    const s = this.slab;
    if (s) {
      // Slab frame from the shared yaw: across = (cos, −sin), along = (sin, cos).
      const dx = x - s.group.position.x;
      const dz = z - s.group.position.z;
      if (Math.abs(dx * this.az - dz * this.ax) < s.hx() && Math.abs(dx * this.ax + dz * this.az) < BARRIER_HALF.z) return y === undefined || BARRIER_TOP <= y + CLIMB ? BARRIER_TOP : 0;
    }
    return this.face(x, z, y);
  }

  normalAt<T extends { x: number; y: number; z: number }>(x: number, z: number, out: T, y?: number): T {
    if (this.face(x, z, y) <= 0) return FLAT_GROUND.normalAt(x, z, out);
    const s = (x * this.ax + z * this.az >= 0 ? SLOPE : -SLOPE) * NORM;
    out.x = this.ax * s;
    out.y = NORM;
    out.z = this.az * s;
    return out;
  }

  frictionAt(x: number, z: number, y?: number): number {
    return DISC_GROUND.frictionAt(x, z, y);
  }

  surfaceAt(): "asphalt" {
    return "asphalt";
  }

  /**
   * The wedges' side and back faces against `car`, through the rule `onFace` gives the ground: a point of the car
   * that is inside a wedge and not on its face is in the wall, and the deepest such point pushes the car out
   * sideways or back toward the slab through the race walls' `wallBounce`. The points are the body's footprint
   * (`WALL_PROBES` at its floor), each tyre's plan rectangle (four corners at its bottom), and the hull as the
   * physics reads it (bumper, beltline and roof corners, the underside): a tyre or a belly that cannot climb the
   * face is stopped by the wall like the footprint, so no part of a car rests inside a wedge, whatever its pose.
   * Returns the hit for the step's strongest contact.
   */
  contact(car: DeformableCar): ContactHit | null {
    const pos = car.group.position;
    // A car's farthest point is 2.5 m from its origin (a rolled one's roof 1.4 m up): past that of the wedges' footprint, nothing of it can touch them.
    if (Math.abs(pos.x * this.ax + pos.z * this.az) > RAMP.start + RAMP.len + 2.5 || Math.abs(pos.x * this.az - pos.z * this.ax) > RAMP.halfW + 2.5) return null;
    this.pen = 0;
    for (const [ox, oz] of WALL_PROBES) this.probe(car, ox, 0, oz, CLIMB, 1);
    for (const wheel of car.wheels) {
      const { x, z } = wheel.position;
      const r = TYRE_R * wheel.scale.x;
      const hw = TREAD_HALF * wheel.scale.x;
      for (const sx of SIGNS) for (const sz of SIGNS) this.probe(car, x + sx * hw, 0, z + sz * r, MOUNT * r, 1);
    }
    for (let i = 4; i < HULL.length; i++) this.probe(car, HULL[i]![0], HULL[i]![1], HULL[i]![2], SKIN, 0);
    const lift = CLASSES[carClass(car)].lift;
    for (const [x, z, h] of UNDERSIDE) this.probe(car, x, h + lift, z, SKIN, 0);
    if (this.pen <= 0) return null;
    const { nx, nz } = this;
    const closing = Math.max(0, -(car.velocity.x * nx + car.velocity.z * nz));
    _n.set(nx, 0, nz);
    wallBounce(car, nx, nz, Math.min(this.pen, PUSH_CAP), closing, _c, _n);
    car.deform.notifyContact();
    return { impulse: Math.max(closing, 0.5), contact: _c.clone(), normal: _n.clone() };
  }

  /**
   * One car-local point against the wedges: if it is in a wall (inside a wedge, not on its face) and deeper than `contact`'s
   * deepest so far, it becomes the push. `kerb` and `reach` are the point's `onFace` rule: the body's footprint climbs `CLIMB` plus
   * the depth it is in (`reach` 1), a tyre only the step it mounts (`MOUNT` of its radius, plus the depth), a body point (hull, belly)
   * `SKIN` and no depth bias.
   */
  private probe(car: DeformableCar, x: number, y: number, z: number, kerb: number, reach: number): void {
    _p.set(x, y, z).applyQuaternion(car.group.quaternion).add(car.group.position);
    const u = _p.x * this.ax + _p.z * this.az;
    const v = _p.x * this.az - _p.z * this.ax;
    const side = RAMP.halfW - Math.abs(v);
    const back = Math.abs(u) - RAMP.start;
    if (side < 0 || back < 0 || back > RAMP.len) return;
    const over = Math.min(side, back);
    if (over <= this.pen || this.onFace(back, side, _p.y, kerb, reach) > 0) return;
    this.pen = over;
    _c.set(_p.x, _p.y + 0.4, _p.z);
    if (side < back) {
      const s = v >= 0 ? 1 : -1;
      this.nx = this.az * s;
      this.nz = -this.ax * s;
    } else {
      const s = u >= 0 ? -1 : 1;
      this.nx = this.ax * s;
      this.nz = this.az * s;
    }
  }
}
