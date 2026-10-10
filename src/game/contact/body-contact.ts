/**
 * The one momentum exchange of the sim's contact (docs/UNIFIED_CONTACT.md, stage 4): two bodies touch at a point, each a
 * rigid body in plan (a mass, a yaw inertia, a centre, a velocity, a yaw rate), and what they do to each other at that
 * point is one answer whoever they are: a car and a car, a car and a press plate, a piston head, a door ram or a wall (a
 * kinematic body: mass and inertia `Infinity`, it never changes speed).
 *
 * It replaces every place a hit changed a speed: a push along the line of centres through no lever (`impulseCar`,
 * `stopClosing`, `cancelClosing`, the tyres' stop), each its own idea of mass and none of them a torque. The impulse here
 * acts on the contact point's own relative velocity with the pair's effective mass at that point,
 *   1/m_eff = 1/mA + 1/mB + (rA x n)² / IA + (rB x n)² / IB,
 * so a car struck 1.65 m behind its centre spins (omega = j·r / I) and takes less of the closing speed than the same car
 * struck through its centre, as a rigid body does.
 *
 * Plain function over typed arrays (no allocation, no `this`): bodies are rows of one array (`BODY_SIZE` apart), the
 * contact and the result are rows of two more. The caller owns what the numbers mean for its body (a car's masses carry
 * the velocity change `(dv, dw)` as a rigid increment on top of their own motion) and what the energy does (crush).
 */
import { barrierSpeed, plasticEnergy } from "../deform/physics-util.ts";

/** A body's row: mass (kg, `Infinity` kinematic), yaw inertia about its centre (kg m², `Infinity` kinematic), centre (m), velocity (m/s), yaw rate (rad/s about +y), face hardness. */
export const BODY_M = 0;
export const BODY_I = 1;
export const BODY_X = 2;
export const BODY_Z = 3;
export const BODY_VX = 4;
export const BODY_VZ = 5;
export const BODY_W = 6;
/**
 * Hardness of the face this body presents to its partner (docs/CONTACT_PARITY.md): the share of the exchange's crush energy the
 * partner's structure takes, 1 for a car (or a rigid steel face), less for a face that crushes too (a piston's honeycomb 0.5).
 */
export const BODY_HARD = 7;
export const BODY_SIZE = 8;

/**
 * A contact's row: the point (m), the unit normal out of B into A (A's way off B), the penetration (m, 0 for none), the
 * restitution (0 plastic: the cars leave together), the Coulomb friction, and the most normal impulse (N·s) this call may
 * give, which is the crush force times the slice: `Infinity` where the contact does not yield (tyres, a packed structure).
 */
export const CT_X = 0;
export const CT_Z = 1;
export const CT_NX = 2;
export const CT_NZ = 3;
export const CT_DEPTH = 4;
export const CT_E = 5;
export const CT_MU = 6;
export const CT_JMAX = 7;
export const CT_SIZE = 8;

/**
 * A result's row (read it before the next call): the normal impulse on A along the normal (B gets the opposite), the
 * tangential one on A along (-nz, nx), the approach speed of A's point on B's before the impulse (m/s), the effective mass
 * (kg), the crush energy this impulse took out of the pair (J, normal part only: friction is heat), the energy a full
 * plastic exchange of this approach would take (J), each side's equivalent barrier speed for that energy (m/s: the speed it
 * would take hitting a rigid wall to crush as much), and how far each side moves out along the normal to clear the penetration
 * (m, the share of the depth in inverse proportion to mass).
 */
export const OUT_J = 0;
export const OUT_JT = 1;
export const OUT_CLOSING = 2;
export const OUT_MEFF = 3;
export const OUT_CRUSH_J = 4;
export const OUT_PLASTIC_J = 5;
export const OUT_EBS_A = 6;
export const OUT_EBS_B = 7;
export const OUT_PUSH_A = 8;
export const OUT_PUSH_B = 9;
export const OUT_SIZE = 10;

/**
 * Exchange momentum between body rows `a` and `b` (offsets into `rows`) at the contact `ct`: the normal impulse that closes
 * the approach of the two bodies' points (`(1 + e)` of it, capped by `CT_JMAX`), then Coulomb friction on the sliding of the
 * points, both applied to the rows' velocities and yaw rates, the result into `out`. Returns the normal impulse (N·s). A pair
 * that is already separating at the point, or a pair of kinematic bodies, exchange nothing.
 */
export function bodyContact(rows: Float64Array, a: number, b: number, ct: Float64Array, out: Float64Array): number {
  const nx = ct[CT_NX]!;
  const nz = ct[CT_NZ]!;
  const rax = ct[CT_X]! - rows[a + BODY_X]!;
  const raz = ct[CT_Z]! - rows[a + BODY_Z]!;
  const rbx = ct[CT_X]! - rows[b + BODY_X]!;
  const rbz = ct[CT_Z]! - rows[b + BODY_Z]!;
  // 1/Infinity is 0: a kinematic body has no inverse mass and no inverse inertia.
  const ima = 1 / rows[a + BODY_M]!;
  const imb = 1 / rows[b + BODY_M]!;
  const iia = 1 / rows[a + BODY_I]!;
  const iib = 1 / rows[b + BODY_I]!;
  // Lever of the normal about each centre, (r x n)_y = rz·nx - rx·nz.
  const cna = raz * nx - rax * nz;
  const cnb = rbz * nx - rbx * nz;
  const k = ima + imb + cna * cna * iia + cnb * cnb * iib;
  // A point's velocity is its body's plus omega x r = (w·rz, -w·rx).
  const wa = rows[a + BODY_W]!;
  const wb = rows[b + BODY_W]!;
  const rvx = rows[a + BODY_VX]! + wa * raz - (rows[b + BODY_VX]! + wb * rbz);
  const rvz = rows[a + BODY_VZ]! - wa * rax - (rows[b + BODY_VZ]! - wb * rbx);
  const closing = -(rvx * nx + rvz * nz);
  out.fill(0);
  out[OUT_CLOSING] = closing;
  if (k <= 0) return 0;
  const meff = 1 / k;
  out[OUT_MEFF] = meff;
  const depth = ct[CT_DEPTH]!;
  if (depth > 0) {
    const w = ima + imb;
    out[OUT_PUSH_A] = (depth * ima) / w;
    out[OUT_PUSH_B] = (depth * imb) / w;
  }
  // Crush energy of a full plastic exchange, E = ½·meff·closing². Each side's own share is the energy of its own velocity change
  // (½·j²·(1/m + lever²/I), which sums to E over the pair): equal cars take half each, a hit through the centres gives each the
  // `closing·M/(m+M)` barrier speed of the calibration, a hit off a car's centre loads the car it is further from the centre of
  // more. The partner's face hardness scales what a side takes.
  const plastic = plasticEnergy(closing, meff);
  out[OUT_PLASTIC_J] = plastic;
  const mobA = ima + cna * cna * iia;
  const mobB = imb + cnb * cnb * iib;
  out[OUT_EBS_A] = barrierSpeed(plastic, mobA, ima, rows[b + BODY_HARD]!, k);
  out[OUT_EBS_B] = barrierSpeed(plastic, mobB, imb, rows[a + BODY_HARD]!, k);
  if (closing <= 0) return 0;
  const j = Math.min(((1 + ct[CT_E]!) * closing) / k, ct[CT_JMAX]!);
  out[OUT_J] = j;
  out[OUT_CRUSH_J] = j * (closing - 0.5 * j * k);
  rows[a + BODY_VX] = rows[a + BODY_VX]! + ima * j * nx;
  rows[a + BODY_VZ] = rows[a + BODY_VZ]! + ima * j * nz;
  rows[a + BODY_W] = wa + iia * j * cna;
  rows[b + BODY_VX] = rows[b + BODY_VX]! - imb * j * nx;
  rows[b + BODY_VZ] = rows[b + BODY_VZ]! - imb * j * nz;
  rows[b + BODY_W] = wb - iib * j * cnb;
  const mu = ct[CT_MU]!;
  if (mu <= 0) return j;
  // Friction on what the normal impulse left of the points' sliding, along t = (-nz, nx).
  const tx = -nz;
  const tz = nx;
  const wa2 = rows[a + BODY_W]!;
  const wb2 = rows[b + BODY_W]!;
  const vt = (rows[a + BODY_VX]! + wa2 * raz - (rows[b + BODY_VX]! + wb2 * rbz)) * tx + (rows[a + BODY_VZ]! - wa2 * rax - (rows[b + BODY_VZ]! - wb2 * rbx)) * tz;
  const cta = raz * tx - rax * tz;
  const ctb = rbz * tx - rbx * tz;
  const kt = ima + imb + cta * cta * iia + ctb * ctb * iib;
  const lim = mu * j;
  const jt = Math.max(-lim, Math.min(lim, -vt / kt));
  out[OUT_JT] = jt;
  rows[a + BODY_VX] = rows[a + BODY_VX]! + ima * jt * tx;
  rows[a + BODY_VZ] = rows[a + BODY_VZ]! + ima * jt * tz;
  rows[a + BODY_W] = wa2 + iia * jt * cta;
  rows[b + BODY_VX] = rows[b + BODY_VX]! - imb * jt * tx;
  rows[b + BODY_VZ] = rows[b + BODY_VZ]! - imb * jt * tz;
  rows[b + BODY_W] = wb2 - iib * jt * ctb;
  return j;
}
