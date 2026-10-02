import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import { DISC_GROUND, FLAT_GROUND, NO_FLOOR, type Ground } from "../world/ground.ts";
import { wallBounce, WALL_PROBES } from "../contact/pair-contact.ts";
import type { ContactHit, JerseyBarrier } from "./engine-props.ts";
import { BARRIER_HALF, BARRIER_TOP } from "../contact/sat.ts";

/**
 * The fleet's jump ramps (owner's sketch): two wedges on the jersey slab's long axis, the high end against each
 * slab end and sloping down away from it. While they are on, this is the fleet's ground: `DISC_GROUND` plus the
 * wedges and the slab's top, so the disc itself stays bit-identical with them off. Wheels and masses ride the
 * faces (and a jump that comes down on the slab rides its top) through `heightAt`; the wedges' side and back
 * faces are walls (`contact`), the slab's sides stay its own contact.
 */
export const RAMP = { start: BARRIER_HALF.z + 0.04, len: 4.6, halfW: 1.5, top: 1.2 } as const;
/** A face this far (m) or less above the asking body is a kerb it climbs; higher, it is the wedge's side or back. */
const CLIMB = 0.35;
/** Most a face pushes a car out per slice (m): a corner that came down deep in a wedge slides out, never teleports. */
const PUSH_CAP = 0.05;
const SLOPE = RAMP.top / RAMP.len;
const NORM = 1 / Math.hypot(1, SLOPE);

const _c = new THREE.Vector3();
const _n = new THREE.Vector3();

export class FleetRamps implements Ground {
  readonly group = new THREE.Group();
  /** Unit slab axis (plan), from the slab's yaw. */
  private ax = 0;
  private az = 1;
  /** The slab while it is in the scene (placed at the same yaw): its top is ground. */
  private slab: JerseyBarrier | null = null;

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

  /** Wedge face height at (x, z): 0 off both footprints. */
  private face(x: number, z: number): number {
    const u = x * this.ax + z * this.az;
    const a = Math.abs(u) - RAMP.start;
    if (a < 0 || a > RAMP.len || Math.abs(x * this.az - z * this.ax) > RAMP.halfW) return 0;
    return RAMP.top - a * SLOPE;
  }

  heightAt(x: number, z: number, y?: number): number {
    if (DISC_GROUND.heightAt(x, z, y) === NO_FLOOR) return NO_FLOOR;
    let h = this.face(x, z);
    const s = this.slab;
    if (s) {
      // Slab frame from the shared yaw: across = (cos, −sin), along = (sin, cos).
      const dx = x - s.group.position.x;
      const dz = z - s.group.position.z;
      if (Math.abs(dx * this.az - dz * this.ax) < s.hx() && Math.abs(dx * this.ax + dz * this.az) < BARRIER_HALF.z) h = BARRIER_TOP;
    }
    return y === undefined || h <= y + CLIMB ? h : 0;
  }

  normalAt<T extends { x: number; y: number; z: number }>(x: number, z: number, out: T, y?: number): T {
    const h = this.face(x, z);
    if (h <= 0 || (y !== undefined && h > y + CLIMB)) return FLAT_GROUND.normalAt(x, z, out);
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
   * The wedges' side and back faces against `car`: its deepest footprint probe under a face more than `CLIMB` above
   * it is pushed out sideways or back toward the slab through the race walls' `wallBounce`. A probe nearer the
   * kerb line above it than either face (a nose ahead of its centre's ground sample on the run, a corner coming
   * down on the face) is the ground's, not a wall. Returns the hit for the step's strongest contact.
   */
  contact(car: DeformableCar): ContactHit | null {
    const pos = car.group.position;
    if (Math.abs(pos.x * this.ax + pos.z * this.az) > RAMP.start + RAMP.len + 2.5) return null;
    let pen = 0;
    let nx = 0;
    let nz = 0;
    for (const [ox, oz] of WALL_PROBES) {
      const px = pos.x + car.right.x * ox + car.forward.x * oz;
      const py = pos.y + car.right.y * ox + car.forward.y * oz;
      const pz = pos.z + car.right.z * ox + car.forward.z * oz;
      const u = px * this.ax + pz * this.az;
      const v = px * this.az - pz * this.ax;
      const side = RAMP.halfW - Math.abs(v);
      const back = Math.abs(u) - RAMP.start;
      if (side < 0 || back < 0 || back > RAMP.len) continue;
      const over = Math.min(side, back);
      // Depth below the face's kerb line (> 0: under a face more than CLIMB above it).
      const up = RAMP.top - back * SLOPE - py - CLIMB;
      if (up <= over || over <= pen) continue;
      pen = over;
      _c.set(px, py + 0.4, pz);
      if (side < back) {
        const s = v >= 0 ? 1 : -1;
        nx = this.az * s;
        nz = -this.ax * s;
      } else {
        const s = u >= 0 ? -1 : 1;
        nx = this.ax * s;
        nz = this.az * s;
      }
    }
    if (pen <= 0) return null;
    const closing = Math.max(0, -(car.velocity.x * nx + car.velocity.z * nz));
    _n.set(nx, 0, nz);
    wallBounce(car, nx, nz, Math.min(pen, PUSH_CAP), closing, _c, _n);
    car.deform.notifyContact();
    return { impulse: Math.max(closing, 0.5), contact: _c.clone(), normal: _n.clone() };
  }
}
