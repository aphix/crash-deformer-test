import * as THREE from "three";
import { applyGroundFriction, CRASH, hypot2 } from "../deform/physics-util.ts";
import { GRAVITY } from "../kernel/constants.ts";
import { NO_FLOOR } from "../world/ground.ts";
import { C_GRIP, C_H, HIT_SIZE, pointContact, PQ_SIZE, PQ_X, PQ_Y, PQ_Z } from "../world/surfaces.ts";
import { DENT_MIN_DV, recordDent, type DentState } from "./loose-dent.ts";
import type { LooseBody, WorldBounce } from "./car-core.ts";

const _qSpin = new THREE.Quaternion();
const _n = new THREE.Vector3();
const _dv = new THREE.Vector3();
const _v0 = new THREE.Vector3();
const _q = new Float64Array(PQ_SIZE);
const _hit = new Float64Array(HIT_SIZE);

/** Height above its rest (m) at which a free body still slides on what is under it. */
const GROUND_BAND = 0.005;
/** Share of a free body's fall speed it bounces back up with off what it lands on. */
const LAND_BOUNCE = 0.28;

/**
 * A free body (a loose part, an FX bit) meets what is under it, as a tyre does (`pointContact`: the ground and the cars' tops, car
 * `skip`'s left out; -1: none): it rests `floor` m over it, bounces off it and, within `GROUND_BAND` of its rest, slides at Coulomb `mu`
 * times the surface's grip. Returns its height over that surface (Infinity where there is none: past the fleet disc's rim it falls on).
 */
export function landOn(pos: THREE.Vector3, vel: THREE.Vector3, floor: number, mu: number, dt: number, skip: number): number {
  _q[PQ_X] = pos.x;
  _q[PQ_Y] = pos.y;
  _q[PQ_Z] = pos.z;
  pointContact(_q, skip, _hit);
  const ground = _hit[C_H]!;
  if (ground === NO_FLOOR) return Infinity;
  const rest = ground + floor;
  if (pos.y < rest) {
    pos.y = rest;
    if (vel.y < 0) vel.y *= -LAND_BOUNCE;
  }
  if (pos.y <= rest + GROUND_BAND) applyGroundFriction(vel, dt, mu * _hit[C_GRIP]!, true);
  return pos.y - ground;
}

/**
 * A part or wheel off car `skip` (-1: none): gravity, tumble, the world's rigs (`bounce`), then `landOn` with a rest `floor` (m) and
 * the crash slide friction; its spin dies with its slide. Returns its height over what is under it (Infinity where there is none).
 */
export function stepLoose(p: LooseBody, dt: number, floor: number, skip: number, bounce?: WorldBounce, dent?: DentState): number {
  p.velocity.y -= GRAVITY * dt;
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
  const slide = hypot2(p.velocity.x, p.velocity.z);
  const over = landOn(p.object.position, p.velocity, floor, CRASH.muSlide, dt, skip);
  if (dent) {
    // A settled part's tiny velocity change never reaches recordDent.
    const dx = p.velocity.x - _v0.x;
    const dy = p.velocity.y - _v0.y;
    const dz = p.velocity.z - _v0.z;
    if (dx * dx + dy * dy + dz * dz >= DENT_MIN_DV * DENT_MIN_DV) recordDent(dent, p.object, _dv.set(dx, dy, dz));
  }
  if (over <= floor + GROUND_BAND) p.angular.multiplyScalar(slide > 1e-5 ? hypot2(p.velocity.x, p.velocity.z) / slide : 0);
  return over;
}
