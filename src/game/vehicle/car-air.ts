import * as THREE from "three";
import type { DeformableCar } from "./car.ts";
import type { LooseShape } from "./car-core.ts";
import { activeGround, NO_FLOOR } from "../world/ground.ts";
import { C_AUX, C_DEPTH, C_GRIP, C_H, C_NX, C_NY, C_NZ, C_OWNER, C_PX, C_PY, C_PZ, C_TOUCH, EDGE_HIT, edgeCross, HIT_SIZE, MU_TYRE, patchOf, pointContact, pointContactHeld, PQ_SIZE, PQ_VX, PQ_VY, PQ_VZ, PQ_X, PQ_Y, PQ_Z, ridgeCross, staticTop, topsTop, wheelContact } from "../world/surfaces.ts";
import { HUB_FLOOR, TYRE_R } from "../deform/deform-state.ts";
import { barrierSpeed, CRASH, hypot2, plasticEnergy } from "../deform/physics-util.ts";
import { CAR_HALF, WHEEL_POS } from "./car-mesh.ts";
import { droop, PAN, SPRINGS, UNDERSIDE } from "./car-suspension.ts";
import { carClass } from "./vehicle-classes.ts";
import { CarSurfaces } from "./car-surfaces.ts";
import { CAGE_VERTICES } from "./car-cage.ts";
import { cageLift } from "./car-cage-rig.ts";

/**
 * How a car meets the surfaces under it, one pass per slice (`world/surfaces.ts` answers every query): each wheel's tread
 * footprint (`wheelContact`) says how far its wheel must lift to clear, three or more wheels standing on the world fix the
 * body's height, pitch and roll to the rest plane through their contact points (`stepPlane`: the pose-following that keeps
 * a car level on a road and on a bank), and fewer leave the body a rigid box under gravity that turns about its centre of
 * mass (`stepFree`: its wheels, bumper, beltline, roof corners and belly meet what is under them through impulses with
 * restitution and friction, so it can land on its wheels, roof or side, rest on a ramp's edge, tip over or rock back).
 * `DeformableCar.airborne` is derived from the same contacts: no wheel within its springs' reach and no hull point in a surface.
 */
export const G = 9.6;
/** Centre of mass above the group's origin (car-local y, m); the origin is on the ground under the body's middle. */
export const COM_Y = 0.55;
/** Inverse inertia per unit mass (1/m²) of the body's box about its centre of mass: car-local x, y, z. */
const INV_I = new THREE.Vector3(3 / (CAR_HALF.y ** 2 + CAR_HALF.z ** 2), 3 / (CAR_HALF.x ** 2 + CAR_HALF.z ** 2), 3 / (CAR_HALF.x ** 2 + CAR_HALF.y ** 2));
/**
 * The underside (car-local x, height, z): `UNDERSIDE`'s keel and rockers, and the belly between them 0.5 m either side of
 * the keel (its height interpolated), so a car on another's flat roof rests on its width, not balanced on the keel line, and `PAN`
 * (the belly's centre patch, car-suspension.ts): the only part of the belly that meets a car top's ridge between its points
 * (`ridgeCross`), since the hull lines past it slope down to the nose and stood under the pan at a roof's front edge (every car in a
 * stack rested 1° nose-up on the one under it).
 */
const BELLY: readonly (readonly [number, number, number])[] = [
  ...UNDERSIDE.map(([x, z, h]): [number, number, number] => [x, h, z]),
  ...[2, 1, 0, -2].flatMap((z) => {
    const keel = UNDERSIDE.find((p) => p[0] === 0 && p[1] === z)![2];
    const rocker = UNDERSIDE.find((p) => p[0] === 0.8 && p[1] === z)![2];
    return [-0.5, 0.5].map((x): [number, number, number] => [x, keel + (rocker - keel) * 0.625, z]);
  }),
  ...PAN,
];
/** The point table's first body point: the four hubs (their tyres meet the ground through `wheelContact`) come first. */
export const BODY_FROM = 4;
/** Room for the four hubs, a style's cage vertices at most (`CAGE_VERTICES`) and the belly: `loadPoints` fills it per body each slice. */
const POINT_CAPACITY = BODY_FROM + CAGE_VERTICES + BELLY.length;
/** The loaded points as flat car-local x, y (class lift on), z rows: `hullPoint` reads them per slice without unpacking a tuple. */
const POINT_X = new Float64Array(POINT_CAPACITY);
const POINT_Y = new Float64Array(POINT_CAPACITY);
const POINT_Z = new Float64Array(POINT_CAPACITY);
/** Neighbouring belly points as `BELLY` index pairs (along x at one z, along z at one x): where the two stand on different patches,
 *  the belly between them meets that patch's edge (`edgeCross`), as a ramp's crest does between rows half a metre apart. */
const SEGS: Int16Array = (() => {
  const pairs = new Int16Array(BELLY.length * BELLY.length);
  let m = 0;
  for (let i = 0; i < BELLY.length; i++) {
    for (let j = i + 1; j < BELLY.length; j++) {
      const [xi, , zi] = BELLY[i]!;
      const [xj, , zj] = BELLY[j]!;
      if (xi !== xj && zi !== zj) continue;
      let between = false;
      for (const [xk, , zk] of BELLY) {
        if (zi === zj && zk === zi && (xk - xi) * (xk - xj) < 0) between = true;
        if (xi === xj && xk === xi && (zk - zi) * (zk - zj) < 0) between = true;
      }
      if (between) continue;
      pairs[m++] = i;
      pairs[m++] = j;
    }
  }
  return pairs.slice(0, m);
})();
/** Contacts a body can hold in one slice: its tyres and points, and a belly segment's edge each. */
const CONTACTS = POINT_CAPACITY + SEGS.length / 2;
/** A wheel this close (m) to the ground counts as down. */
export const TOUCH = 0.03;
/** Restitution of a body point closing faster than `BOUNCE_V` (m/s); slower contacts and tyres (their springs,
 *  `Suspension`, take a landing) don't bounce. */
export const RESTITUTION = 0.25;
const BOUNCE_V = 1.5;
/** The closing speed (m/s) from which a contact is a crash, not a touch: into a fixed solid's face (`wallBounce`), or onto another car's top (`CLOSING`). */
export const WALL_CRUSH = 5.5;
/** Friction: the body scraping (the rigid step's and a fixed solid's face, `wallBounce`), a tyre across its tread (it rolls freely along it). */
export const MU_BODY = 0.6;
/** Contact is solved at this rate (Hz) however long the physics step (`stepWorld` splits it): a face's crush depth is the slice's own discretisation otherwise (8 % apart at 60 and 240 Hz). */
export const CONTACT_HZ = 480;
/** A top flatter than this (normal's up component: the body's friction cone, `MU_BODY`) holds a body point that comes down on it; a steeper one, met at crash speed, is a car's flank or edge. */
const HOLDING_NY = 1 / Math.sqrt(1 + MU_BODY * MU_BODY);
/** A tyre on a face this shallow (normal's up component over it: a slope under 70°) pushes and lifts straight up, in its springs and past their stop alike (no drag on the world: the drive grips). A steeper face is a wall: the tyre pushes along its normal. */
const CLIMB_NY = 0.34;
/** A point at crash speed deeper than this many slices of its closing is not on a top it came down on but inside the car it crossed the plan of (`readPoints`). */
const SIDE_ENTRY_SLICES = 2;
/** The depth (m) a point may sit past `SIDE_ENTRY_SLICES` slices of closing before it counts as inside: the cage's own fit (a few cm). */
const SIDE_ENTRY_SLACK = 0.02;

const _r = new THREE.Vector3();
/** The body's centre of mass in the world, moved through the slice by `moveBody` and then by the solve (`solveRows`). */
export const centreOfMass = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _dq = new THREE.Quaternion();
const _eul = new THREE.Euler();
const UP = new THREE.Vector3(0, 1, 0);
const _up = new THREE.Vector3();
const _fd = new THREE.Vector3();
/** A driven car's Euler yaw drifts by up to this (rad) in a rigid turn before it is a tumble (a flip is no heading). */
const YAW_HOLD = 0.5;
const _qi = new THREE.Quaternion();
const _x = new THREE.Vector3();
const _z = new THREE.Vector3();
const _vp = new THREE.Vector3();
const _rn = new THREE.Vector3();
const _k = new THREE.Vector3();
const _tn = new THREE.Vector3();
const R = Array.from({ length: CONTACTS }, () => new THREE.Vector3());
const _lift = new THREE.Vector3();
/**
 * Scalars the solver hands between its functions (a double passed or returned across a call that is not inlined is boxed, an allocation
 * per call): the impulse `give` and `push` give and the part of it that stops closing, the speed `reach` reads, the closing the weight
 * brings (`weightClosing`) and the depth `bodyContact` takes.
 */
const _s = new Float64Array(6);
const S_J = 0;
const S_JD = 1;
const S_REACH = 2;
const S_WEIGHT = 3;
const S_PEN = 4;
/** How far (m) the farthest loaded body point stands from the centre of mass (`loadPoints`). */
const S_POINT_REACH = 5;
const N = Array.from({ length: CONTACTS }, () => new THREE.Vector3());
/** Per contact: the direction its impulse and its lift go: up for a tyre on a face it can climb, else the face's normal. */
const DIR = Array.from({ length: CONTACTS }, () => UP);
const TYRE = Array.from({ length: CONTACTS }, () => false);
const SOFT = Array.from({ length: CONTACTS }, () => false);
/** Per contact: the face slot it presses (-1 rigid), the car whose top it stands on (-1 the world), how far that point follows its crush, its sink past what holds it. */
const SLOT = Array.from({ length: CONTACTS }, () => -1);
const OWN = Array.from({ length: CONTACTS }, () => -1);
const FOLLOW = Array.from({ length: CONTACTS }, () => 1);
const SINK = Array.from({ length: CONTACTS }, () => 0);
/** Per tyre in its springs: how far (m, vertical) its spring is pressed past the rest ride, negative while it hangs toward its droop. */
const PRESS = new Float64Array(CONTACTS);
/** Per tyre in its springs: the impulse (per unit mass) its spring and damper push with this slice, what its face carries of it. */
const ASK = new Float64Array(CONTACTS);
/**
 * Per contact of the rigid solve: its normal impulse over the passes; the first contact pressing the same face slot (-1: a rigid
 * surface); and, at that first contact, what the slot carries this slice, the most its contacts asked of it, and their sum in a pass.
 */
const ACC = new Float64Array(CONTACTS);
const FIRST = new Int32Array(CONTACTS);
const ROOM = new Float64Array(CONTACTS);
const DEMAND = new Float64Array(CONTACTS);
const SUMF = new Float64Array(CONTACTS);
/**
 * Per contact: the speed (m/s) it closes on its surface at before the solve (0 for a point moving off). Only a contact closing slower than a
 * crash (`WALL_CRUSH`) rests on the car under it (`CarSurfaces.commit`, `restsOn`): a monster's bumper meeting a sedan's bonnet head-on at
 * 55 m/s each rode up it as a ramp, read as resting on it, and the pair's crush never ran.
 */
const CLOSING = new Float64Array(CONTACTS);
/** Per contact: the speed (m/s) its gap to the surface lets it close at over this slice (0 for a point in the surface). */
const GAPV = new Float64Array(CONTACTS);
/** A point this close (m) over its surface is a contact already: it is held where it would arrive within the slice, not after it. */
const SPECULATIVE_GAP = 0.0002;
/** Margin (m) the whole-body clear check keeps for its own rounding against each point's test (both are ~1e-15 of a few metres). */
const CLEAR_ROUND = 1e-6;
/** Passes of the contact solve over a slice's contacts: a contact parting gives back its rest impulse over them (a sedan on a roof stood still). */
const PASSES = 12;
/** The most (in G·dt) the solve's change of velocity moves the body within its own slice (half of it, the trapezoid rule). */
const SOLVE_MOVE_G = 1.5;
/** Per contact: the depth (m) along its normal the lift has still to take out (-Infinity: a row that does not lift). */
const LEFT = new Float64Array(CONTACTS);
/** Per contact: the belly resting on the world's ground (it only resists, see `stepFree`). */
const UNDER = Array.from({ length: CONTACTS }, () => false);
/**
 * Per contact: the car whose top it is on when that car is in the rigid step (null: the world's ground, or a car its wheels or its
 * masses hold, which stays put), that car's arm to the point from its centre of mass, and the stepping car's mass over its.
 */
const HELD = Array.from({ length: CONTACTS }, (): DeformableCar | null => null);
const ARM = Array.from({ length: CONTACTS }, () => new THREE.Vector3());
const RATIO = new Float64Array(CONTACTS);
/** Per contact: the friction impulse (world, per unit mass) it has given over the passes, held within its friction of `ACC`. */
const FRA = Array.from({ length: CONTACTS }, () => new THREE.Vector3());
/**
 * Per contact this slice: the closing its own gravity and the weight borne on the stepping car bring there, left to stop against the car
 * under as fixed (a tyre in its springs: its quarter of the weight), and the impulse beyond it that moved that car at once.
 */
const REST = new Float64Array(CONTACTS);
const DYN = new Float64Array(CONTACTS);
/** Per contact this slice: the rest impulse it has taken (its share of stopping gravity and the borne weight), given back as it parts. */
const RIMP = new Float64Array(CONTACTS);
/** The weight borne on the stepping car since its last step (`CarSurfaces.takeBorne`): its velocity and spin change. */
const _lv = new THREE.Vector3();
const _lw = new THREE.Vector3();
/** The body's velocity before the slice's gravity and solve (its centre moves by it), and the change the solve made. */
const _vMove = new THREE.Vector3();
const _dvSolve = new THREE.Vector3();
/** Per belly point (`POINTS` index) this slice: its world position, its rise (surface height less its own) and its patch (`patchOf`). */
const BX = new Float64Array(POINT_CAPACITY);
const BY = new Float64Array(POINT_CAPACITY);
const BZ = new Float64Array(POINT_CAPACITY);
const BRISE = new Float64Array(POINT_CAPACITY);
const BPATCH = new Float64Array(POINT_CAPACITY);
/** Per belly point this slice: 1 while its reading is not taken (nothing stands within its slice's travel of it, `readBelly`). */
const UNREAD = new Uint8Array(POINT_CAPACITY);
/** The surfaces of a car in no world (a bare harness): the world's ground alone. */
const LOCAL = new CarSurfaces();
const HIT = new Float64Array(HIT_SIZE);
/** The query point `pointContact` is asked (world x, z and the asking height y). */
const PQ = new Float64Array(PQ_SIZE);
/** Per contact: its Coulomb coefficient against its face (a car's body `MU_BODY`, a tyre's `MU_TYRE`, a part's `CRASH.muSlide` times the face's grip). */
const MU = new Float64Array(CONTACTS);
/**
 * Per car-owned contact the rows of a solve exchange momentum with a car (`HELD`): whether `noteClosing` has read it this solve, the speed
 * (m/s) its point first closed on the car at along the row's plan normal (`CLOSE_FIRST`, the way the pair contact reads a closing: the
 * horizontal one), and the point in the world (`CRUSH_POINT`, x y z). `collectCrush` turns them into the hit each car's crush is armed with.
 */
const NOTED = new Uint8Array(CONTACTS);
const CLOSE_FIRST = new Float64Array(CONTACTS);
const CRUSH_POINT = new Float64Array(CONTACTS * 3);
const _crushPoint = new THREE.Vector3();
const _crushNormal = new THREE.Vector3();
const _crushBack = new THREE.Vector3();
/** A car's centre of mass in its own frame: `COM_Y` up the origin. */
const CAR_CENTRE = new THREE.Vector3(0, COM_Y, 0);

/**
 * The body the rigid step moves, set by `useBody`. Every body takes the same step (`moveBody`, `placeBody`, `readPoints`, `openRows`,
 * `solveRows`): `stepFree` adds a car's tyres, springs, belly and face budgets between them, `stepLoose` a part's sleep and its gating
 * of the point reads. `q`, `pos`, `v`, `w` are the body's own pose and its velocity and spin (unit mass), `centre` its centre of mass in
 * its own frame, `invI` its inverse inertia per unit mass about its own axes, `skip` its slot asked of the world, `surf` the faces it
 * shares with other cars, `mass` its mass over theirs. `driven`, `parked`, `powered` are a car's drive state (its tyres' friction),
 * `nearing` that a point not yet in a surface reaches it within the slice at its closing speed.
 */
const body = {
  q: new THREE.Quaternion(),
  pos: new THREE.Vector3(),
  v: new THREE.Vector3(),
  w: new THREE.Vector3(),
  centre: CAR_CENTRE,
  invI: INV_I,
  skip: -1,
  part: false,
  dt: 0,
  surf: LOCAL,
  mass: 0,
  driven: false,
  parked: false,
  powered: false,
  nearing: false,
};

/**
 * Points the rigid step at the body whose pose is `object`'s, with its velocity `v` and spin `w` (unit mass), its centre of mass `centre`
 * in its own frame and its inverse inertia `invI`, asked of the world as slot `skip`, for a slice of `dt` s. A `part` (a torn panel, a
 * popped wheel) meets a prism's side face through rows of its own, takes a car's top for the world (no face budget, no weight on that
 * car) and rubs at its face's grip (`CRASH.muSlide`); a car's tyres, belly and `sideContact` do all that.
 */
export function useBody(object: THREE.Object3D, v: THREE.Vector3, w: THREE.Vector3, centre: THREE.Vector3, invI: THREE.Vector3, skip: number, part: boolean, dt: number): void {
  body.q = object.quaternion;
  body.pos = object.position;
  body.v = v;
  body.w = w;
  body.centre = centre;
  body.invI = invI;
  body.skip = skip;
  body.part = part;
  body.dt = dt;
  body.surf = LOCAL;
  body.mass = 0;
  body.driven = false;
  body.parked = false;
  body.powered = false;
  body.nearing = false;
  // No car under it bears weight onto it (`takeBorne` sets these for a car).
  if (part) {
    _lv.set(0, 0, 0);
    _lw.set(0, 0, 0);
  }
}

/**
 * The body through the slice's start: its centre of mass moves by the slice's start velocity, and by half the change the solve makes
 * (the trapezoid rule, `SOLVE_MOVE_G`) after: a body moved before solving crept down a 10° wedge by g sin(a) dt² every slice, 14-39
 * mm/s with its tyres holding. Its velocity takes the slice's gravity, and it turns about its centre by its spin.
 */
export function moveBody(): void {
  const { q, pos, v, w, dt, centre } = body;
  _vMove.copy(v);
  v.y -= G * dt;
  centreOfMass.copy(_r.copy(centre).applyQuaternion(q)).add(pos).addScaledVector(_vMove, dt);
  const spin = w.length();
  if (spin > 1e-9) q.premultiply(_dq.setFromAxisAngle(_axis.copy(w).divideScalar(spin), spin * dt));
}

/** The body's origin where its centre of mass is, for its orientation (after the solve: a car's `CarSurfaces.commit` reads its pose from before it). */
export function standAtCentre(): void {
  body.pos.copy(centreOfMass).sub(_r.copy(body.centre).applyQuaternion(body.q));
}

/** The moved body settled at its orientation: the inverse of it (`_qi`, read by the solve) and its origin at its centre of mass. */
export function placeBody(): void {
  _qi.copy(body.q).invert();
  standAtCentre();
}


/** Belly point `i`'s reading at (`BX`, `BY`, `BZ`) for body `slot`: its contact in `HIT`, its rise in `BRISE` and its patch in `BPATCH`. */
function readBelly(i: number, slot: number): void {
  PQ[PQ_X] = BX[i]!;
  PQ[PQ_Z] = BZ[i]!;
  PQ[PQ_Y] = BY[i]!;
  pointContact(PQ, slot, HIT);
  BRISE[i] = HIT[C_H]! - BY[i]!;
  BPATCH[i] = patchOf(HIT);
  UNREAD[i] = 0;
}

/** Contact `n`, a body point at `R[n]` from the centre `_s[S_PEN]` m under the surface in `hit` (`pointContact`): `hull` a cage vertex, else a belly point. Both are the drawn body, so both press the face their contact normal falls on (a belly point of the nose meets the ground nose-first as much as a vertex of it does). */
function bodyContact(n: number, hit: Float64Array, hull: boolean): void {
  const pen = _s[S_PEN]!;
  const { q, v, w, surf, mass, part } = body;
  // A part is on the world's faces whatever it stands on: a car's top is no budget of that car's face, and bears nothing of it.
  const own = part ? -1 : hit[C_OWNER]!;
  N[n]!.set(hit[C_NX]!, hit[C_NY]!, hit[C_NZ]!);
  TYRE[n] = false;
  MU[n] = part ? CRASH.muSlide * hit[C_GRIP]! : MU_BODY;
  // A body point does not roll: every face pushes it along its normal, so a face does no work along itself. Pushed straight up on the
  // world's ground, a bumper scraping the corkscrew's climb at 27 m/s kept its travel along the road and gained the lift: 180 J/kg in
  // 0.7 s, the car off the lip at 31.4 m/s from 27 m/s at the mouth.
  DIR[n] = N[n]!;
  OWN[n] = own;
  UNDER[n] = !hull && own < 0;
  FOLLOW[n] = own >= 0 ? hit[C_AUX]! : 1;
  SLOT[n] = part ? -1 : surf.slot(own, N[n]!, true, q, FOLLOW[n]!);
  SOFT[n] = false;
  GAPV[n] = 0;
  // A floor's depth is a vertical gap (`pen`), its normal depth that times the normal's y; a side face's `pen` (a part's) is its normal depth already.
  SINK[n] = part && hit[C_H] === NO_FLOOR ? pen : pen * N[n]!.y;
  carrier(surf, n, own, mass);
  CLOSING[n] = Math.max(0, -pointVel(n, v, w, _vp).dot(N[n]!));
  if (own >= 0 && CLOSING[n]! < WALL_CRUSH) surf.touch(own);
}

/** A part point's query: with the point's own velocity (`PQ_VX`..), which a car's (`PQ`) never carries. */
const PART_PQ = new Float64Array(PQ_SIZE);

/**
 * Whether a body point (arm `r` from the centre of mass) at crash speed against another car's top `hit` (depth `pen` under it) got there
 * from the side: deeper along the face than `SIDE_ENTRY_SLICES` slices of its closing carry it. Left to the cage top, it is lifted out of
 * the car's flank by riding up it, so the pair contact (the cage outlines) answers it.
 */
function crossedPlanFromSide(hit: Float64Array, pen: number, r: THREE.Vector3): boolean {
  _vp.crossVectors(body.w, r).add(body.v).sub(body.surf.cars[hit[C_OWNER]!]!.velocity);
  const closing = -(_vp.x * hit[C_NX]! + _vp.y * hit[C_NY]! + _vp.z * hit[C_NZ]!);
  return _vp.length() > WALL_CRUSH && pen * hit[C_NY]! > SIDE_ENTRY_SLICES * Math.max(0, closing) * body.dt + SIDE_ENTRY_SLACK;
}

/**
 * Contact rows, from row `n` on, for the loaded points `from` to `to` (`loadPoints`, `loadShape`) as the body stands: those that meet a
 * surface within the slice, a point at most `SPECULATIVE_GAP` above one a row that lets it close that gap and no more. Returns the row
 * count past the last. The points from `bellyFrom` on are a car's belly: read (`BX`, `BRISE`, `BPATCH`) for its edges, no rows. With
 * `gate` a point that stays higher than the static surface anywhere within its slice's plan travel, by its descent over the slice and a
 * speculative gap, neither meets nor nears it: not asked. A part also meets a prism's side face (`C_H` NO_FLOOR: the depth it is in,
 * out along the face's normal), asks the car tops its caller held (`holdTops`) and gives the point's own velocity for the way out.
 */
export function readPoints(from: number, to: number, bellyFrom: number, n: number, gate: boolean): number {
  const { q, v, w, dt, skip, part } = body;
  const statics = activeGround();
  for (let i = from; i < to; i++) {
    const r = armOf(i, q, R[n]!);
    const px = centreOfMass.x + r.x;
    const py = centreOfMass.y + r.y;
    const pz = centreOfMass.z + r.z;
    _vp.crossVectors(w, r).add(v);
    const planTravel = hypot2(_vp.x, _vp.z) * dt;
    const descent = Math.max(0, -_vp.y) * dt + SPECULATIVE_GAP;
    const clear = gate && staticTop(statics, px - planTravel, px + planTravel, pz - planTravel, pz + planTravel) < py - descent;
    if (i >= bellyFrom) {
      BX[i] = px;
      BY[i] = py;
      BZ[i] = pz;
      if (clear) {
        UNREAD[i] = 1;
        continue;
      }
      readBelly(i, skip);
    } else {
      if (clear) continue;
      if (part) {
        PART_PQ[PQ_X] = px;
        PART_PQ[PQ_Z] = pz;
        PART_PQ[PQ_Y] = py;
        PART_PQ[PQ_VX] = _vp.x;
        PART_PQ[PQ_VY] = _vp.y;
        PART_PQ[PQ_VZ] = _vp.z;
        pointContactHeld(PART_PQ, skip, HIT);
      } else {
        PQ[PQ_X] = px;
        PQ[PQ_Z] = pz;
        PQ[PQ_Y] = py;
        pointContact(PQ, skip, HIT);
      }
    }
    const gy = HIT[C_H]!;
    if (gy === NO_FLOOR && !(part && HIT[C_DEPTH]! > 0)) continue;
    const pen = gy === NO_FLOOR ? HIT[C_DEPTH]! : gy - py;
    if (pen <= 0 && -pen > SPECULATIVE_GAP) {
      // A point that reaches the surface within this slice's travel at its closing speed: the next slice is cut finer.
      if (!body.nearing) {
        _vp.crossVectors(w, r).add(v);
        body.nearing = (_vp.x * HIT[C_NX]! + _vp.y * HIT[C_NY]! + _vp.z * HIT[C_NZ]!) * -dt >= -pen * HIT[C_NY]!;
      }
      continue;
    }
    // A body point closing on another car's top faster than a crash (`WALL_CRUSH`) onto a face steeper than the body's friction cone
    // (`HOLDING_NY`: a car's nose into another's edge or flank) is the car pair's hit: its SAT (the cage outlines) takes it and its crush
    // runs. So is a point that crossed the car's plan from the side and is now far under its top: deeper along the face than its closing
    // over this slice carried it (`SIDE_ENTRY_SLICES`), the top can only lift it by riding it up the car's flank (a T-bone's nose rose
    // 0.26 m and crushed 9 mm of a lethal 55 m/s). Every other point is answered by the cage's top as by any top (a roof landed on, a
    // hood driven onto).
    if (!part && HIT[C_OWNER]! >= 0) {
      _vp.crossVectors(w, r).add(v);
      if (i < bellyFrom && HIT[C_NY]! < HOLDING_NY && -(_vp.x * HIT[C_NX]! + _vp.y * HIT[C_NY]! + _vp.z * HIT[C_NZ]!) > WALL_CRUSH) continue;
      if (crossedPlanFromSide(HIT, pen, r)) continue;
    }
    _s[S_PEN] = pen;
    bodyContact(n, HIT, i < bellyFrom);
    if (pen <= 0) GAPV[n] = (-pen * HIT[C_NY]!) / dt;
    n++;
  }
  return n;
}

/** Contact `n` (its arm `R[n]` set) on car `own`'s top (-1: the world's ground): the car that takes its reaction (`HELD`), for a stepping car of `mass`. */
function carrier(surf: CarSurfaces, n: number, own: number, mass: number): void {
  const o = own >= 0 ? surf.cars[own]! : null;
  if (o === null || !o.rigid) {
    HELD[n] = null;
    return;
  }
  HELD[n] = o;
  RATIO[n] = mass / o.deform.totalMass;
  ARM[n]!.copy(centreOfMass).add(R[n]!).sub(o.group.position).sub(_r.set(0, COM_Y, 0).applyQuaternion(o.group.quaternion));
}

/** World inverse inertia (body orientation `q`, its inverse `qi`; `inertia` its inverse inertia per unit mass about its own axes) applied to `x` in place. */
export function invInertia(x: THREE.Vector3, q: THREE.Quaternion, qi: THREE.Quaternion, inertia: THREE.Vector3): THREE.Vector3 {
  return x.applyQuaternion(qi).multiply(inertia).applyQuaternion(q);
}

/** Impulse `_s[S_J]` along unit `dir` at `r` (from the centre of mass) on unit mass `v`, `w`. */
function push(v: THREE.Vector3, w: THREE.Vector3, q: THREE.Quaternion, r: THREE.Vector3, dir: THREE.Vector3): void {
  const j = _s[S_J]!;
  v.addScaledVector(dir, j);
  w.addScaledVector(invInertia(_rn.crossVectors(r, dir), q, _qi, body.invI), j);
}

const _ov = new THREE.Vector3();
const _qo = new THREE.Quaternion();
/** Contact `c`'s point velocity on the stepping body (`v`, `w`) against its surface, into `out`: the top of a car in the rigid step moves with that car. */
function pointVel(c: number, v: THREE.Vector3, w: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  out.crossVectors(w, R[c]!).add(v);
  const o = HELD[c];
  if (o !== null) out.sub(_ov.crossVectors(o.angular, ARM[c]!).add(o.velocity));
  return out;
}

/**
 * Impulse `j` along unit `dir` at contact `c` on the stepping body (unit mass `v`, `w`, orientation `q`), and its reaction at the same
 * point on the car under it (`HELD`), centre and spin both: the part `jd` that stops closing beyond this slice's weight at once, the
 * weight's part (`j - jd`) borne on it for its next step (`CarSurfaces.bear`), which its own contacts then hold and bear on. Taken at
 * that car's centre alone, a load off the middle of its roof never turned it, and a car turning back under a still rider lifted it
 * 48 mm in 0.1 s (329 J) on 54 J of its own spin.
 */
function give(c: number, v: THREE.Vector3, w: THREE.Vector3, q: THREE.Quaternion, dir: THREE.Vector3, surf: CarSurfaces): void {
  const j = _s[S_J]!;
  const jd = _s[S_JD]!;
  push(v, w, q, R[c]!, dir);
  const o = HELD[c];
  if (o === null) return;
  const oq = o.group.quaternion;
  invInertia(_rn.crossVectors(ARM[c]!, dir), oq, _qo.copy(oq).invert(), INV_I);
  o.velocity.addScaledVector(dir, -jd * RATIO[c]!);
  o.angular.addScaledVector(_rn, -jd * RATIO[c]!);
  if (j !== jd) surf.bear(OWN[c]!, dir, _rn, (jd - j) * RATIO[c]!);
}

/**
 * Unit-mass impulse per m/s of contact `c`'s closing speed along unit `dir`: 1 / (1 + dir · (I⁻¹(r × dir) × r)) for the stepping body,
 * with `both` the car under it (`HELD`) taking its share. Stopping the rider alone against a car of its own weight handed that car the
 * whole closing speed: an elastic pair, and a stack whose cars never came to rest.
 */
function reach(c: number, dir: THREE.Vector3, along: THREE.Vector3, q: THREE.Quaternion, both: boolean): void {
  const own = along.dot(dir) + _k.crossVectors(invInertia(_rn.crossVectors(R[c]!, dir), q, _qi, body.invI), R[c]!).dot(along);
  let other = 0;
  const o = HELD[c];
  if (both && o !== null) {
    const oq = o.group.quaternion;
    other = RATIO[c]! * (along.dot(dir) + _k.crossVectors(invInertia(_rn.crossVectors(ARM[c]!, dir), oq, _qo.copy(oq).invert(), INV_I), ARM[c]!).dot(along));
  }
  _s[S_REACH] = 1 / (own + other);
}

/** The speed (m/s) contact `c` closes at over a slice `dt` from its body's gravity and the weight borne on it (`takeBorne`): what it carries at rest. */
function weightClosing(c: number): void {
  _s[S_WEIGHT] = Math.max(0, -_vp.crossVectors(_lw, R[c]!).add(_lv).addScaledVector(UP, -G * body.dt).dot(N[c]!));
}

const WHEELS = WHEEL_POS.length;
const AUGMENTED_STRIDE = WHEELS + 1;
/** The tyre springs' system for the slice: matrix, right side, the tyres still pushing, their rows, the augmented rows and the solution. */
const SPRING_LHS = new Float64Array(WHEELS * WHEELS);
const SPRING_RHS = new Float64Array(WHEELS);
const SPRING_PUSHING = Array.from({ length: WHEELS }, () => false);
const SPRING_ROW = new Int32Array(WHEELS);
const SPRING_AUGMENTED = new Float64Array(WHEELS * AUGMENTED_STRIDE);
const SPRING_SOLUTION = new Float64Array(WHEELS);
/** Per tyre: the spin one unit of impulse straight up at it gives the body (the body's inverse inertia on its arm × up). */
const SPIN_PER_PUSH = Array.from({ length: WHEELS }, () => new THREE.Vector3());

/** `SPRING_LHS` x = `SPRING_RHS` over the tyres still pushing, into `ASK` (Gaussian elimination: the matrix is the identity plus a positive-definite response). */
function solveSpringSystem(tyres: number): void {
  let rows = 0;
  for (let c = 0; c < tyres; c++) if (SPRING_PUSHING[c]) SPRING_ROW[rows++] = c;
  for (let a = 0; a < rows; a++) {
    for (let b = 0; b < rows; b++) SPRING_AUGMENTED[a * AUGMENTED_STRIDE + b] = SPRING_LHS[SPRING_ROW[a]! * WHEELS + SPRING_ROW[b]!]!;
    SPRING_AUGMENTED[a * AUGMENTED_STRIDE + rows] = SPRING_RHS[SPRING_ROW[a]!]!;
  }
  for (let pivot = 0; pivot < rows; pivot++) {
    const diagonal = SPRING_AUGMENTED[pivot * AUGMENTED_STRIDE + pivot]!;
    for (let r = pivot + 1; r < rows; r++) {
      const factor = SPRING_AUGMENTED[r * AUGMENTED_STRIDE + pivot]! / diagonal;
      for (let col = pivot; col <= rows; col++) SPRING_AUGMENTED[r * AUGMENTED_STRIDE + col] = SPRING_AUGMENTED[r * AUGMENTED_STRIDE + col]! - factor * SPRING_AUGMENTED[pivot * AUGMENTED_STRIDE + col]!;
    }
  }
  for (let a = rows - 1; a >= 0; a--) {
    let rest = SPRING_AUGMENTED[a * AUGMENTED_STRIDE + rows]!;
    for (let b = a + 1; b < rows; b++) rest -= SPRING_AUGMENTED[a * AUGMENTED_STRIDE + b]! * SPRING_SOLUTION[b]!;
    SPRING_SOLUTION[a] = rest / SPRING_AUGMENTED[a * AUGMENTED_STRIDE + a]!;
  }
  for (let a = 0; a < rows; a++) ASK[SPRING_ROW[a]!] = SPRING_SOLUTION[a]!;
}

/**
 * The tyres in their springs push together, `ASK[c]` each (impulse per unit mass): `dt (G/4 + stiff x + damp u)` with u the press rate
 * of the slice's start and x the press at the end of it, after every tyre's push, moved by half the rate's change (the trapezoid rule
 * of the slice's move). One linear system over the four tyres, so no tyre's push depends on the order they are listed in, and a stiff
 * spring cannot swing the body from one side to the other every slice (the push of the slice's start state did: the roll mode of a
 * 24 Hz spring at 120 Hz, a limit cycle of 0.09°). A tyre the system would pull is left out and the rest solved again.
 */
function springPushes(tyres: number, stiff: number, damp: number, dt: number, q: THREE.Quaternion, v: THREE.Vector3, w: THREE.Vector3): void {
  const endForce = 0.5 * dt * stiff;
  for (let d = 0; d < tyres; d++) {
    SPRING_PUSHING[d] = SOFT[d]!;
    if (SOFT[d]) invInertia(SPIN_PER_PUSH[d]!.crossVectors(R[d]!, UP), q, _qi, INV_I);
  }
  for (let c = 0; c < tyres; c++) {
    if (!SOFT[c]) continue;
    const rising = N[c]!.y > 0;
    const gravityRate = rising ? G * dt : 0;
    const startRate = rising ? -pointVel(c, v, w, _vp).dot(N[c]!) / N[c]!.y - G * dt : 0;
    SPRING_RHS[c] = dt * (G / 4 + stiff * (PRESS[c]! + 0.5 * dt * gravityRate) + damp * startRate);
    for (let d = 0; d < tyres; d++) {
      const response = rising && SOFT[d] ? (N[c]!.y + _k.crossVectors(SPIN_PER_PUSH[d]!, R[c]!).dot(N[c]!)) / N[c]!.y : 0;
      SPRING_LHS[c * WHEELS + d] = (c === d ? 1 : 0) + dt * endForce * response;
    }
  }
  for (let round = 0; round < tyres; round++) {
    solveSpringSystem(tyres);
    let pulled = false;
    for (let c = 0; c < tyres; c++) {
      if (!SPRING_PUSHING[c] || ASK[c]! >= 0) continue;
      SPRING_PUSHING[c] = false;
      ASK[c] = 0;
      pulled = true;
    }
    if (!pulled) break;
  }
}

/**
 * Body point `i` of the loaded table (`loadPoints`) turned by the body's orientation `q`, from a point `dy` above the group's origin
 * (car-local y).
 */
function hullPoint(i: number, q: THREE.Quaternion, dy: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(POINT_X[i]!, POINT_Y[i]! + dy, POINT_Z[i]!).applyQuaternion(q);
}

/**
 * Loads `car`'s body points into the point table: the four hubs (their tyres meet the ground through `wheelContact`), then the cage's
 * vertices (the drawn body as it is crushed and lifted by its class: the points a hit crushes), then the belly. A torn-off or shattered
 * panel is no part of the drawn body: its vertices (left at rest in `pos`) are no points. Returns the index of the first belly point; the
 * cage's fit is current (`refitCage`).
 */
function loadPoints(car: DeformableCar): number {
  car.refitCage();
  const lift = cageLift(car);
  const { pos, panelOn } = car.cage.fields;
  const { vertexCount, vertexGroup } = car.cage.style;
  let reach2 = 0;
  let n = BODY_FROM;
  for (let k = 0; k < vertexCount; k++) {
    const g = vertexGroup[k]!;
    if (g > 0 && panelOn[g - 1] === 0) continue;
    const x = pos[k * 3]!;
    const y = pos[k * 3 + 1]! + lift;
    const z = pos[k * 3 + 2]!;
    POINT_X[n] = x;
    POINT_Y[n] = y;
    POINT_Z[n] = z;
    n++;
    reach2 = Math.max(reach2, x * x + (y - COM_Y) * (y - COM_Y) + z * z);
  }
  const bellyFrom = n;
  for (let k = 0; k < BELLY.length; k++) {
    const [x, y, z] = BELLY[k]!;
    POINT_X[bellyFrom + k] = x;
    POINT_Y[bellyFrom + k] = y + lift;
    POINT_Z[bellyFrom + k] = z;
    reach2 = Math.max(reach2, x * x + (y + lift - COM_Y) * (y + lift - COM_Y) + z * z);
  }
  _s[S_POINT_REACH] = Math.sqrt(reach2);
  return bellyFrom;
}

/** Loads a part's shape (`LooseShape`: `count` points as offsets from its centre, in its own axes) into the point table, where a car's points go. Returns the index past the last point. */
export function loadShape(shape: LooseShape): number {
  const { points, centre, count } = shape;
  for (let k = 0; k < count; k++) {
    POINT_X[BODY_FROM + k] = centre.x + points[k * 3]!;
    POINT_Y[BODY_FROM + k] = centre.y + points[k * 3 + 1]!;
    POINT_Z[BODY_FROM + k] = centre.z + points[k * 3 + 2]!;
  }
  return BODY_FROM + count;
}

/** Body point `i` of the loaded table from the body's centre of mass, turned by its orientation `q`, into `out`. */
function armOf(i: number, q: THREE.Quaternion, out: THREE.Vector3): THREE.Vector3 {
  const centre = body.centre;
  return out.set(POINT_X[i]! - centre.x, POINT_Y[i]! - centre.y, POINT_Z[i]! - centre.z).applyQuaternion(q);
}

/** Picks the other cars' tops `car`'s queries see (a car in no world sees none); the slice's contact bookkeeping starts here. */
function beginContacts(car: DeformableCar): CarSurfaces {
  const surf = car.surfaces ?? LOCAL;
  surf.begin(car);
  return surf;
}

const _e = new Float64Array(9);
const _hub = new Float64Array(3);
const _hit = new Float64Array(HIT_SIZE);
const WX = Float64Array.from(WHEEL_POS, (p) => p[0]);
const WZ = Float64Array.from(WHEEL_POS, (p) => p[2]);

/** The body's x, y and z axes in world (9 numbers) from `q` into `_e`. */
function basisOf(q: THREE.Quaternion): void {
  const x2 = q.x + q.x;
  const y2 = q.y + q.y;
  const z2 = q.z + q.z;
  const xx = q.x * x2;
  const xy = q.x * y2;
  const xz = q.x * z2;
  const yy = q.y * y2;
  const yz = q.y * z2;
  const zz = q.z * z2;
  const wx = q.w * x2;
  const wy = q.w * y2;
  const wz = q.w * z2;
  _e[0] = 1 - (yy + zz);
  _e[1] = xy + wz;
  _e[2] = xz - wy;
  _e[3] = xy - wz;
  _e[4] = 1 - (xx + zz);
  _e[5] = yz + wx;
  _e[6] = xz + wy;
  _e[7] = yz - wx;
  _e[8] = 1 - (xx + yy);
}

/**
 * Each wheel's contact (`wheelContact`: its tread's footprint on what is under it) with the body as posed, into
 * `car.wheelHit` (slot i at `i * HIT_SIZE`: the lift it needs, the normal, grip, surface, owner and the footprint point).
 * Returns the wheels reaching, bit i: the tread within `within` m above its surface (or in it).
 */
function wheelsAt(car: DeformableCar, within: number): number {
  const p = car.group.position;
  basisOf(car.group.quaternion);
  const hit = car.wheelHit;
  let mask = 0;
  for (let i = 0; i < 4; i++) {
    const sc = car.wheels[i]!.scale.x;
    const r = TYRE_R * sc;
    // The hub on its rest ride: the tyre's bottom is the body's y = 0 for every class.
    _hub[0] = p.x + _e[0]! * WX[i]! + _e[3]! * r + _e[6]! * WZ[i]!;
    _hub[1] = p.y + _e[1]! * WX[i]! + _e[4]! * r + _e[7]! * WZ[i]!;
    _hub[2] = p.z + _e[2]! * WX[i]! + _e[5]! * r + _e[8]! * WZ[i]!;
    wheelContact(_hub, _e, sc, car.slot, _hit);
    const o = i * HIT_SIZE;
    for (let k = 0; k < HIT_SIZE; k++) hit[o + k] = _hit[k]!;
    if (-_hit[C_TOUCH]! <= within && _hit[C_H]! > NO_FLOOR) mask |= 1 << i;
  }
  return mask;
}

/** How many of the wheels in `mask` stand on the world rather than on another car's top. */
function worldWheels(car: DeformableCar, mask: number): number {
  let n = 0;
  for (let i = 0; i < 4; i++) if (((mask >> i) & 1) !== 0 && car.wheelHit[i * HIT_SIZE + C_OWNER]! < 0) n++;
  return n;
}

/** Whether any wheel or body point of `car` as posed is in a surface (or has none under it): a wreck's masses fit a frame whose tilt is clamped, handed over on a ramp's face its rear tyres and bumper were 4–11 cm in. */
export function pressing(car: DeformableCar): boolean {
  const q = car.group.quaternion;
  const pos = car.group.position;
  beginContacts(car);
  wheelsAt(car, 0);
  for (let i = 0; i < 4; i++) {
    const rise = car.wheelHit[i * HIT_SIZE + C_H]!;
    if (rise > 0 || rise === NO_FLOOR) return true;
  }
  const bodyEnd = loadPoints(car);
  for (let i = BODY_FROM; i < bodyEnd; i++) {
    const r = hullPoint(i, q, 0, _r);
    PQ[PQ_X] = pos.x + r.x;
    PQ[PQ_Z] = pos.z + r.z;
    PQ[PQ_Y] = pos.y + r.y;
    pointContact(PQ, car.slot, HIT);
    if (HIT[C_H]! === NO_FLOOR || pos.y + r.y < HIT[C_H]!) return true;
  }
  return false;
}

/**
 * The rate (Hz) at which `stepWorld` splits a step on `car`'s account, 0 for its own slice: a body holding a hard contact or about to
 * (`hardTouch`: a hull point or belly in a surface or reaching one, a tyre at its spring stop or taking a landing), a face yielding under
 * it, or standing on another car is solved at `CONTACT_HZ`. A car rolling on its tyre springs, free flight and a body frozen at rest on
 * its contact (exactly zero speed) cost a normal slice: a derby's wrecks never pay for it, nor do 32 cars driving.
 */
export function contactHz(car: DeformableCar): number {
  if (car.falling || car.deform.massActive) return 0;
  if (car.velocity.lengthSq() === 0 && car.angular.lengthSq() === 0) return 0;
  return car.hardTouch || car.yielding || car.restsOn !== null ? CONTACT_HZ : 0;
}

/** A wreck on its masses touches what its hubs do (`hubContact`: wheel i down while its hub is on its ground) and is in the air while they are (`aloft`). */
export function wreckContact(car: DeformableCar): void {
  car.wheelsDown = car.deform.hubContact(car.wheelHit);
  car.airborne = car.deform.aloft;
}

/**
 * What the body touches as posed, read off the pose where no slice carried it (a keyframe restored): which wheels reach. A wreck on its
 * masses touches what their last slice left (`wreckContact`).
 */
export function readContact(car: DeformableCar): void {
  car.restsOn = null;
  car.yielding = false;
  car.hardTouch = false;
  if (car.deform.massActive) {
    wreckContact(car);
    return;
  }
  beginContacts(car);
  const mask = wheelsAt(car, droop(carClass(car)) + TOUCH);
  car.wheelsDown = mask;
  car.airborne = mask === 0;
}

const _lay = new THREE.Vector3();

/**
 * `car` placed on the active ground once, as a placement and not as physics: its up turned to the mean normal under its four tyres (the
 * heading kept) and its origin raised until none sinks, so it stands as it will roll. Call it where a car is set down on a slope or a bank.
 */
export function layOnGround(car: DeformableCar): void {
  const q = car.group.quaternion;
  const hit = car.wheelHit;
  beginContacts(car);
  wheelsAt(car, 0);
  _lay.set(0, 0, 0);
  for (let i = 0; i < 4; i++) {
    const o = i * HIT_SIZE;
    if (hit[o + C_H]! > NO_FLOOR) _lay.add(_r.set(hit[o + C_NX]!, hit[o + C_NY]!, hit[o + C_NZ]!));
  }
  if (_lay.lengthSq() > 0) q.setFromUnitVectors(UP, _lay.normalize()).multiply(_dq.setFromAxisAngle(UP, car.yaw));
  wheelsAt(car, 0);
  let sink = -Infinity;
  for (let i = 0; i < 4; i++) if (hit[i * HIT_SIZE + C_H]! > NO_FLOOR) sink = Math.max(sink, hit[i * HIT_SIZE + C_H]!);
  if (sink > -Infinity) car.group.position.y += sink;
  _eul.setFromQuaternion(q, "YXZ");
  car.yaw = _eul.y;
  car.pitch = _eul.x;
  car.roll = _eul.z;
  car.refreshBasis();
  readContact(car);
}

/**
 * Whether the contacts just solved (the first `tyres` of `n` are tyres) hold a hard one or are about to: a hull point or a belly's edge in
 * a surface or reaching one within the slice (`nearing`), or a tyre at its spring stop. Tyres riding in their springs are not: a car
 * rolling on the road costs the plain slice.
 */
function hardContactNear(tyres: number, n: number, nearing: boolean): boolean {
  if (nearing || n > tyres) return true;
  for (let c = 0; c < tyres; c++) if (!SOFT[c]) return true;
  return false;
}

/** Whether the body is taking a landing: a wheel within its springs' reach (bit i of `down`) of a surface the body closes on faster than a bounce (`BOUNCE_V`). */
function landing(hit: Float64Array, down: number, v: THREE.Vector3): boolean {
  for (let i = 0; i < 4; i++) {
    if (((down >> i) & 1) === 0) continue;
    const o = i * HIT_SIZE;
    if (v.x * hit[o + C_NX]! + v.y * hit[o + C_NY]! + v.z * hit[o + C_NZ]! < -BOUNCE_V) return true;
  }
  return false;
}

/**
 * The rows' start of a solve, for the body `useBody` set: each row's impulse, dynamic impulse, rest impulse and held friction cleared,
 * the closing speed it rests at (the weight its gravity and `takeBorne` bring), and the face budget (`ROOM`) of each face slot's first row.
 * `n` rows from `readPoints` (and a car's tyres before them).
 */
export function openRows(n: number): void {
  const { dt, surf } = body;
  // The rigid contacts on a face that yields share what it carries in proportion to what each asks, after every pass: cut in list
  // order, the left side of a coupe's belly on a wagon's yielding roof stopped and the right sank, and it rolled 0.43 rad/s off.
  // Shock propagation for the weight: of each contact's closing this slice, the share its own gravity and the weight borne on it
  // (`takeBorne`) bring there is stopped against the car under as fixed and borne on that car for its next step; only closing beyond it
  // (a landing, a rock, a car turning under it) moves both at once. Pushed into the car under at once, every support moved down at the
  // weight above it each slice and was lifted back: 28-34 kJ of lift every 0.5 s on the owner's 11-car column, which then fell.
  // A point closing no faster than one slice of gravity beyond that weight is resting: all it stops is borne. Its few mm/s past the
  // share, given at once, moved the car under before that car's own contacts held it: the house of cards' base cars walked 2.5 and
  // 3.7 mm apart in 10 s under the car across their roofs.
  for (let c = 0; c < n; c++) {
    ACC[c] = 0;
    DYN[c] = 0;
    RIMP[c] = 0;
    NOTED[c] = 0;
    CLOSE_FIRST[c] = 0;
    FRA[c]!.set(0, 0, 0);
    if (SOFT[c]) REST[c] = (G / 4) * dt;
    else {
      weightClosing(c);
      REST[c] = _s[S_WEIGHT]!;
      if (CLOSING[c]! <= REST[c]! + G * dt) REST[c] = Infinity;
    }
    FIRST[c] = -1;
    const s = SLOT[c]!;
    if (SOFT[c] || s < 0) continue;
    FIRST[c] = c;
    for (let k = 0; k < c; k++) {
      if (!SOFT[k] && SLOT[k] === s) {
        FIRST[c] = k;
        break;
      }
    }
    if (FIRST[c] !== c) continue;
    ROOM[c] = surf.room(s, G, dt);
    DEMAND[c] = 0;
  }
}

/**
 * Contact `c` first closes on the car under it, `closing` m/s along its face's normal beyond what its weight rests at (`pointVel` has just
 * read the point's velocity against that car's, into `_vp`): the contact is a hit when that is past the crush law's graze
 * (`CRASH.grazeMps`), a point sliding along a gentle top (a truck driving the length of a sedan's roof) closes on it at a fraction of its
 * speed and crushes nothing. A hit's approach is read along the row's plan normal, as the pair contact reads one, and its point kept for
 * `collectCrush`. A row whose normal has no plan part (a roof landed on) has no side to crush and keeps none.
 */
function noteClosing(c: number, closing: number): void {
  if (NOTED[c] === 1) return;
  NOTED[c] = 1;
  const plan = hypot2(N[c]!.x, N[c]!.z);
  if (closing <= CRASH.grazeMps || plan < MIN_SIDE_PLAN) return;
  _crushNormal.set(N[c]!.x / plan, 0, N[c]!.z / plan);
  CLOSE_FIRST[c] = -(_vp.x * _crushNormal.x + _vp.z * _crushNormal.z);
  _crushPoint.copy(centreOfMass).add(R[c]!).toArray(CRUSH_POINT, c * 3);
}

/**
 * The Gauss-Seidel solve of `n` rows, then the lift out: `PASSES` passes at each row's lever (`reach`), a closing contact taking what
 * it needs (restitution `RESTITUTION` above `BOUNCE_V` on the first pass), a parting one giving back what it over-took, Coulomb
 * friction at the row's `MU` bounded by the normal impulse held, the face budgets cut in list order, and the body then lifted out by
 * the deepest depth its move leaves (straight up where its friction holds it, else along the face's normal): the centre of mass only;
 * `standAtCentre` then puts the body's origin there.
 */
export function solveRows(n: number): void {
  const { v, w, q, dt, surf, driven, parked, powered, part } = body;
  // How deep the belly is in the world's ground (m, vertical): what a body at rest lifts out of.
  let under = 0;
  // Each row's depth along its surface normal still to lift out (a steep face's vertical gap overstates it): `LEFT`.
  for (let pass = 0; pass < PASSES; pass++) {
    for (let c = 0; c < n; c++) {
      const nrm = N[c]!;
      let jn: number;
      if (SOFT[c]) {
        // A tyre in its springs: once a slice its spring and damper push the body straight up, whatever face its tread meets, the damper
        // on the rate that face rises under the wheel. Pushed along the face's normal and rigid up to 8 g, a monster's rear tyres against
        // a sedan's rear window (n.y 0.43) took its whole drive; along the body's up axis a car rolled 32° on one tyre was kicked
        // 1 rad/s sideways into a wedge's wall; straight up but rigid, a car whose front had passed a ramp's lip sank its rear into the
        // face (v.y 3.2 -> 1.3 m/s in 12 frames). Friction stays in the face's plane, held by that push on every pass.
        jn = ASK[c]!;
      } else {
        const dir = DIR[c]!;
        const vn = pointVel(c, v, w, _vp).dot(nrm) + GAPV[c]!;
        // A contact that closes takes what it needs. One that already parts takes back, of the dynamic impulse the earlier passes gave it,
        // what its parting asks (never more: it never pulls). A neighbour's impulse that had over-corrected it kept it for good, so the
        // first of several equal contacts took most of the load and rolled the car: an 11-car column walked 69 mm for the order the belly's
        // points are listed in.
        if (vn >= 0 && DYN[c] === 0 && RIMP[c] === 0) continue;
        if (vn >= 0) {
          reach(c, dir, nrm, q, true);
          const asked = -vn * _s[S_REACH]!;
          jn = Math.max(-DYN[c]!, asked);
          ACC[c] = ACC[c]! + jn;
          DYN[c] = DYN[c]! + jn;
          if (jn !== 0) {
            _s[S_J] = jn;
            _s[S_JD] = jn;
            give(c, v, w, q, dir, surf);
          }
          reach(c, dir, nrm, q, true);
          const left = vn + jn / _s[S_REACH]!;
          if (left > 0 && RIMP[c]! > 0) {
            reach(c, dir, nrm, q, false);
            const lone = _s[S_REACH]!;
            const back = Math.max(-RIMP[c]!, -left * lone);
            ACC[c] = ACC[c]! + back;
            RIMP[c] = RIMP[c]! + back;
            REST[c] = REST[c]! - back / lone;
            _s[S_J] = back;
            _s[S_JD] = 0;
            give(c, v, w, q, dir, surf);
            jn += back;
          }
        } else {
          const e = pass === 0 && !TYRE[c] && !UNDER[c] && vn < -BOUNCE_V ? RESTITUTION : 0;
          const rest = Math.min(-vn, REST[c]!);
          REST[c] = REST[c]! - rest;
          reach(c, dir, nrm, q, true);
          const jd = (1 + e) * (-vn - rest) * _s[S_REACH]!;
          if (OWN[c]! >= 0 && !part) noteClosing(c, -vn - rest);
          reach(c, dir, nrm, q, false);
          const jr = rest * _s[S_REACH]!;
          jn = jr + jd;
          ACC[c] = ACC[c]! + jn;
          DYN[c] = DYN[c]! + jd;
          RIMP[c] = RIMP[c]! + jr;
          _s[S_J] = jn;
          _s[S_JD] = jd;
          give(c, v, w, q, dir, surf);
        }
      }
      if (driven && OWN[c]! < 0) continue;
      // Friction against the point's sliding: a tyre grips only across its tread (its axle laid in the contact plane) where it
      // rolls: on the world's ground and under power. A car in flight on another car's top is unpowered with its wheels not
      // turning under it, and a free-rolling tyre slid a car down the 8° of a pickup's bed at 0.38 m/s, for good: it grips both ways.
      pointVel(c, v, w, _vp);
      _vp.addScaledVector(nrm, -_vp.dot(nrm));
      if (TYRE[c] && !parked && (OWN[c]! < 0 || powered)) {
        // Across the tread is square to the way the drive moves the car (its nose, laid in the contact plane). The axle laid in the
        // plane is not, on a face tilted both ways: a monster's rear tyres on a sedan's rear-window corners (n -0.47, 0.38, -0.80)
        // gripped 0.42 of its forward speed and drove off the sedan 16 % slower than off a platform.
        _tn.crossVectors(nrm, _z);
        if (_tn.lengthSq() < 1e-12) _tn.copy(_x).addScaledVector(nrm, -_x.dot(nrm));
        _tn.normalize();
        const across = _vp.dot(_tn);
        _vp.copy(_tn).multiplyScalar(across);
      }
      const slide = _vp.length();
      if (slide < 1e-6) continue;
      // Friction holds what the contact carries over the passes: its normal impulse after a yielding face's cut (a tyre in its springs:
      // its push). Bounded by each pass's push instead, a sedan's belly rows on a roof whose budget its tyres had spent gripped at 0.6 of
      // impulses the cut then took back, and the sedan under took that grip as a 4 rad/s roll.
      // The car under takes the grip as it takes the weight (`bear`, after its move): taken at once, it moved by it before its own
      // contacts held it, and a stack held by its grip walked 0.5 F dt every second (2-4 mm/s at the slice's 1.75 ms).
      _tn.copy(_vp).divideScalar(-slide);
      reach(c, _tn, _tn, q, false);
      _fd.copy(FRA[c]!).addScaledVector(_tn, slide * _s[S_REACH]!);
      // A contact's give-backs over the passes can leave what it carries a rounding error below zero (-2.6e-18): its bound is then nil,
      // not negative, or the bound turned the held grip around and a grip of 0 against it divided by 0 (NaN through a stack of sedans).
      const cap = MU[c]! * Math.max(0, SOFT[c] ? jn : ACC[c]!);
      const held = _fd.length();
      if (held > cap) _fd.multiplyScalar(cap / held);
      _fd.sub(FRA[c]!);
      FRA[c]!.add(_fd);
      const fj = _fd.length();
      if (fj < 1e-9) continue;
      _s[S_J] = fj;
      _s[S_JD] = 0;
      give(c, v, w, q, _fd.divideScalar(fj), surf);
    }
    for (let c = 0; c < n; c++) if (FIRST[c] === c) SUMF[c] = 0;
    for (let c = 0; c < n; c++) if (FIRST[c]! >= 0) SUMF[FIRST[c]!] = SUMF[FIRST[c]!]! + ACC[c]!;
    for (let c = 0; c < n; c++) {
      const f = FIRST[c]!;
      if (f < 0) continue;
      if (f === c) DEMAND[c] = Math.max(DEMAND[c]!, SUMF[c]!);
      if (SUMF[f]! <= ROOM[f]!) continue;
      const cut = ACC[c]! * (1 - ROOM[f]! / SUMF[f]!);
      const cutD = DYN[c]! * (1 - ROOM[f]! / SUMF[f]!);
      _s[S_J] = -cut;
      _s[S_JD] = -cutD;
      give(c, v, w, q, DIR[c]!, surf);
      ACC[c] = ACC[c]! - cut;
      DYN[c] = DYN[c]! - cutD;
      const cap = MU[c]! * Math.max(0, ACC[c]!);
      const held = FRA[c]!.length();
      if (held <= cap) continue;
      _fd.copy(FRA[c]!).multiplyScalar(-1 / held);
      FRA[c]!.multiplyScalar(cap / held);
      _s[S_J] = held - cap;
      _s[S_JD] = 0;
      give(c, v, w, q, _fd, surf);
    }
  }
  for (let c = 0; c < n; c++) {
    if (FIRST[c] === c) surf.take(SLOT[c]!, DEMAND[c]!, G, dt);
    if (!SOFT[c] && OWN[c]! >= 0 && CLOSING[c]! < WALL_CRUSH) surf.press(OWN[c]!, ACC[c]! * DIR[c]!.y);
  }
  // The deepest point the surface can still hold up lifts the body out (a face that yields sinks instead). The belly over the
  // world's ground only resists (impulse, no bounce, no lift while it moves): lifting a moving body out by a belly point's
  // depth pumped energy into a car resting on a ramp's edge (it tipped off) and hopped a car rolling back out of the corkscrew's mouth.
  // Nor does a point already moving off its surface lift anything: its impulse is nil, so the lift raised the body with no speed to
  // show for it (a wreck's pitching tail moved it 1-3 cm a frame over another car's roof, fleet-ramps D1). A part is put out of a face
  // that moved onto it (a solid driven over a part at rest: no closing at all) whatever its speed.
  // The lift takes out only the depth the move leaves: the solve's change already moves the body half its way (the trapezoid rule).
  // Lifted by the whole depth too, a car on another's roof rose G dt² (0.03 mm) over it, fell free the next slice, and hopped so.
  _dvSolve.copy(v).sub(_vMove);
  const solveMove = _dvSolve.length();
  if (solveMove > SOLVE_MOVE_G * G * dt) _dvSolve.multiplyScalar((SOLVE_MOVE_G * G * dt) / solveMove);
  for (let c = 0; c < n; c++) {
    const s = SLOT[c]!;
    LEFT[c] = -Infinity;
    if (UNDER[c]) under = Math.max(under, Math.min(SINK[c]!, CLOSING[c]! < BOUNCE_V ? CLOSING[c]! * dt : 0));
    else if (s >= 0 && surf.isYielding(s)) {
      if (!SOFT[c]) surf.note(s, SINK[c]!, FOLLOW[c]!);
    } else if (part || CLOSING[c]! > 0) {
      // A driven car's tyres climb what it drives onto (a step, a kerb: the lift is how the body mounts it). Any other body (a wreck, a
      // part) lands on a face only from within the slice's reach: a point already deeper than its closing carried it in was inside before
      // this slice, so the stop holds it and the lift does not set the body up on a top it did not land on (a wreck's cage edge 7 cm
      // inside a ramp's end was lifted 7.9 cm onto it).
      const left = SINK[c]! - 0.5 * dt * _dvSolve.dot(N[c]!);
      if (part || driven || left - CLOSING[c]! * dt <= SPECULATIVE_GAP) LEFT[c] = left;
    }
  }
  centreOfMass.addScaledVector(_dvSolve, 0.5 * dt);
  // The lift takes out the deepest row, once, by moving the whole body.
  let deep = 0;
  let deepC = -1;
  for (let c = 0; c < n; c++) {
    if (LEFT[c]! > deep) {
      deep = LEFT[c]!;
      deepC = c;
    }
  }
  if (deepC >= 0) {
    // A point its friction holds (gripping both ways, under its cap at the passes, on a face no steeper than that friction) goes back
    // up the way the slice's drop took it in: straight up by its depth there. Lifted along the face's normal, each slice's drop under
    // gravity walked a car at rest down its support: a sedan frozen on another's crushed roof (normal 1° off) crept 0.68 mm a second.
    const mu = MU[deepC]!;
    const grips = (!driven || OWN[deepC]! >= 0) && (!TYRE[deepC] || parked || (OWN[deepC]! >= 0 && !powered));
    if (DIR[deepC] === UP || (grips && hypot2(N[deepC]!.x, N[deepC]!.z) <= mu * N[deepC]!.y && FRA[deepC]!.length() < mu * ACC[deepC]!)) _lift.set(0, deep / N[deepC]!.y, 0);
    else _lift.copy(N[deepC]!).multiplyScalar(deep);
    centreOfMass.add(_lift);
  }
  centreOfMass.y += under;
}

/** A row's normal needs at least this plan part (its horizontal length) to be a side a crush can run along: a roof landed on has none. */
const MIN_SIDE_PLAN = 0.1;
/** Hits the rigid step has seen cars meet this slice, waiting for `armCrushRows`: at most this many (a pile's further ones are the same cars' again). */
const PENDING_CAPACITY = 16;
const P_X = 0;
const P_Y = 1;
const P_Z = 2;
const P_NX = 3;
const P_NZ = 4;
const P_CLOSING = 5;
const P_EBS_A2 = 6;
const P_EBS_B2 = 7;
const P_DEPTH = 8;
const P_PLASTIC = 9;
/** The two cars' velocity and spin (3 + 3 numbers each) as they stood before the rows' exchange: the crush is armed with its masses at that speed. */
const P_PRE_A = 10;
const P_PRE_B = 16;
const PENDING_STRIDE = 22;
const PENDING = new Float64Array(PENDING_CAPACITY * PENDING_STRIDE);
const PENDING_A: (DeformableCar | null)[] = new Array(PENDING_CAPACITY).fill(null);
const PENDING_B: (DeformableCar | null)[] = new Array(PENDING_CAPACITY).fill(null);
/** How many of the `PENDING` hits are waiting (a field, not a module binding: the boundary check counts those). */
const queue = { size: 0 };
/** The stepping car's velocity and spin, and each row's car under it's, before the solve (`snapshotRows`). */
const PRE_A = new Float64Array(6);
const PRE_B = new Float64Array(CONTACTS * 6);
const _postV = new THREE.Vector3();
const _postW = new THREE.Vector3();
const _centre = new THREE.Vector3();

/** What the stepping car and the cars its rows rest on move at, before the solve gives them any impulse: the speeds their crush is armed with. */
function snapshotRows(car: DeformableCar, n: number): void {
  car.velocity.toArray(PRE_A, 0);
  car.angular.toArray(PRE_A, 3);
  for (let c = 0; c < n; c++) {
    const o = HELD[c];
    if (o === null || o === undefined) continue;
    o.velocity.toArray(PRE_B, c * 6);
    o.angular.toArray(PRE_B, c * 6 + 3);
  }
}

/**
 * The hit each of `car`'s rows against another car met this slice: the crush energy of the contact is the kernel's plastic exchange of
 * the closing it first met (`plasticEnergy`, the way `bodyContact` reads an approach: what the pair has to give, whatever the rows' own
 * impulses and the faces' cuts then made of it), split between the two cars as `bodyContact` splits it (`barrierSpeed`) at the pair's
 * masses, as the pair contact reads a hit through the centres (a hit off a car's centre loads it by its lever in the kernel: the pair
 * contact takes that with its move to the kernel, Stage 4 item 5 (car-car through the kernel)). One hit per car pair, at the point and along the normal of the row that
 * closed hardest. A contact closing no faster than the crush law's graze (`CRASH.grazeMps`) crushes nothing, so a car standing or
 * driving on another arms none.
 */
function collectCrush(car: DeformableCar, n: number): void {
  for (let c = 0; c < n; c++) {
    const closing = CLOSE_FIRST[c]!;
    if (closing <= CRASH.grazeMps) continue;
    const other = HELD[c];
    const k = 1 + (other === null ? 0 : RATIO[c]!);
    const plastic = plasticEnergy(closing, 1 / k);
    const ebsA = barrierSpeed(plastic, 1, 1, 1, k);
    const ebsB = other === null ? 0 : barrierSpeed(plastic, RATIO[c]!, RATIO[c]!, 1, k);
    let slot = -1;
    for (let i = 0; i < queue.size; i++) if (PENDING_A[i] === car && PENDING_B[i] === other) slot = i;
    if (slot < 0) {
      if (queue.size === PENDING_CAPACITY) continue;
      slot = queue.size++;
      PENDING_A[slot] = car;
      PENDING_B[slot] = other;
      PENDING.fill(0, slot * PENDING_STRIDE, (slot + 1) * PENDING_STRIDE);
      PENDING.set(PRE_A, slot * PENDING_STRIDE + P_PRE_A);
      if (other !== null) PENDING.set(PRE_B.subarray(c * 6, c * 6 + 6), slot * PENDING_STRIDE + P_PRE_B);
    }
    const f = slot * PENDING_STRIDE;
    PENDING[f + P_EBS_A2] = Math.max(PENDING[f + P_EBS_A2]!, ebsA * ebsA);
    PENDING[f + P_EBS_B2] = Math.max(PENDING[f + P_EBS_B2]!, ebsB * ebsB);
    if (plastic <= PENDING[f + P_PLASTIC]!) continue;
    const plan = hypot2(N[c]!.x, N[c]!.z);
    PENDING[f + P_PLASTIC] = plastic;
    PENDING[f + P_X] = CRUSH_POINT[c * 3]!;
    PENDING[f + P_Y] = CRUSH_POINT[c * 3 + 1]!;
    PENDING[f + P_Z] = CRUSH_POINT[c * 3 + 2]!;
    PENDING[f + P_NX] = N[c]!.x / plan;
    PENDING[f + P_NZ] = N[c]!.z / plan;
    PENDING[f + P_CLOSING] = closing;
    PENDING[f + P_DEPTH] = Math.max(0, SINK[c]!);
  }
}

/**
 * Arms `car`'s crush at `point` along `inward` as the contact stood before the rows' exchange: its masses start at the speed the car
 * had then (`PENDING` at `pre`), and the exchange's change of the car's speed and spin since (planar, about its centre of mass) is handed
 * to them as the kernel's increment (`shiftBody`, the face moving at `common` along `inward`). Armed after it, the masses had no closing
 * to crush with. A car whose masses already run (armed earlier this slice) takes the hit as it stands.
 */
function armAtExchange(car: DeformableCar, pre: number, point: THREE.Vector3, inward: THREE.Vector3, closing: number, ebs: number, common: number): void {
  if (!car.rigid) {
    car.applyImpact(point, inward, closing, ebs);
    return;
  }
  _postV.copy(car.velocity);
  _postW.copy(car.angular);
  car.velocity.fromArray(PENDING, pre);
  car.angular.fromArray(PENDING, pre + 3);
  car.applyImpact(point, inward, closing, ebs);
  _centre.set(0, COM_Y, 0).applyQuaternion(car.group.quaternion).add(car.group.position);
  car.deform.shiftBody(_postV.x - PENDING[pre]!, _postV.z - PENDING[pre + 2]!, _postW.y - PENDING[pre + 4]!, _centre.x, _centre.z, inward.x, inward.z, common);
}

/** The two cars' common speed along `n` (unit): the mass-weighted mean of their velocities' parts along it. */
function commonSpeed(a: DeformableCar, b: DeformableCar, n: THREE.Vector3): number {
  const massA = a.deform.totalMass;
  const massB = b.deform.totalMass;
  return (massA * a.velocity.dot(n) + massB * b.velocity.dot(n)) / (massA + massB);
}

/**
 * The pair contact's hit (cars `a` and `b` at `point`, `normal` out of `b` into `a`, closing at `closing`, barrier speeds `shareA`,
 * `shareB`), when the rows of the rigid step had met the same cars this slice (`collectCrush`): one contact, armed once, as it stood
 * before the rows' exchange and at the larger of the two readings of it (the rows read the whole approach, the pair contact what their
 * exchange left of it). The rows' hit is spent. False when the rows saw no such contact: the pair contact arms it alone.
 */
export function armPairWithRows(a: DeformableCar, b: DeformableCar, point: THREE.Vector3, normal: THREE.Vector3, closing: number, shareA: number, shareB: number): boolean {
  let first = -1;
  let ebsA2 = shareA * shareA;
  let ebsB2 = shareB * shareB;
  for (let i = 0; i < queue.size; i++) {
    const same = PENDING_A[i] === a && PENDING_B[i] === b;
    if (!same && !(PENDING_A[i] === b && PENDING_B[i] === a)) continue;
    if (first < 0) first = i;
    ebsA2 = Math.max(ebsA2, PENDING[i * PENDING_STRIDE + (same ? P_EBS_A2 : P_EBS_B2)]!);
    ebsB2 = Math.max(ebsB2, PENDING[i * PENDING_STRIDE + (same ? P_EBS_B2 : P_EBS_A2)]!);
  }
  if (first < 0) return false;
  const swapped = PENDING_A[first] !== a;
  const common = commonSpeed(a, b, normal);
  _crushBack.copy(normal).negate();
  armAtExchange(a, first * PENDING_STRIDE + (swapped ? P_PRE_B : P_PRE_A), point, normal, closing, Math.sqrt(ebsA2), common);
  armAtExchange(b, first * PENDING_STRIDE + (swapped ? P_PRE_A : P_PRE_B), point, _crushBack, closing, Math.sqrt(ebsB2), -common);
  for (let i = queue.size - 1; i >= 0; i--) {
    if (!((PENDING_A[i] === a && PENDING_B[i] === b) || (PENDING_A[i] === b && PENDING_B[i] === a))) continue;
    queue.size--;
    PENDING.copyWithin(i * PENDING_STRIDE, queue.size * PENDING_STRIDE, (queue.size + 1) * PENDING_STRIDE);
    PENDING_A[i] = PENDING_A[queue.size]!;
    PENDING_B[i] = PENDING_B[queue.size]!;
  }
  return true;
}

/** The largest closing (m/s) the rigid step's rows read for the pair `a`, `b` this slice, before their exchange (0 when they met none): what the pair met with, which the pair contact finds already traded in part. */
export function rowsClosing(a: DeformableCar, b: DeformableCar): number {
  let closing = 0;
  for (let i = 0; i < queue.size; i++) {
    if ((PENDING_A[i] === a && PENDING_B[i] === b) || (PENDING_A[i] === b && PENDING_B[i] === a)) closing = Math.max(closing, PENDING[i * PENDING_STRIDE + P_CLOSING]!);
  }
  return closing;
}

/**
 * Arms each hit `collectCrush` saw that the pair contact did not take (`armPairWithRows`), once the slice's contacts are solved
 * (`stepWorld`): both cars' crush at the contact point along the normal, at their share of the exchange's barrier speed, and fed the
 * contact's depth and closing as the pair contact feeds its own (`feedOverlap`), at the pair's common speed along the normal.
 */
export function armCrushRows(dt: number): void {
  for (let i = 0; i < queue.size; i++) {
    const a = PENDING_A[i]!;
    const b = PENDING_B[i];
    const f = i * PENDING_STRIDE;
    _crushPoint.set(PENDING[f + P_X]!, PENDING[f + P_Y]!, PENDING[f + P_Z]!);
    _crushNormal.set(PENDING[f + P_NX]!, 0, PENDING[f + P_NZ]!);
    _crushBack.copy(_crushNormal).negate();
    const closing = PENDING[f + P_CLOSING]!;
    const fed = Math.max(PENDING[f + P_DEPTH]!, closing * dt);
    const common = b === null ? 0 : commonSpeed(a, b, _crushNormal);
    armAtExchange(a, f + P_PRE_A, _crushPoint, _crushNormal, closing, Math.sqrt(PENDING[f + P_EBS_A2]!), common);
    if (b !== null) armAtExchange(b, f + P_PRE_B, _crushPoint, _crushBack, closing, Math.sqrt(PENDING[f + P_EBS_B2]!), -common);
    a.deform.feedOverlap(_crushPoint, _crushNormal, fed, closing, dt, common);
    a.deform.notifyContact();
    if (b === null) continue;
    b.deform.feedOverlap(_crushPoint, _crushBack, fed, closing, dt, -common);
    b.deform.notifyContact();
  }
  queue.size = 0;
}

/**
 * One slice of a rigid body's flight for `car` (`velocity` is its centre of mass's, `angular` its world spin): the four
 * wheels' footprints (`wheelContact`) and the hull's points meet the surfaces under them through impulses. Returns true
 * when it is back on its wheels: three of them on the world's ground (the caller hands it to the pose-following step).
 * `car.airborne`, `wheelsDown` and `restsOn` are derived from the contacts.
 */
export function stepFree(car: DeformableCar, dt: number): boolean {
  const q = car.group.quaternion;
  const pos = car.group.position;
  const v = car.velocity;
  const w = car.angular;
  useBody(car.group, v, w, CAR_CENTRE, INV_I, car.slot, false, dt);
  moveBody();
  if (!car.crashed && !car.falling && car.wheelsDown !== 0) {
    // A driven car's heading is its steering's alone, held by its tyres that touch: a roll about a pitched body's horizontal axis swings
    // its nose sideways (a lip's 23° of roll under 14° of pitch read as 4° of yaw), so the Euler yaw goes back to the car's own. With no
    // tyre on anything nothing holds it: held, a corkscrew's 27 m/s car rolled 1030° in 3.87 s of flight on a spin of 197°/s (762°).
    let drift = _eul.setFromQuaternion(q, "YXZ").y - car.yaw;
    drift -= 2 * Math.PI * Math.round(drift / (2 * Math.PI));
    if (Math.abs(drift) < YAW_HOLD) q.premultiply(_dq.setFromAxisAngle(UP, -drift));
  }
  placeBody();
  const y0 = pos.y;
  const mass = car.deform.totalMass;
  body.mass = mass;

  const surf = beginContacts(car);
  body.surf = surf;
  // The weight the cars on its top bore on it since its last step, taken after its move so its contacts hold it (no sinking under it).
  surf.takeBorne(car.slot, _lv, _lw);
  v.add(_lv);
  w.add(_lw);
  const cls = carClass(car);
  const spring = droop(cls);
  const within = spring + TOUCH;
  const stop = 2 * spring;
  // A driven car with a wheel on a surface, the world's ground or another car's top alike, rolls on it: the drive owns its travel along
  // the road, so the world's faces neither drag it nor grip its tyres along their tread (a rear tyre meeting a ramp's toe at 30° with the
  // front in the air turned its travel 2-3° through the face's slope and the tyre's friction against the body's spin).
  // Every body's tyres are read each slice, a wreck's too: skipped, a wreck's tyres kept their reading from its hand-over and it never
  // landed on them (a struck wreck came to rest on its belly 10 cm in the floor, its tyres read 0.9-1.5 m up).
  const rolling = wheelsAt(car, within) !== 0 && !car.crashed;
  const driven = rolling && !car.parked;
  const hit = car.wheelHit;
  body.driven = driven;
  body.parked = car.parked;
  // A driven wheel rolls freely along its tread wherever it stands; an unpowered one on another car's top grips both ways.
  const powered = car.drive.throttle !== 0;
  body.powered = powered;
  // A tyre within its springs' full travel of the surface, its wheel hanging down to its droop below the rest ride, sits in them: the
  // class's spring and damper (`SPRINGS`, the drawn suspension's: per corner a quarter of the car, k = ω², c = 2ζω, a quarter of its
  // weight at the rest ride) push the body straight up, and it takes no positional lift. Past that travel, and for every body point,
  // the contact is rigid. Rigid tyres stopped a nose-first landing's front in one slice: 35 g on the body within one frame.
  const sp = SPRINGS[cls];
  const om = 2 * Math.PI * sp.hz;
  const stiff = (om * om) / 4;
  const damp = (sp.zeta * om) / 2;
  let n = 0;
  _x.set(1, 0, 0).applyQuaternion(q);
  _z.set(0, 0, 1).applyQuaternion(q);
  for (let i = 0; i < 4; i++) {
    const o = i * HIT_SIZE;
    const pen = hit[o + C_H]!;
    if (!(pen > -spring)) continue;
    const own = hit[o + C_OWNER]!;
    R[n]!.set(hit[o + C_PX]! - centreOfMass.x, hit[o + C_PY]! - centreOfMass.y, hit[o + C_PZ]! - centreOfMass.z);
    N[n]!.set(hit[o + C_NX]!, hit[o + C_NY]!, hit[o + C_NZ]!);
    TYRE[n] = true;
    MU[n] = MU_TYRE;
    OWN[n] = own;
    DIR[n] = N[n]!.y >= CLIMB_NY ? UP : N[n]!;
    UNDER[n] = false;
    FOLLOW[n] = own >= 0 ? hit[o + C_AUX]! : 1;
    SLOT[n] = surf.slot(own, N[n]!, false, q, FOLLOW[n]!);
    // How far past what holds it the point is: a tyre's springs and their full travel; a wreck's tyre no deeper than its masses
    // hold it (`HUB_FLOOR` under its hub): sunk to the springs' stop, a wreck's front tyres sat 0.13 m in a wedge's face when it
    // landed, and its masses lifted them out by the difference in the slice they took it.
    const sink = pen * N[n]!.y - (car.crashed ? Math.min(stop, TYRE_R * car.wheels[i]!.scale.x - HUB_FLOOR) : stop);
    SOFT[n] = sink < 0;
    GAPV[n] = 0;
    SINK[n] = sink;
    PRESS[n] = pen;
    carrier(surf, n, own, mass);
    CLOSING[n] = Math.max(0, -pointVel(n, v, w, _vp).dot(N[n]!));
    if (own >= 0 && CLOSING[n]! < WALL_CRUSH) surf.touch(own);
    n++;
  }
  const tyres = n;
  // A point that stays higher than the static surface anywhere within its slice's plan travel, by its descent over the slice and a
  // speculative gap, neither meets nor nears it: no reading. The car tops are read whenever one stands within the body's reach.
  const statics = activeGround();
  const speed = v.length();
  const turnRate = w.length();
  const bellyFrom = loadPoints(car);
  const pointEnd = bellyFrom + BELLY.length;
  const pointReach = _s[S_POINT_REACH]!;
  const bodyReach = pointReach + (speed + turnRate * pointReach) * dt;
  const readAll = topsTop(car.slot, centreOfMass.x - bodyReach, centreOfMass.x + bodyReach, centreOfMass.z - bodyReach, centreOfMass.z + bodyReach) > -Infinity;
  // The whole body at once first: each point's box below and each belly segment's lies within the points' boxes together, so a raster
  // under all of them lower than the lowest point's clearance clears every point and segment in one read (measured: 84 % of the slices
  // of a 32-car race at aggression 1, 93 % at 0). The points come off the body's axes (`_e`, `wheelsAt` set it from `q`), each moving at
  // most the body's plan speed (fall) plus its turn at the farthest point, and `CLEAR_ROUND` covers these axes' rounding against
  // `armOf`'s: a bound on every point's own test, so it clears only what that would.
  let allClear = false;
  if (!readAll) {
    const turn = turnRate * _s[S_POINT_REACH]!;
    const pad = (hypot2(v.x, v.z) + turn) * dt + CLEAR_ROUND;
    let xMin = Infinity;
    let xMax = -Infinity;
    let zMin = Infinity;
    let zMax = -Infinity;
    let low = Infinity;
    for (let i = BODY_FROM; i < pointEnd; i++) {
      const x = POINT_X[i]!;
      const y = POINT_Y[i]! - COM_Y;
      const z = POINT_Z[i]!;
      const rx = _e[0]! * x + _e[3]! * y + _e[6]! * z;
      const rz = _e[2]! * x + _e[5]! * y + _e[8]! * z;
      xMin = Math.min(xMin, rx);
      xMax = Math.max(xMax, rx);
      zMin = Math.min(zMin, rz);
      zMax = Math.max(zMax, rz);
      low = Math.min(low, _e[1]! * x + _e[4]! * y + _e[7]! * z);
    }
    const descent = (Math.max(0, -v.y) + turn) * dt + SPECULATIVE_GAP + CLEAR_ROUND;
    allClear = staticTop(statics, centreOfMass.x + xMin - pad, centreOfMass.x + xMax + pad, centreOfMass.z + zMin - pad, centreOfMass.z + zMax + pad, true) < centreOfMass.y + low - descent;
  }
  n = readPoints(allClear ? pointEnd : BODY_FROM, pointEnd, bellyFrom, n, !readAll);
  // Between two belly points on different patches the belly meets that edge where it crosses (`edgeCross`, the tyres' rule): a car
  // dropped level across a ramp's crest balanced on the row in front of it, the crest 17 cm inside the belly half a metre behind.
  // Over one car's top (one patch) the pan's lines rest on the top's ridge between their points where that stands above both
  // (`ridgeCross`), pressed along the belly's own normal, not the windscreen's: a sedan on another's roof, its middle row on the roof and
  // its front row past the roof's front edge, tipped 10° nose-down onto the windscreen with its centre still 25 cm behind that edge.
  _up.set(0, 1, 0).applyQuaternion(q);
  const panFrom = bellyFrom + BELLY.length - PAN.length;
  for (let s = allClear ? SEGS.length : 0; s < SEGS.length; s += 2) {
    let a = bellyFrom + SEGS[s]!;
    let b = bellyFrom + SEGS[s + 1]!;
    // Both ends unread and the static surface under the segment lower than its lower end: the segment meets nothing.
    if (UNREAD[a] === 1 && UNREAD[b] === 1) {
      const xMin = Math.min(BX[a]!, BX[b]!);
      const xMax = Math.max(BX[a]!, BX[b]!);
      const zMin = Math.min(BZ[a]!, BZ[b]!);
      const zMax = Math.max(BZ[a]!, BZ[b]!);
      if (staticTop(statics, xMin, xMax, zMin, zMax) < Math.min(BY[a]!, BY[b]!)) continue;
    }
    if (UNREAD[a] === 1) readBelly(a, car.slot);
    if (UNREAD[b] === 1) readBelly(b, car.slot);
    let pen: number;
    if (BPATCH[a] === BPATCH[b]) {
      if (!(BPATCH[a]! >= 0) || a < panFrom || b < panFrom) continue;
      pen = ridgeCross(BX[a]!, BY[a]!, BZ[a]!, BX[b]!, BY[b]!, BZ[b]!, car.slot, BPATCH[a]!);
      if (!(pen > 0 && pen > BRISE[a]! && pen > BRISE[b]!)) continue;
      EDGE_HIT[C_NX] = _up.x;
      EDGE_HIT[C_NY] = _up.y;
      EDGE_HIT[C_NZ] = _up.z;
    } else {
      if (BRISE[b]! > BRISE[a]!) {
        a = b;
        b = bellyFrom + SEGS[s]!;
      }
      if (BRISE[a] === NO_FLOOR) continue;
      pen = edgeCross(BX[a]!, BY[a]!, BZ[a]!, BX[b]!, BY[b]!, BZ[b]!, 0, 0, 0, 0, NaN, car.slot, BPATCH[a]!);
      if (!(pen > 0)) continue;
    }
    R[n]!.set(EDGE_HIT[C_PX]! - centreOfMass.x, EDGE_HIT[C_PY]! - centreOfMass.y, EDGE_HIT[C_PZ]! - centreOfMass.z);
    if (!body.part && EDGE_HIT[C_OWNER]! >= 0 && crossedPlanFromSide(EDGE_HIT, pen, R[n]!)) continue;
    _s[S_PEN] = pen;
    bodyContact(n, EDGE_HIT, false);
    n++;
  }

  // The tyres in their springs push together, from the slice's state, and share each face's budget (`take`) in proportion to what each
  // asks: in list order the first spent it, and a coupe's two rear tyres landing on a wagon's roof took 6.2 and 2.3 of 6.2 each and rolled
  // it off the column.
  springPushes(tyres, stiff, damp, dt, q, v, w);
  for (let c = 0; c < tyres; c++) {
    if (!SOFT[c]) continue;
    // A tyre within a speculative gap of its stop whose spring pushes less than the weight the slice brings onto it rests on the stop,
    // held there like a body point (`GAPV`): left on its springs, a wreck's rear tyres just short of their stop under a four-car stack
    // fell onto it every other slice and the stack slid 29 mm off. A spring that carries the weight stays a spring: held at the stop
    // whatever it pushed, a muscle car's rear tyres that landed on their stops off a 14 m/s jump stayed there, 11 cm down, for 2 s.
    if (SINK[c]! >= -SPECULATIVE_GAP) {
      weightClosing(c);
      reach(c, UP, N[c]!, q, false);
      if (ASK[c]! < _s[S_WEIGHT]! * _s[S_REACH]!) {
        SOFT[c] = false;
        GAPV[c] = -SINK[c]! / dt;
      }
    }
  }
  for (let c = 0; c < tyres; c++) {
    const s = SLOT[c]!;
    if (!SOFT[c] || s < 0) continue;
    let seen = false;
    for (let k = 0; k < c; k++) if (SOFT[k] && SLOT[k] === s) seen = true;
    if (seen) continue;
    let sum = 0;
    for (let k = c; k < tyres; k++) if (SOFT[k] && SLOT[k] === s) sum += ASK[k]!;
    if (sum === 0) continue;
    const share = surf.take(s, sum, G, dt) / sum;
    for (let k = c; k < tyres; k++) if (SOFT[k] && SLOT[k] === s) ASK[k] = ASK[k]! * share;
  }
  openRows(n);
  // Every tyre in its springs pushes before any rigid contact solves, so the list order of the tyres is not the order they act in: a
  // flat road's tyre listed before the face's soft one took an impulse the face's push then made unneeded (and never took back).
  for (let c = 0; c < tyres; c++) {
    if (!SOFT[c]) continue;
    if (OWN[c]! >= 0 && CLOSING[c]! < WALL_CRUSH) surf.press(OWN[c]!, ASK[c]!);
    _s[S_J] = ASK[c]!;
    _s[S_JD] = ASK[c]! - Math.min(ASK[c]!, REST[c]!);
    give(c, v, w, q, UP, surf);
  }
  // The tyres in their springs push straight up, so the world's face under them leaves the body its gravity along it, each tyre's share
  // by the weight it carries: it slows a car uphill and speeds it downhill. Before the passes, so a gripping tyre holds it in the slice.
  // Where the passes' grip holds the tyre (a car not driven: its tyres grip both ways), that push is the face's on the tread and acts
  // there, as the grip holding it does: pushed at the centre, the grip at the tread rolled the body, and a monster parked across a 10°
  // face rolled to 6.9° and crept back at 0.9°/s, its origin sinking 3.6 mm after its springs had settled. A driven car's drive owns
  // its travel along the ground, so its push stays at the centre.
  for (let c = 0; c < tyres; c++) {
    if (!rolling || !SOFT[c] || OWN[c]! >= 0) continue;
    if (driven) {
      v.x += ASK[c]! * N[c]!.y * N[c]!.x;
      v.z += ASK[c]! * N[c]!.y * N[c]!.z;
      continue;
    }
    const along = hypot2(N[c]!.x, N[c]!.z);
    if (along > 0) {
      _s[S_J] = ASK[c]! * N[c]!.y * along;
      push(v, w, q, R[c]!, _vp.set(N[c]!.x / along, 0, N[c]!.z / along));
    }
  }
  snapshotRows(car, n);
  solveRows(n);
  collectCrush(car, n);
  surf.commit();
  const hard = hardContactNear(tyres, n, body.nearing);
  standAtCentre();
  // What the body touches now: each wheel's tread gap moved by the lift. No wheel within its springs' reach and no hull point
  // in a surface is flight; a belly or a roof resting on something is not.
  const dy = pos.y - y0;
  let down = 0;
  for (let i = 0; i < 4; i++) {
    const o = i * HIT_SIZE + C_H;
    hit[o] = hit[o]! - dy;
    if (-hit[o]! <= within) down |= 1 << i;
  }
  car.wheelsDown = down;
  car.airborne = down === 0 && n === 0;
  car.hardTouch = hard || landing(hit, down, v);
  return worldWheels(car, down) >= 3;
}
