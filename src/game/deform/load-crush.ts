/**
 * Load crush: a car's faces yield under sustained load, not only under impact impulse. Each face of the body box
 * (roof, nose, tail, left, right) has a strength law, the force it carries at a crush depth `d`:
 * `W · (y0 + k·d + q·d²)` in car weights `W = m·g`. A rigid contact on a face (the ground, another car's roof) can push
 * no harder than that; the shortfall is the body sinking into the face, and the depth it reaches stays (`stepFree`
 * caps the contact impulse at `faceStrength` and turns the penetration it lets through into depth). A car resting on its
 * roof, a stack of cars on the roof under it, a nose or a flank landing all run the one rule. At rest the depth is
 * where the law gives the load: `d = (L − y0) / k` for L car weights.
 *
 * - **roof**: FMVSS 216 (roof strength) asks a roof to carry 3 × the car's weight within 127 mm of platen crush.
 *   `0.5 + 15·d + 45·d²` gives 3.13 W at 127 mm; one car's weight settles at 31 mm, two at 81 mm, three at 122 mm,
 *   four at 158 mm. Packed (rigid) at 0.45 m, the cabin's height under the roof cage.
 * - **nose**: the calibrated frontal stroke (docs/CRUSH_CALIBRATION.md): 56 km/h into a wall, 0.37 m, is 104 kJ at 860 kg, a
 *   mean 33 W over the stroke; `15 + 97·d` gives that mean (15 + 97·0.185 = 33). Packed at 0.55 m (the rig's front `maxCrush`).
 * - **tail**: the same yield with the shorter, stiffer rear stroke (`maxCrush` 0.38 m): `15 + 150·d`.
 * - **flanks**: yield 8 W, 160 W/m, packed at 0.30 m (the door band: 0.12-0.28 m at 50 km/h, docs/CRUSH_CALIBRATION.md).
 */

import { CAGES, MASS_SPECS } from "../kernel/rig-spec.ts";

export const FACE_TOP = 0;
export const FACE_NOSE = 1;
export const FACE_TAIL = 2;
export const FACE_LEFT = 3;
export const FACE_RIGHT = 4;
export const FACES = 5;

/**
 * Strain share (β) of the cluster map a skin point's offset from its parent masses takes; the rotation is taken whole. At 1 the strain
 * between the particles extrapolates past them: paint 0.1 m outboard of a pushed door went 8% deeper than the door (piston `right`), at
 * 0.65 within 1%. It is also how far the drawn body follows a face's crush: the roof the cage draws sinks this share of the roof mass's
 * travel (measured 0.648 at the crown, 0.05 to 0.45 m of crush), so a contact on the drawn roof books `crush = penetration / (this × faceFollow)`.
 */
export const SKIN_STRAIN = 0.65;

/** The roof's crush follows the masses from the bonnet's top (m, rig frame) up to the roof mass's rest height; below it the body stands. */
const TOP_BAND_FROM = CAGES.find((cage) => cage.name === "bonnet")!.max[1];
const TOP_BAND_LENGTH = MASS_SPECS.find((spec) => spec.name === "roof")!.rest[1] - TOP_BAND_FROM;

/** Each face's outward unit axis (car-local x, y, z). */
export const FACE_AXIS = new Float64Array([0, 1, 0, 0, 0, 1, 0, 0, -1, -1, 0, 0, 1, 0, 0]);

/** Yield force (car weights), its hardening per metre and per metre² of crush, and the depth (m) where the face is packed. */
const Y0 = new Float64Array([0.5, 15, 15, 8, 8]);
const K = new Float64Array([15, 97, 150, 160, 160]);
const Q = new Float64Array([45, 0, 0, 0, 0]);
const MAX = new Float64Array([0.45, 0.55, 0.38, 0.3, 0.3]);

/** Crush depth (m) at which face `face` is packed. */
export function faceMax(face: number): number {
  return MAX[face]!;
}

/**
 * A pressed roof takes the shape of what pressed it (plastic, it stays): `DeformRig.imprint` holds that plane in the car's body frame
 * at its stock ride, uncrushed (height at the origin, rise per metre along x and along z), and the drawn skin and the top another car
 * stands on are both cut down to it as the roof sinks. This height (m) is over any car's top (and within the net's fine 16-bit range):
 * no imprint.
 */
export const IMPRINT_NONE = 3;

/** The force (in car weights) face `face` carries at crush depth `d` (m); `Infinity` once it is packed. */
export function faceStrength(face: number, d: number): number {
  return d >= MAX[face]! ? Infinity : Y0[face]! + (K[face]! + Q[face]! * d) * d;
}

/**
 * How far a body point at rest (car-local x, y, z) follows face `face` as it crushes: 1 on the face itself, 0 away
 * from it. Hubs are tyres and never crush. The roof's crush sinks the roof band only (from the bonnet's top to the roof mass: the
 * hood, the boot and the cabin below stand where the drawn body stands), so the drawn roof is the roof mass.
 */
export function faceFollow(face: number, x: number, y: number, z: number): number {
  const t = face === FACE_TOP ? (y - TOP_BAND_FROM) / TOP_BAND_LENGTH : face === FACE_NOSE ? (z - 0.7) / 1.36 : face === FACE_TAIL ? (-z - 0.7) / 1.36 : face === FACE_LEFT ? (-x - 0.4) / 0.4 : face === FACE_RIGHT ? (x - 0.4) / 0.4 : 0;
  const s = Math.max(0, Math.min(1, t));
  return s * s * (3 - 2 * s);
}
