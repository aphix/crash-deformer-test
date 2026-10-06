import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import { HULL } from "../vehicle/car-air.ts";
import { UNDERSIDE } from "../vehicle/car-suspension.ts";
import { CLASSES, carClass } from "../vehicle/vehicle-classes.ts";
import { DISC_RADIUS, Ground, STEP_UP } from "../world/ground.ts";
import { MOUNT } from "../world/surfaces.ts";
import { wallBounce } from "../contact/pair-contact.ts";
import { makeBox, solidFace } from "../contact/external-contact.ts";
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
/** Fastest a face pushes a car out (m/s): a corner that came down deep in a wedge slides out, never teleports (a step's push stays under 1 cm). */
const PUSH_SPEED = 1;
/** A pushed point ends this far (m) outside the wall, so the push leaves nothing on its plane. */
const PUSH_SKIN = 0.002;
/** The tallest step any class's tyre mounts (m): what the ground asks of a body it cannot tell the class of (`MOUNT`: by grip alone, 0.26 r). `CLIMB` (0.35 m) was above a sedan's whole radius. */
/** The tallest step any class's tyre mounts (m): what the ground asks of a body it cannot tell the class of. */
const MOUNT_MAX = MOUNT * TYRE_R * Math.max(...Object.values(CLASSES).map((c) => c.wheelScale));
/**
 * How far (m) from a side wall the ground is the floor for a body to whom the face above is a wall (higher than `MOUNT_MAX`):
 * on both sides of the wall's plane the ground then agrees with the wall's push, so a car pressed to the wall is not flipped
 * every slice between the face's pose (the plane's side where the face is within `CLIMB`) and the floor's. Twice the push per slice.
 */
const WALL_SKIN = 0.02;
/** Half the tread's flat (m) at wheel scale 1: the plan rectangle a tyre meets a wall with; its rounded shoulders (the other 5 cm of the 10.4 cm half tread) give. */
const TREAD_HALF = 0.054;
const SIGNS = [-1, 1] as const;
const SLOPE = RAMP.top / RAMP.len;
/**
 * A wedge's face across its width, as one patch per strip: v0 (m across from the wedge's axis), width, and how far (m) the face may be above
 * a point and still be under it. Beside a side wall (within `WALL_SKIN` of it) the face above `MOUNT_MAX` is a wall to a tyre, not floor;
 * elsewhere a body climbs the face while it is at most `CLIMB` above it.
 */
const STRIPS: readonly (readonly [number, number, number])[] = [
  [-RAMP.halfW, WALL_SKIN, MOUNT_MAX],
  [-RAMP.halfW + WALL_SKIN, 2 * RAMP.halfW - 2 * WALL_SKIN, CLIMB],
  [RAMP.halfW - WALL_SKIN, WALL_SKIN, MOUNT_MAX],
];

const _c = new THREE.Vector3();
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();
const _face = makeBox();

export class FleetRamps extends Ground {
  readonly group = new THREE.Group();
  /** Its wedges' sides and ends are walls `contact` parts a body from. */
  override readonly walls = true;
  /** Unit slab axis (plan), from the slab's yaw. */
  private ax = 0;
  private az = 1;
  /** The slab while it is in the scene (placed at the same yaw): its top is ground. */
  private slab: JerseyBarrier | null = null;
  /** The deepest wall point of the current `contact` (m inside the wall) and its push direction. */
  private pen = 0;
  private nx = 0;
  private nz = 0;
  /** The middle of that wall's face (plan) and its half width (m): the face a hard hit meets as a solid (`wallBounce`). */
  private mx = 0;
  private mz = 0;
  private hw = 0;
  /** The slab top's patch, and the wedges' face patches: `STRIPS.length` per wedge (`place` turns them with the slab's yaw). */
  private readonly slabTop: number;
  private readonly faces: number[] = [];

  constructor(scene: THREE.Scene) {
    super();
    this.addPlane(0, -DISC_RADIUS, DISC_RADIUS, -DISC_RADIUS, DISC_RADIUS, STEP_UP, DISC_RADIUS);
    this.slabTop = this.addPlane(BARRIER_TOP, -BARRIER_HALF.x, BARRIER_HALF.x, -BARRIER_HALF.z, BARRIER_HALF.z, CLIMB);
    this.setSolid(this.slabTop, false);
    for (let k = 0; k < 2; k++) {
      for (let s = 0; s < STRIPS.length; s++) {
        const [v0, w, reach] = STRIPS[s]!;
        this.faces[k * STRIPS.length + s] = this.addGrid({ nu: 2, nv: 2, step: RAMP.len, stepV: w, u0: 0, v0, heights: new Float32Array([RAMP.top, 0, RAMP.top, 0]), ox: 0, oy: 0, oz: 0, reach });
      }
    }
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
    this.place(0, null);
  }

  /** Line the wedges up on the slab's long axis (`JerseyBarrier.orient`'s yaw); `slab` while it is in the scene. */
  place(yaw: number, slab: JerseyBarrier | null): void {
    this.ax = Math.sin(yaw);
    this.az = Math.cos(yaw);
    this.group.rotation.y = yaw;
    this.slab = slab;
    // Each wedge's frame: u runs from its high end (against the slab's end) out along the slab's axis, v across it.
    for (let k = 0; k < 2; k++) {
      const side = k === 0 ? 1 : -1;
      const dx = side * this.ax;
      const dz = side * this.az;
      for (let s = 0; s < STRIPS.length; s++) this.setFrame(this.faces[k * STRIPS.length + s]!, dx * RAMP.start, 0, dz * RAMP.start, [dx, 0, dz, 0, 1, 0, -dz, 0, dx]);
    }
    this.refreshSlab();
  }

  /** The slab's top, as wide as the slab is now (it crumples) and turned as it is, or nothing while it is out of the scene. */
  private refreshSlab(): void {
    const s = this.slab;
    if (!s) {
      this.disable(this.slabTop);
      return;
    }
    this.setFrame(this.slabTop, s.group.position.x, 0, s.group.position.z, [this.az, 0, -this.ax, 0, 1, 0, this.ax, 0, this.az]);
    this.setRect(this.slabTop, -s.hx(), -BARRIER_HALF.z, 2 * s.hx(), 2 * BARRIER_HALF.z);
  }

  /**
   * The wedges' side and back faces against `car`, through the one rule the ground gives (`heightAt`): a point of the car
   * that is inside a wedge and not on its face is in the wall, and the deepest such point pushes the car out
   * sideways or back toward the slab through the race walls' `wallBounce`: a light touch pushes out, a hard hit
   * crushes as the range's slab does (the face is a solid). The points are each tyre's plan rectangle (four corners at its
   * bottom) and the hull as the physics reads it (bumper, beltline and roof corners, the underside): a tyre or a belly
   * that cannot climb the face is stopped by the wall, so no part of a car rests inside a wedge, whatever its pose.
   * `dt` is the slice's time (s). Returns the hit for the step's strongest contact.
   */
  contact(car: DeformableCar, dt: number): ContactHit | null {
    this.refreshSlab();
    const pos = car.group.position;
    // A car's farthest point is 2.5 m from its origin (a rolled one's roof 1.4 m up): past that of the wedges' footprint, nothing of it can touch them.
    if (Math.abs(pos.x * this.ax + pos.z * this.az) > RAMP.start + RAMP.len + 2.5 || Math.abs(pos.x * this.az - pos.z * this.ax) > RAMP.halfW + 2.5) return null;
    this.pen = 0;
    for (const wheel of car.wheels) {
      const { x, z } = wheel.position;
      const r = TYRE_R * wheel.scale.x;
      const hw = TREAD_HALF * wheel.scale.x;
      for (const sx of SIGNS) for (const sz of SIGNS) this.probe(car, x + sx * hw, 0, z + sz * r);
    }
    for (let i = 4; i < HULL.length; i++) this.probe(car, HULL[i]![0], HULL[i]![1], HULL[i]![2]);
    const lift = CLASSES[carClass(car)].lift;
    for (const [x, z, h] of UNDERSIDE) this.probe(car, x, h + lift, z);
    if (this.pen <= 0) return null;
    const { nx, nz } = this;
    const closing = Math.max(0, -(car.velocity.x * nx + car.velocity.z * nz));
    _n.set(nx, 0, nz);
    // The face holds the masses within `CLIMB` of it: deeper, a mass is riding the wedge's slope (over the footprint of the flank and the end),
    // not in its wall. A 2 m thick face threw a wreck climbing the ramp out through the end it was climbing to (D1: 2.1 m in one slice).
    wallBounce(car, solidFace(_face, nx, nz, this.mx, this.mz, this.mx, this.mz, this.hw, CLIMB), nx, nz, Math.min(this.pen + PUSH_SKIN, PUSH_SPEED * dt), dt);
    car.deform.notifyContact();
    return { impulse: Math.max(closing, 0.5), contact: _c.clone(), normal: _n.clone() };
  }

  /**
   * One car-local point against the wedges: if it is inside a wedge's footprint and not standing on its face (the one rule
   * `heightAt` answers: the face within its strip's reach above the point) it is in the wall; the deepest such point so far
   * becomes `contact`'s push.
   */
  private probe(car: DeformableCar, x: number, y: number, z: number): void {
    _p.set(x, y, z).applyQuaternion(car.group.quaternion).add(car.group.position);
    const u = _p.x * this.ax + _p.z * this.az;
    const v = _p.x * this.az - _p.z * this.ax;
    const side = RAMP.halfW - Math.abs(v);
    const back = Math.abs(u) - RAMP.start;
    if (side < 0 || back < 0 || back > RAMP.len) return;
    const over = Math.min(side, back);
    if (over <= this.pen || this.heightAt(_p.x, _p.z, _p.y) > 0) return;
    this.pen = over;
    _c.set(_p.x, _p.y + 0.4, _p.z);
    // The wall's face: a side's plane `RAMP.halfW` off the slab's axis along the wedge, or the back's against the slab's end across it.
    let u0: number;
    let v0: number;
    if (side < back) {
      const s = v >= 0 ? 1 : -1;
      this.nx = this.az * s;
      this.nz = -this.ax * s;
      u0 = (u >= 0 ? 1 : -1) * (RAMP.start + RAMP.len / 2);
      v0 = s * RAMP.halfW;
      this.hw = RAMP.len / 2;
    } else {
      const s = u >= 0 ? -1 : 1;
      this.nx = this.ax * s;
      this.nz = this.az * s;
      u0 = -s * RAMP.start;
      v0 = 0;
      this.hw = RAMP.halfW;
    }
    this.mx = u0 * this.ax + v0 * this.az;
    this.mz = u0 * this.az - v0 * this.ax;
  }
}
