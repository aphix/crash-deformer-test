import * as THREE from "three";
import { applyGroundFriction } from "../deform/physics-util.ts";
import { GRAVITY } from "../kernel/constants.ts";
import { detCos, detSin } from "../kernel/physics-core.js";
import { NO_FLOOR } from "../world/ground.ts";
import { C_DEPTH, C_GRIP, C_H, C_NX, C_NZ, clearOf, HIT_SIZE, holdTops, pointContact, PQ_SIZE, PQ_VX, PQ_VY, PQ_VZ, PQ_X, PQ_Y, PQ_Z, stirNear } from "../world/surfaces.ts";
import { BODY_FROM, centreOfMass, loadShape, moveBody, openRows, placeBody, readPoints, solveRows, standAtCentre, useBody } from "./car-air.ts";
import { DENT_MIN_DV, recordDent, type DentState } from "./loose-dent.ts";
import type { LooseBody, LooseShape } from "./car-core.ts";

const _c = new THREE.Vector3();
const _dv = new THREE.Vector3();
const _v0 = new THREE.Vector3();
const _q = new Float64Array(PQ_SIZE);
const _hit = new Float64Array(HIT_SIZE);

/** Height above its rest (m) at which a free body still slides on what is under it. */
const GROUND_BAND = 0.005;
/** Share of a free body's fall speed it bounces back up with off what it lands on. */
const LAND_BOUNCE = 0.28;
/** Share of a free body's spin that is left after a second in the air: its spin dies as it always did. */
const SPIN_KEPT_PER_S = 0.72;
/** A box's corners, the first of its points: a box flying free asks them alone until one touches. */
const BOX_CORNERS = 8;

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

/**
 * One slice of a torn part's or a popped wheel's flight (`p.velocity` its middle's, `p.angular` its spin) by the rigid step every body
 * takes (`car-air.ts`: `moveBody`, `readPoints`, `openRows`, `solveRows`): the body's points (a part's box's eight corners, a wheel's
 * rims) meet what is under and beside them by the one point query, with the point's own velocity (`pointContact`: the ground, every
 * prism, the other cars' tops, car `skip`'s left out), as every body's points do, so a part topples, rolls, slides off an edge and stops
 * at a wall. Here: its sleep, the gate that asks no point when nothing is near, its spin dying in the air, and its dent.
 */
export function stepLoose(p: LooseBody, dt: number, skip: number, dent?: DentState): void {
  const shape = p.shape;
  const object = p.object;
  const v = p.velocity;
  const w = p.angular;
  if (shape.count === 0) boxShape(shape, object);
  if (shape.asleep) {
    // At rest and nothing near that moves or changes: the step would hand it back where it is. A hit gave it speed or something came within its reach: it steps.
    _c.copy(shape.centre).applyQuaternion(object.quaternion).add(object.position);
    if (v.x * v.x + v.y * v.y + v.z * v.z + w.x * w.x + w.y * w.y + w.z * w.z === 0 && !stirNear(_c.x, _c.z, shape.reach, skip)) return;
    shape.asleep = false;
  }
  useBody(object, v, w, shape.centre, shape.invI, skip, true, dt);
  moveBody();
  // Its spin dies in the air as it always did.
  w.multiplyScalar(Math.pow(SPIN_KEPT_PER_S, dt));
  placeBody();
  if (dent) _v0.copy(v);

  // Over everything near (the statics, the solids and the car tops under its bounding square all lower than its lowest point) no point can touch: none is asked.
  const clear = clearOf(skip, centreOfMass.x, centreOfMass.z, shape.reach, centreOfMass.y - shape.reach);
  // Else the car tops are asked once for the body (every point is within its bounding radius of the middle), not once per point.
  const roofs = clear ? 0 : holdTops(skip, centreOfMass.x, centreOfMass.z, shape.reach);
  let n = 0;
  if (!clear) {
    const end = loadShape(shape);
    // Flying free (the last step touched nothing) with no car's roof near, a box's twelve edge middles wait until a corner touches: a flat floor or a wall is met by a corner first (a crowned roof by an edge's middle, so a roof near tests all).
    const first = shape.airborne && shape.count === 20 && roofs === 0 ? BODY_FROM + BOX_CORNERS : end;
    n = readPoints(BODY_FROM, first, end, 0, false);
    if (n > 0 && first < end) n = readPoints(first, end, end, n, false);
  }
  shape.airborne = n === 0;
  openRows(n);
  solveRows(n);
  standAtCentre();
  // Resting on three points or more at no more than its own jitter (a slice's gravity: `2 g dt`): at rest.
  const jitter = 2 * GRAVITY * dt;
  if (n >= 3 && v.x * v.x + v.y * v.y + v.z * v.z < jitter * jitter && w.x * w.x + w.y * w.y + w.z * w.z < jitter * jitter) {
    v.set(0, 0, 0);
    w.set(0, 0, 0);
    shape.asleep = true;
  }
  if (dent) {
    // A settled part's tiny velocity change never reaches recordDent.
    _dv.copy(v).sub(_v0);
    if (_dv.x * _dv.x + _dv.y * _dv.y + _dv.z * _dv.z >= DENT_MIN_DV * DENT_MIN_DV) recordDent(dent, object, _dv);
  }
}
