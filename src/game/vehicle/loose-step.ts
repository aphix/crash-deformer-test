import * as THREE from "three";
import { applyGroundFriction, CRASH } from "../deform/physics-util.ts";
import { GRAVITY } from "../kernel/constants.ts";
import { detCos, detSin } from "../kernel/physics-core.js";
import { NO_FLOOR } from "../world/ground.ts";
import { C_DEPTH, C_GRIP, C_H, C_NX, C_NY, C_NZ, clearOf, HIT_SIZE, holdTops, pointContact, pointContactHeld, PQ_SIZE, PQ_VX, PQ_VY, PQ_VZ, PQ_X, PQ_Y, PQ_Z, stirNear } from "../world/surfaces.ts";
import { BOUNCE_V, RESTITUTION } from "./car-air.ts";
import { DENT_MIN_DV, recordDent, type DentState } from "./loose-dent.ts";
import type { LooseBody, LooseShape } from "./car-core.ts";

const _qSpin = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const _dv = new THREE.Vector3();
const _v0 = new THREE.Vector3();
const _q = new Float64Array(PQ_SIZE);
const _hit = new Float64Array(HIT_SIZE);

/** Height above its rest (m) at which a free body still slides on what is under it. */
const GROUND_BAND = 0.005;
/** Share of a free body's fall speed it bounces back up with off what it lands on. */
const LAND_BOUNCE = 0.28;

/**
 * A free point (an FX bit: a spark, a glass dot, a metal chip) meets what is under it and beside it by the one point query
 * (`pointContact`: the ground, the prisms of the scene and the cars' tops, car `skip`'s left out; -1: none). A side it is in
 * parts it (out by its depth and its radius `floor`, its inbound speed along the face gone); under it, it rests `floor` m over the surface,
 * bounces off it and, within `GROUND_BAND` of its rest, slides at Coulomb `mu` times the surface's grip. Returns its height over that
 * surface (Infinity where there is none: past the fleet disc's rim it falls on).
 */
export function landOn(pos: THREE.Vector3, vel: THREE.Vector3, floor: number, mu: number, dt: number, skip: number): number {
  _q[PQ_X] = pos.x;
  _q[PQ_Y] = pos.y;
  _q[PQ_Z] = pos.z;
  _q[PQ_VX] = vel.x;
  _q[PQ_VY] = vel.y;
  _q[PQ_VZ] = vel.z;
  pointContact(_q, skip, _hit);
  if (_hit[C_H] === NO_FLOOR && _hit[C_DEPTH]! > 0) {
    const nx = _hit[C_NX]!;
    const nz = _hit[C_NZ]!;
    const out = _hit[C_DEPTH]! + floor;
    pos.x += nx * out;
    pos.z += nz * out;
    const inbound = vel.x * nx + vel.z * nz;
    if (inbound < 0) {
      vel.x -= inbound * nx;
      vel.z -= inbound * nz;
    }
    _q[PQ_X] = pos.x;
    _q[PQ_Z] = pos.z;
    pointContact(_q, skip, _hit);
  }
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

/** The body's own points, as many as its shape can hold: a box's eight corners and twelve edge middles, a wheel's two rims. */
const SHAPE_POINTS = 20;

/** A shape for a body of at most `SHAPE_POINTS` points, empty until `boxShape` or `wheelShape` fills it. */
export function newLooseShape(): LooseShape {
  return { points: new Float64Array(3 * SHAPE_POINTS), count: 0, centre: new THREE.Vector3(), invI: new THREE.Vector3(), reach: 0, asleep: false, airborne: false };
}

/** The thinnest a box's half extent is taken (m): a sheet of no thickness would have no spin about its own length. */
const MIN_HALF = 0.01;
const _box = new THREE.Box3();
const _geoBox = new THREE.Box3();
const _size = new THREE.Vector3();

/** `object`'s meshes' bounds in its own frame, unioned into `_box` (`m`: the frame of `o` in `object`'s). */
function growBox(o: THREE.Object3D, m: THREE.Matrix4): void {
  if (o instanceof THREE.Mesh) {
    const geo = o.geometry as THREE.BufferGeometry;
    geo.boundingBox ?? geo.computeBoundingBox();
    _box.union(_geoBox.copy(geo.boundingBox!).applyMatrix4(m));
  }
  for (const child of o.children) growBox(child, new THREE.Matrix4().multiplyMatrices(m, child.matrix));
}

/**
 * `shape` as `object`'s box in its own frame, as drawn: its eight corners and twelve edge middles about the box's middle, and the inverse
 * inertia per unit mass of a solid box that size (a hood is a sheet: its spin about its own length is as easy as its tilt). Measured once
 * per part, when it first flies (`stepLoose`), and again when it has been put back on its car (`count` 0).
 */
function boxShape(shape: LooseShape, object: THREE.Object3D): void {
  _box.makeEmpty();
  growBox(object, new THREE.Matrix4());
  if (_box.isEmpty()) _box.set(_size.set(-MIN_HALF, -MIN_HALF, -MIN_HALF), _geoBox.max.set(MIN_HALF, MIN_HALF, MIN_HALF));
  _box.getCenter(shape.centre);
  _box.getSize(_size).multiplyScalar(0.5);
  const hx = Math.max(MIN_HALF, _size.x);
  const hy = Math.max(MIN_HALF, _size.y);
  const hz = Math.max(MIN_HALF, _size.z);
  // The eight corners, then the middle of each of the twelve edges (a part across a roof's ridge rests on the ridge, not on its corners).
  for (let c = 0; c < 8; c++) {
    shape.points[c * 3] = c & 1 ? hx : -hx;
    shape.points[c * 3 + 1] = c & 2 ? hy : -hy;
    shape.points[c * 3 + 2] = c & 4 ? hz : -hz;
  }
  for (let e = 0; e < 12; e++) {
    const o = (8 + e) * 3;
    const axis = e >> 2;
    shape.points[o] = axis === 0 ? 0 : e & 1 ? hx : -hx;
    shape.points[o + 1] = axis === 1 ? 0 : e & (axis === 0 ? 1 : 2) ? hy : -hy;
    shape.points[o + 2] = axis === 2 ? 0 : e & 2 ? hz : -hz;
  }
  shape.invI.set(3 / (hy * hy + hz * hz), 3 / (hx * hx + hz * hz), 3 / (hx * hx + hy * hy));
  shape.count = 20;
  shape.reach = Math.sqrt(hx * hx + hy * hy + hz * hz);
  shape.asleep = false;
  shape.airborne = false;
}

/** `shape` as a wheel of `radius` and `width` (m), axle along its x: eight points round each rim; the inertia of a solid disk. */
export function wheelShape(shape: LooseShape, radius: number, width: number): void {
  shape.centre.set(0, 0, 0);
  for (let k = 0; k < 16; k++) {
    const a = ((k & 7) / 8) * 2 * Math.PI;
    shape.points[k * 3] = k < 8 ? -width / 2 : width / 2;
    shape.points[k * 3 + 1] = radius * detSin(a);
    shape.points[k * 3 + 2] = radius * detCos(a);
  }
  shape.invI.set(2 / (radius * radius), 1 / (radius * radius * 0.25 + (width * width) / 12), 1 / (radius * radius * 0.25 + (width * width) / 12));
  shape.count = 16;
  shape.reach = Math.sqrt(radius * radius + (width * width) / 4);
  shape.asleep = false;
  shape.airborne = false;
}

/** Passes of the contact solve over a slice's rows. */
const PASSES = 8;
/** Per contact row, its numbers: the point from the centre (3), the face's normal (3), its depth, the normal speed it must end with, the normal impulse it has given, the friction impulse held (3), its Coulomb coefficient. */
const ROW = 13;
const R_R = 0;
const R_N = 3;
const R_PEN = 6;
const R_TARGET = 7;
const R_ACC = 8;
const R_FRIC = 9;
const R_MU = 12;
const rows = new Float64Array(SHAPE_POINTS * ROW);

const _c = new THREE.Vector3();
const _r = new THREE.Vector3();
const _n = new THREE.Vector3();
const _vp = new THREE.Vector3();
const _t = new THREE.Vector3();
const _d = new THREE.Vector3();
const _x = new THREE.Vector3();

/** Scalars a solver step hands between its functions (a double passed or returned across a call is boxed when the call is not inlined): the impulse to push, the reach read. */
const _s = new Float64Array(3);
const S_J = 0;
const S_REACH = 1;
const S_MOVE = 2;
/** The impulse (m/s per unit mass) a whole pass of the contact solve moves, under which the next passes change nothing. */
const SETTLED = 1e-9;
/** The body's inverse inertia (per unit mass) in the world frame: six numbers xx, xy, xz, yy, yz, zz, from `worldInertia`. */
const _m = new Float64Array(6);

/** `_m` for the body at orientation `q`: R diag(invI) Rᵀ, once per step (the solver's passes read it; the orientation does not change in them). */
export function worldInertia(q: THREE.Quaternion, shape: LooseShape): void {
  const xx = q.x * q.x;
  const yy = q.y * q.y;
  const zz = q.z * q.z;
  const xy = q.x * q.y;
  const xz = q.x * q.z;
  const yz = q.y * q.z;
  const wx = q.w * q.x;
  const wy = q.w * q.y;
  const wz = q.w * q.z;
  const r00 = 1 - 2 * (yy + zz);
  const r01 = 2 * (xy - wz);
  const r02 = 2 * (xz + wy);
  const r10 = 2 * (xy + wz);
  const r11 = 1 - 2 * (xx + zz);
  const r12 = 2 * (yz - wx);
  const r20 = 2 * (xz - wy);
  const r21 = 2 * (yz + wx);
  const r22 = 1 - 2 * (xx + yy);
  const a = shape.invI.x;
  const b = shape.invI.y;
  const c = shape.invI.z;
  _m[0] = r00 * r00 * a + r01 * r01 * b + r02 * r02 * c;
  _m[1] = r00 * r10 * a + r01 * r11 * b + r02 * r12 * c;
  _m[2] = r00 * r20 * a + r01 * r21 * b + r02 * r22 * c;
  _m[3] = r10 * r10 * a + r11 * r11 * b + r12 * r12 * c;
  _m[4] = r10 * r20 * a + r11 * r21 * b + r12 * r22 * c;
  _m[5] = r20 * r20 * a + r21 * r21 * b + r22 * r22 * c;
}

/** `x` through the body's inverse inertia (`_m`), in place. */
export function invInertia(x: THREE.Vector3): THREE.Vector3 {
  const a = x.x;
  const b = x.y;
  const c = x.z;
  return x.set(_m[0]! * a + _m[1]! * b + _m[2]! * c, _m[1]! * a + _m[3]! * b + _m[4]! * c, _m[2]! * a + _m[4]! * b + _m[5]! * c);
}

/** Unit-mass impulse `_s[S_J]` along `dir` at `r` from the centre, into the body's velocity `v` and spin `w`. */
function push(v: THREE.Vector3, w: THREE.Vector3, r: THREE.Vector3, dir: THREE.Vector3): void {
  const j = _s[S_J]!;
  v.x += dir.x * j;
  v.y += dir.y * j;
  v.z += dir.z * j;
  invInertia(_x.crossVectors(r, dir));
  w.x += _x.x * j;
  w.y += _x.y * j;
  w.z += _x.z * j;
}

/** The speed change per unit impulse along `dir` at `r` (1 / the body's effective mass there, unit mass), into `_s[S_REACH]`. */
function reach(r: THREE.Vector3, dir: THREE.Vector3): void {
  invInertia(_x.crossVectors(r, dir)).cross(r);
  _s[S_REACH] = 1 + (_x.x * dir.x + _x.y * dir.y + _x.z * dir.z);
}

/**
 * One slice of a torn part's or a popped wheel's flight (`p.velocity` its middle's, `p.angular` its spin): the body's points (a part's
 * box's eight corners, a wheel's rims) meet what is under and beside them by the one point query, with the point's own velocity
 * (`pointContact`: the ground, every prism, the other cars' tops, car `skip`'s left out), as every body's points do. A contact is a
 * rigid row: the body is lifted out by the deepest depth along its face's normal, then impulses stop its closing (a bounce at
 * `RESTITUTION` above `BOUNCE_V`, none under) and Coulomb friction at `CRASH.muSlide` times the surface's grip holds it against the
 * sliding, over `PASSES` passes at the point's lever, so a part topples, rolls, slides off an edge and stops at a wall.
 */
export function stepLoose(p: LooseBody, dt: number, skip: number, dent?: DentState): void {
  const shape = p.shape;
  const object = p.object;
  const q = object.quaternion;
  const v = p.velocity;
  const w = p.angular;
  if (shape.count === 0) boxShape(shape, object);
  if (shape.asleep) {
    // At rest and nothing near that moves or changes: the step would hand it back where it is. A hit gave it speed or something came within its reach: it steps.
    _c.copy(shape.centre).applyQuaternion(q).add(object.position);
    if (v.x * v.x + v.y * v.y + v.z * v.z + w.x * w.x + w.y * w.y + w.z * w.z === 0 && !stirNear(_c.x, _c.z, shape.reach, skip)) return;
    shape.asleep = false;
  }
  v.y -= GRAVITY * dt;
  // The middle moves by the slice's start velocity, the body turns about it; its spin dies in the air as it always did.
  _c.copy(shape.centre).applyQuaternion(q).add(object.position).addScaledVector(v, dt);
  const spin = Math.sqrt(w.x * w.x + w.y * w.y + w.z * w.z);
  const damp = Math.pow(0.72, dt);
  if (spin > 1e-5) {
    const unit = 1 / spin;
    q.premultiply(_qSpin.setFromAxisAngle(_axis.set(w.x * unit, w.y * unit, w.z * unit), spin * dt));
  }
  w.x *= damp;
  w.y *= damp;
  w.z *= damp;
  if (dent) _v0.copy(v);

  // Over everything near (the statics, the solids and the car tops under its bounding square all lower than its lowest point) no point can touch: none is asked.
  const clear = clearOf(skip, _c.x, _c.z, shape.reach, _c.y - shape.reach);
  // Else the car tops are asked once for the body (every point is within its bounding radius of the middle), not once per point.
  const roofs = clear ? 0 : holdTops(skip, _c.x, _c.z, shape.reach);
  let n = 0;
  const points = shape.points;
  const count = clear ? 0 : shape.count;
  for (let k = 0; k < count; k++) {
    // Flying free (the last step touched nothing) with no car's roof near, a box's twelve edge middles wait until a corner touches: a flat floor or a wall is met by a corner first (a crowned roof by an edge's middle, so a roof near tests all).
    if (k === 8 && n === 0 && shape.airborne && shape.count === 20 && roofs === 0) break;
    _r.set(points[k * 3]!, points[k * 3 + 1]!, points[k * 3 + 2]!).applyQuaternion(q);
    _vp.crossVectors(w, _r).add(v);
    _q[PQ_X] = _c.x + _r.x;
    _q[PQ_Y] = _c.y + _r.y;
    _q[PQ_Z] = _c.z + _r.z;
    _q[PQ_VX] = _vp.x;
    _q[PQ_VY] = _vp.y;
    _q[PQ_VZ] = _vp.z;
    pointContactHeld(_q, skip, _hit);
    const height = _hit[C_H]!;
    // A floor under the point (depth: its gap up the normal) or a side it is in (the way out); a point in neither is free.
    const pen = height === NO_FLOOR ? _hit[C_DEPTH]! : (height - _q[PQ_Y]!) * _hit[C_NY]!;
    if (!(pen > 0)) continue;
    const o = n * ROW;
    rows[o + R_R] = _r.x;
    rows[o + R_R + 1] = _r.y;
    rows[o + R_R + 2] = _r.z;
    rows[o + R_N] = _hit[C_NX]!;
    rows[o + R_N + 1] = _hit[C_NY]!;
    rows[o + R_N + 2] = _hit[C_NZ]!;
    rows[o + R_PEN] = pen;
    const closing = -(_vp.x * _hit[C_NX]! + _vp.y * _hit[C_NY]! + _vp.z * _hit[C_NZ]!);
    rows[o + R_TARGET] = closing > BOUNCE_V ? RESTITUTION * closing : 0;
    rows[o + R_ACC] = 0;
    rows[o + R_FRIC] = 0;
    rows[o + R_FRIC + 1] = 0;
    rows[o + R_FRIC + 2] = 0;
    rows[o + R_MU] = CRASH.muSlide * _hit[C_GRIP]!;
    n++;
  }
  shape.airborne = n === 0;

  if (n > 0) {
    worldInertia(q, shape);
    // Out of what it is in: along each face's normal by what that face still holds it, in listing order.
    _d.set(0, 0, 0);
    for (let i = 0; i < n; i++) {
      const o = i * ROW;
      const need = rows[o + R_PEN]! - (_d.x * rows[o + R_N]! + _d.y * rows[o + R_N + 1]! + _d.z * rows[o + R_N + 2]!);
      if (need > 0) _d.set(_d.x + rows[o + R_N]! * need, _d.y + rows[o + R_N + 1]! * need, _d.z + rows[o + R_N + 2]! * need);
    }
    _c.add(_d);
    for (let pass = 0; pass < PASSES; pass++) {
      _s[S_MOVE] = 0;
      for (let i = 0; i < n; i++) {
        const o = i * ROW;
        _r.set(rows[o + R_R]!, rows[o + R_R + 1]!, rows[o + R_R + 2]!);
        _n.set(rows[o + R_N]!, rows[o + R_N + 1]!, rows[o + R_N + 2]!);
        _vp.crossVectors(w, _r).add(v);
        const vn = _vp.x * _n.x + _vp.y * _n.y + _vp.z * _n.z;
        const held = rows[o + R_ACC]!;
        reach(_r, _n);
        const given = Math.max(0, held + (rows[o + R_TARGET]! - vn) / _s[S_REACH]!);
        rows[o + R_ACC] = given;
        _s[S_J] = given - held;
        _s[S_MOVE] += Math.abs(given - held);
        push(v, w, _r, _n);
        // Friction holds the slide the face leaves: bounded by what the face carries, the impulse held so far taken into account.
        _vp.crossVectors(w, _r).add(v);
        const along = _vp.x * _n.x + _vp.y * _n.y + _vp.z * _n.z;
        _t.set(_vp.x + _n.x * -along, _vp.y + _n.y * -along, _vp.z + _n.z * -along);
        const slide = Math.sqrt(_t.x * _t.x + _t.y * _t.y + _t.z * _t.z);
        if (slide < 1e-9) continue;
        const unit = 1 / slide;
        _t.x *= unit;
        _t.y *= unit;
        _t.z *= unit;
        reach(_r, _t);
        const slideReach = slide / _s[S_REACH]!;
        let fx = rows[o + R_FRIC]! - _t.x * slideReach;
        let fy = rows[o + R_FRIC + 1]! - _t.y * slideReach;
        let fz = rows[o + R_FRIC + 2]! - _t.z * slideReach;
        const cap = rows[o + R_MU]! * given;
        const held2 = Math.sqrt(fx * fx + fy * fy + fz * fz);
        if (held2 > cap) {
          const k = held2 > 0 ? cap / held2 : 0;
          fx *= k;
          fy *= k;
          fz *= k;
        }
        _d.set(fx - rows[o + R_FRIC]!, fy - rows[o + R_FRIC + 1]!, fz - rows[o + R_FRIC + 2]!);
        rows[o + R_FRIC] = fx;
        rows[o + R_FRIC + 1] = fy;
        rows[o + R_FRIC + 2] = fz;
        const j = Math.sqrt(_d.x * _d.x + _d.y * _d.y + _d.z * _d.z);
        if (j > 0) {
          const norm = 1 / j;
          _d.x *= norm;
          _d.y *= norm;
          _d.z *= norm;
          _s[S_J] = j;
          _s[S_MOVE] += j;
          push(v, w, _r, _d);
        }
      }
      // A pass that moved no impulse by a nano-metre per second leaves the next as it found it.
      if (_s[S_MOVE]! < SETTLED) break;
    }
    // Resting on three points or more at no more than its own jitter (a slice's gravity: `2 g dt`): at rest.
    const jitter = 2 * GRAVITY * dt;
    if (n >= 3 && v.x * v.x + v.y * v.y + v.z * v.z < jitter * jitter && w.x * w.x + w.y * w.y + w.z * w.z < jitter * jitter) {
      v.set(0, 0, 0);
      w.set(0, 0, 0);
      shape.asleep = true;
    }
  }
  object.position.copy(_c).sub(_r.copy(shape.centre).applyQuaternion(q));
  if (dent) {
    // A settled part's tiny velocity change never reaches recordDent.
    _dv.copy(v).sub(_v0);
    if (_dv.x * _dv.x + _dv.y * _dv.y + _dv.z * _dv.z >= DENT_MIN_DV * DENT_MIN_DV) recordDent(dent, object, _dv);
  }
}
