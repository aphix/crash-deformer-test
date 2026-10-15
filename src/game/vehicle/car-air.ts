import * as THREE from "three";
import type { DeformableCar } from "./car.ts";
import { activeGround, NO_FLOOR } from "../world/ground.ts";
import { C_AUX, C_H, C_NX, C_NY, C_NZ, C_OWNER, C_PX, C_PY, C_PZ, EDGE_HIT, edgeCross, HIT_SIZE, MU_TYRE, ridgeCross, solidTop, staticTop, topsTop, type Surface } from "../world/surfaces.ts";
import { MIN_SLIDE } from "../deform/constants.ts";
import { barrierSpeed, CRASH, hypot2, plasticEnergy } from "../deform/physics-util.ts";
import { droop, PAN, SPRINGS } from "./car-suspension.ts";
import { carClass } from "./vehicle-classes.ts";
import { G, COM_Y, INV_I, BELLY, POINT_X, POINT_Y, POINT_Z, BELLY_ABSENT, SEGS, CONTACTS, TOUCH, RESTITUTION, BOUNCE_V, WALL_CRUSH, CLIMB_NY, centreOfMass, _dq, _eul, UP, _up, _fd, YAW_HOLD, _x, _z, _vp, _tn, R, _lift, _s, S_J, S_JD, S_REACH, S_WEIGHT, S_PEN, S_POINT_REACH, N, DIR, TYRE, SOFT, HUB, SLOT, OWN, FOLLOW, SINK, PRESS, SHARE, ASK, ACC, FIRST, ROOM, DEMAND, SUMF, CLOSING, GAPV, SPECULATIVE_GAP, CLEAR_ROUND, PASSES, REST_PASSES, REST_SPEED, SOLVE_MOVE_G, LEFT, UNDER, HELD, RATIO, FRA, REST, DYN, RIMP, _lv, _lw, _vMove, _dvSolve, BX, BY, BZ, BRISE, BPATCH, UNREAD, MU, NOTED, CLOSE_FIRST, CRUSH_POINT, _crushPoint, _crushNormal, _crushBack, CAR_CENTRE, body, bindBody, moveBody, standAtCentre, placeBody, carrier, push, pointVel, give, reach, weightClosing, springPushes } from "./car-air-body.ts";
import { readBelly, bodyContact, crossedPlanFromSide, readPoints, loadPoints, beginContacts, _e, WX, WZ, wheelsAt, worldWheels, hardContactNear, landing } from "./car-air-points.ts";

/**
 * How a car meets the surfaces under it, one pass per slice: three or more wheels standing on the world fix the body to the rest
 * plane through their contact points (`stepPlane`); fewer leave a rigid box under gravity turning about its centre of mass
 * (`stepFree`: wheels, bumper, beltline, roof corners and belly meet what is under them through impulses with restitution and
 * friction). `DeformableCar.airborne` is derived from the same contacts: no wheel within its springs' reach and no hull point in a surface.
 */

/**
 * The rows' start of a solve, for the body `bindBody` set: each row's impulse, dynamic impulse, rest impulse and held friction cleared,
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
    if (SOFT[c]) REST[c] = SHARE[c]! * G * dt;
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

/** The row's world point, for `standsOnGround`. */
const _row = new THREE.Vector3();
/** A floor that is the world's ground is this close (m) to what the ground's own height reads at the row: the same surface, to its rounding. */
const GROUND_MATCH = 1e-6;

/**
 * Whether row `c` (a body point, not a tyre) is in the world's ground itself, not in a solid, a car's top or a wall: the ground has
 * no side to enter by, so a wreck's point in it is lifted out whatever carried it there. A crush that pushes a sill or a fender
 * down moves the cage's points with no speed of the rigid body's, so such a point closes on nothing and the lift that takes out a
 * landing's depth never saw it: wrecks rested 4-19 cm in the road on their own crushed underside.
 */
function standsOnGround(c: number): boolean {
  if (TYRE[c] || SOFT[c] || OWN[c]! >= 0 || N[c]!.y < CLIMB_NY || SINK[c]! <= 0) return false;
  _row.copy(centreOfMass).add(R[c]!);
  const floor = _row.y + SINK[c]! / N[c]!.y;
  return Math.abs(activeGround().heightAt(_row.x, _row.z, _row.y) - floor) < GROUND_MATCH;
}

/**
 * The Gauss-Seidel solve of `n` rows, then the lift out: `PASSES` (`REST_PASSES` at rest) passes at each row's lever (`reach`), a closing contact taking what
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
  // A body at rest solves over more passes: its friction is rebuilt from 0 every slice and the residual slide integrates (a wreck at rest then sleeps, `integrateWreck`).
  const passes = !part && v.lengthSq() < REST_SPEED * REST_SPEED && w.lengthSq() < REST_SPEED * REST_SPEED ? REST_PASSES : PASSES;
  for (let pass = 0; pass < passes; pass++) {
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
      if (slide < MIN_SLIDE) continue;
      // Friction holds what the contact carries over the passes: its normal impulse after a yielding face's cut (a tyre in its springs:
      // its push). Bounded by each pass's push instead, a sedan's belly rows on a roof whose budget its tyres had spent gripped at 0.6 of
      // impulses the cut then took back, and the sedan under took that grip as a 4 rad/s roll.
      // The car under takes the grip as it takes the weight (`bear`, after its move): taken at once, it moved by it before its own
      // contacts held it, and a stack held by its grip walked 0.5 F dt every second (2-4 mm/s at the slice's 1.75 ms).
      _tn.copy(_vp).divideScalar(-slide);
      reach(c, _tn, _tn, q, false);
      _fd.copy(FRA[c]!).addScaledVector(_tn, slide * _s[S_REACH]!);
      // A wreck's dragged tyre (a dead drivetrain, locked) rubs at Coulomb μ `CRASH.muSlide`, as the ground slide's tyres do.
      const mu = TYRE[c] && body.wreck && parked ? CRASH.muSlide : MU[c]!;
      // A contact's give-backs over the passes can leave what it carries a rounding error below zero (-2.6e-18): its bound is then nil,
      // not negative, or the bound turned the held grip around and a grip of 0 against it divided by 0 (NaN through a stack of sedans).
      const cap = mu * Math.max(0, SOFT[c] ? jn : ACC[c]!);
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
    if (body.wreck && !part && standsOnGround(c)) LEFT[c] = SINK[c]! - 0.5 * dt * _dvSolve.dot(N[c]!);
    else if (UNDER[c]) under = Math.max(under, Math.min(SINK[c]!, CLOSING[c]! < BOUNCE_V ? CLOSING[c]! * dt : 0));
    else if (s >= 0 && surf.isYielding(s)) {
      if (!SOFT[c]) surf.note(s, SINK[c]!, FOLLOW[c]!);
    } else if (part || HUB[c] || CLOSING[c]! > 0) {
      // A driven car's tyres climb what it drives onto (a step, a kerb: the lift is how the body mounts it). Any other body (a wreck, a
      // part) lands on a face only from within the slice's reach: a point already deeper than its closing carried it in was inside before
      // this slice, so the stop holds it and the lift does not set the body up on a top it did not land on (a wreck's cage edge 7 cm
      // inside a ramp's end was lifted 7.9 cm onto it).
      const left = SINK[c]! - 0.5 * dt * _dvSolve.dot(N[c]!);
      if (part || (driven && !body.wreck) || HUB[c] || left - CLOSING[c]! * dt <= SPECULATIVE_GAP) LEFT[c] = left;
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
 * The hit each of `car`'s rows against another car met this slice: the crush energy is the kernel's plastic exchange of the closing
 * it first met (`plasticEnergy`, read as `bodyContact` reads an approach: what the pair has to give, whatever the rows' own impulses
 * and the faces' cuts then made of it), split between the two cars at the pair's masses (`barrierSpeed`). One hit per car pair, at
 * the point and along the normal of the row that closed hardest. A contact closing no faster than the crush law's graze
 * (`CRASH.grazeMps`) crushes nothing, so a car standing or driving on another arms none.
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
  car.deform.shiftBody(car.velocity, car.angular, _postV.x - PENDING[pre]!, _postV.z - PENDING[pre + 2]!, _postW.y - PENDING[pre + 4]!, _centre.x, _centre.z, inward.x, inward.z, common);
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
    a.deform.markMotion();
    a.deform.feedOverlap(_crushPoint, _crushNormal, fed, closing, dt, common);
    a.deform.takeMotion(a.velocity, a.angular);
    a.deform.notifyContact();
    if (b === null) continue;
    b.deform.markMotion();
    b.deform.feedOverlap(_crushPoint, _crushBack, fed, closing, dt, -common);
    b.deform.takeMotion(b.velocity, b.angular);
    b.deform.notifyContact();
  }
  queue.size = 0;
}

const _wreckCentre = new THREE.Vector3();
export const wreckInvI = new THREE.Vector3();

/**
 * A wreck's rigid body is its masses': its centre of mass is their centroid (frame coordinates, `_wreckCentre`; `velocity` is the
 * masses' mean, so the body must turn about it) and its inverse yaw inertia per unit mass their spread about it (`_wreckInvI`, the
 * rest the car box's). Returns the centre.
 */
export function wreckCentre(car: Pick<DeformableCar, "deform">): THREE.Vector3 {
  const ms = car.deform.masses;
  let m = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const n of ms) {
    if (!n.dynamic) continue;
    m += n.mass;
    cx += n.local.x * n.mass;
    cy += n.local.y * n.mass;
    cz += n.local.z * n.mass;
  }
  if (m < 1e-8) {
    wreckInvI.copy(INV_I);
    return _wreckCentre.copy(CAR_CENTRE);
  }
  cx /= m;
  cz /= m;
  let inertia = 0;
  for (const n of ms) if (n.dynamic) inertia += n.mass * ((n.local.x - cx) ** 2 + (n.local.z - cz) ** 2);
  wreckInvI.set(INV_I.x, inertia > 1e-9 ? m / inertia : INV_I.y, INV_I.z);
  return _wreckCentre.set(cx, cy / m, cz);
}

/**
 * The static surface's highest over a box holding every loaded point's slice travel, the points armed about the body's own centre as
 * `armOf` arms them (a wreck's: its masses'), each moving at most the body's plan speed plus its turn at the farthest point. The raster's
 * answer (`staticTop` cells only) never falls as the box grows, so a point above it by its descent is clear by its own read too.
 */
function centredTop(statics: Surface, turnRate: number, dt: number, pointEnd: number): number {
  const { v } = body;
  const c = body.centre;
  let xMin = Infinity;
  let xMax = -Infinity;
  let zMin = Infinity;
  let zMax = -Infinity;
  let reach2 = 0;
  for (let i = 0; i < pointEnd; i++) {
    const x = POINT_X[i]! - c.x;
    const y = POINT_Y[i]! - c.y;
    const z = POINT_Z[i]! - c.z;
    const rx = _e[0]! * x + _e[3]! * y + _e[6]! * z;
    const rz = _e[2]! * x + _e[5]! * y + _e[8]! * z;
    xMin = Math.min(xMin, rx);
    xMax = Math.max(xMax, rx);
    zMin = Math.min(zMin, rz);
    zMax = Math.max(zMax, rz);
    reach2 = Math.max(reach2, x * x + y * y + z * z);
  }
  const pad = (hypot2(v.x, v.z) + turnRate * Math.sqrt(reach2)) * dt + CLEAR_ROUND;
  const x0 = centreOfMass.x + xMin - pad;
  const x1 = centreOfMass.x + xMax + pad;
  const z0 = centreOfMass.z + zMin - pad;
  const z1 = centreOfMass.z + zMax + pad;
  return Math.max(staticTop(statics, x0, x1, z0, z1, true), solidTop(x0, x1, z0, z1));
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
  const wreck = car.deform.massActive;
  bindBody(car.group, v, w, wreck ? wreckCentre(car) : CAR_CENTRE, wreck ? wreckInvI : INV_I, car.slot, false, dt);
  body.wreck = car.deform.massActive;
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
  const stop = spring;
  // A driven car with a wheel on a surface, the world's ground or another car's top alike, rolls on it: the drive owns its travel along
  // the road, so the world's faces neither drag it nor grip its tyres along their tread (a rear tyre meeting a ramp's toe at 30° with the
  // front in the air turned its travel 2-3° through the face's slope and the tyre's friction against the body's spin).
  // A wreck's tyres are the same rows: a crashed car whose drivetrain lives is a dented car and rolls on its drive's law (the throttle's
  // push, else its coast, the brakes when held); one with no drive to give (the drivetrain dead, or the engine cut by a side hit, which
  // `applyDrive` treats the same) is wrecked running gear, its wheels dragged (they rub in every direction, as a parked car's do).
  const driving = !wreck || (car.deform.drivetrainAlive && car.stalledS <= 0);
  const rolling = wheelsAt(car, within) !== 0 && (wreck || !car.crashed);
  const driven = rolling && !car.parked && driving;
  const hit = car.wheelHit;
  body.driven = driven;
  body.parked = car.parked || !driving;
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
    if (wreck && own >= 0 && surf.cars[own]!.deform.massActive) continue;
    R[n]!.set(hit[o + C_PX]! - centreOfMass.x, hit[o + C_PY]! - centreOfMass.y, hit[o + C_PZ]! - centreOfMass.z);
    N[n]!.set(hit[o + C_NX]!, hit[o + C_NY]!, hit[o + C_NZ]!);
    TYRE[n] = true;
    HUB[n] = false;
    MU[n] = MU_TYRE;
    OWN[n] = own;
    DIR[n] = N[n]!.y >= CLIMB_NY ? UP : N[n]!;
    UNDER[n] = false;
    FOLLOW[n] = own >= 0 ? hit[o + C_AUX]! : 1;
    SLOT[n] = surf.slot(own, N[n]!, false, q, FOLLOW[n]!);
    // How far past what holds it the point is: a tyre's springs and their full travel.
    const sink = pen * N[n]!.y - stop;
    SOFT[n] = sink < 0;
    GAPV[n] = 0;
    SINK[n] = sink;
    PRESS[n] = pen;
    SHARE[n] = 0.25 * (1 + body.centre.x / WX[i]!) * (1 + body.centre.z / WZ[i]!);
    carrier(surf, n, own, mass);
    CLOSING[n] = Math.max(0, -pointVel(n, v, w, _vp).dot(N[n]!));
    if (own >= 0 && CLOSING[n]! < WALL_CRUSH) surf.touch(own);
    n++;
  }
  const tyres = n;
  // A point that stays higher than the static surface anywhere within its slice's plan travel, by its descent over the slice and a
  // speculative gap, neither meets nor nears it: no reading. Near a car top each body point is held to the solids and that top too.
  const statics = activeGround();
  const speed = v.length();
  const turnRate = w.length();
  const bellyFrom = loadPoints(car);
  const pointEnd = bellyFrom + BELLY.length;
  const pointReach = _s[S_POINT_REACH]!;
  const bodyReach = pointReach + (speed + turnRate * pointReach) * dt;
  const readAll = topsTop(car.slot, centreOfMass.x - bodyReach, centreOfMass.x + bodyReach, centreOfMass.z - bodyReach, centreOfMass.z + bodyReach) > -Infinity;
  // Every point's slice travel lies within this of the centre of mass: its reach about the body's own centre is at most the stock reach
  // plus that centre's offset from the car's (`readPoints` reads the solids over that square once, if a point needs them).
  const c = body.centre;
  const shiftedReach = pointReach + Math.abs(c.x - CAR_CENTRE.x) + Math.abs(c.y - CAR_CENTRE.y) + Math.abs(c.z - CAR_CENTRE.z);
  const solidReach = shiftedReach + (speed + turnRate * shiftedReach) * dt + CLEAR_ROUND;
  // The whole body at once first: each point's box below and each belly segment's lies within the points' boxes together, so a raster
  // under all of them lower than the lowest point's clearance clears every point and segment in one read (measured: 84 % of the slices
  // of a 32-car race at aggression 1, 93 % at 0). The points come off the body's axes (`_e`, `wheelsAt` set it from `q`), each moving at
  // most the body's plan speed (fall) plus its turn at the farthest point, and `CLEAR_ROUND` covers these axes' rounding against
  // `armOf`'s: a bound on every point's own test, so it clears only what that would.
  let allClear = false;
  // Each point's own read is bounded by `centredTop`: the box above for a car, about its masses' centre for a wreck.
  let bodyTop = Infinity;
  if (!readAll) {
    const turn = turnRate * _s[S_POINT_REACH]!;
    const pad = (hypot2(v.x, v.z) + turn) * dt + CLEAR_ROUND;
    let xMin = Infinity;
    let xMax = -Infinity;
    let zMin = Infinity;
    let zMax = -Infinity;
    let low = Infinity;
    for (let i = 0; i < pointEnd; i++) {
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
    const x0 = centreOfMass.x + xMin - pad;
    const x1 = centreOfMass.x + xMax + pad;
    const z0 = centreOfMass.z + zMin - pad;
    const z1 = centreOfMass.z + zMax + pad;
    const top = Math.max(staticTop(statics, x0, x1, z0, z1, true), solidTop(x0, x1, z0, z1));
    allClear = top < centreOfMass.y + low - descent;
    bodyTop = allClear || body.centre === CAR_CENTRE ? top : centredTop(statics, turnRate, dt, pointEnd);
  }
  n = readPoints(allClear ? pointEnd : 0, pointEnd, bellyFrom, n, true, bodyTop, readAll, solidReach, solidReach - shiftedReach);
  // Between two belly points on different patches the belly meets that edge where it crosses (`edgeCross`, the tyres' rule): a car
  // dropped level across a ramp's crest balanced on the row in front of it, the crest 17 cm inside the belly half a metre behind.
  // Over one car's top (one patch) the pan's lines rest on the top's ridge between their points where that stands above both
  // (`ridgeCross`), pressed along the belly's own normal, not the windscreen's: a sedan on another's roof, its middle row on the roof and
  // its front row past the roof's front edge, tipped 10° nose-down onto the windscreen with its centre still 25 cm behind that edge.
  _up.set(0, 1, 0).applyQuaternion(q);
  const panFrom = bellyFrom + BELLY.length - PAN.length;
  for (let s = allClear ? SEGS.length : 0; s < SEGS.length; s += 2) {
    if (BELLY_ABSENT[SEGS[s]!] === 1 || BELLY_ABSENT[SEGS[s + 1]!] === 1) continue;
    let a = bellyFrom + SEGS[s]!;
    let b = bellyFrom + SEGS[s + 1]!;
    // Both ends unread and the static surface under the segment lower than its lower end: the segment meets nothing.
    if (UNREAD[a] === 1 && UNREAD[b] === 1) {
      const xMin = Math.min(BX[a]!, BX[b]!);
      const xMax = Math.max(BX[a]!, BX[b]!);
      const zMin = Math.min(BZ[a]!, BZ[b]!);
      const zMax = Math.max(BZ[a]!, BZ[b]!);
      if (Math.max(staticTop(statics, xMin, xMax, zMin, zMax), solidTop(xMin, xMax, zMin, zMax)) < Math.min(BY[a]!, BY[b]!)) continue;
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
    if (!body.part && EDGE_HIT[C_OWNER]! >= 0 && ((body.wreck && body.surf.cars[EDGE_HIT[C_OWNER]!]!.deform.massActive) || crossedPlanFromSide(EDGE_HIT, pen, R[n]!))) continue;
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
  // What the body touches now: each wheel's tread gap moved by the lift.
  // No wheel within its springs' reach and no hull point in a surface is flight; a belly or a roof resting on something is not.
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
  car.contacts = n;
  return worldWheels(car, down) >= 3;
}
