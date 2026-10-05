import * as THREE from "three";
import { applyGroundFriction, CRASH } from "../deform/physics-util.ts";
import { activeGround, NO_FLOOR } from "../world/ground.ts";
import { DENT_MIN_DV, recordDent, type DentState } from "./loose-dent.ts";
import type { LooseBody, WorldBounce } from "./car-core.ts";

const _qSpin = new THREE.Quaternion();
const _n = new THREE.Vector3();
const _dv = new THREE.Vector3();
const _v0 = new THREE.Vector3();

/** Height above its rest (m) at which a loose part still slides on the ground. */
const GROUND_BAND = 0.005;

/** A part or wheel off the car: gravity, tumble, the world's walls, a floor at `floor` (m) and asphalt; none past the fleet disc's rim. */
export function stepLoose(p: LooseBody, dt: number, floor: number, bounce?: WorldBounce, dent?: DentState): void {
  p.velocity.y -= 9.6 * dt;
  p.object.position.addScaledVector(p.velocity, dt);
  const spin = p.angular.length();
  if (spin > 1e-5) {
    _n.copy(p.angular).multiplyScalar(1 / spin);
    _qSpin.setFromAxisAngle(_n, spin * dt);
    p.object.quaternion.premultiply(_qSpin);
  }
  p.angular.multiplyScalar(Math.pow(0.72, dt));
  if (dent) _v0.copy(p.velocity);
  bounce?.(p.object.position, p.velocity, Math.min(0.22, p.radius * 0.45));
  const q = p.object.position;
  const grounded = activeGround().heightAt(q.x, q.z, q.y) !== NO_FLOOR;
  if (grounded && q.y < floor) {
    q.y = floor;
    if (p.velocity.y < 0) p.velocity.y *= -0.28;
  }
  if (dent) {
    // A settled part's tiny velocity change never reaches recordDent.
    const dx = p.velocity.x - _v0.x;
    const dy = p.velocity.y - _v0.y;
    const dz = p.velocity.z - _v0.z;
    if (dx * dx + dy * dy + dz * dz >= DENT_MIN_DV * DENT_MIN_DV) recordDent(dent, p.object, _dv.set(dx, dy, dz));
  }
  if (grounded && q.y <= floor + GROUND_BAND) {
    // Sliding on asphalt: Coulomb friction per second, and the spin dies with the slide. The
    // band keeps the millimetre hops of the bounce in contact at any frame rate.
    const slide = Math.hypot(p.velocity.x, p.velocity.z);
    applyGroundFriction(p.velocity, dt, CRASH.muSlide, true);
    p.angular.multiplyScalar(slide > 1e-5 ? Math.hypot(p.velocity.x, p.velocity.z) / slide : 0);
  }
}
