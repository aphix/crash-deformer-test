import { NO_FLOOR, type Ground } from "../world/ground.ts";
import { WHEEL_POS } from "./car-mesh.ts";
import { HULL_UNDER } from "./car-suspension.ts";

/**
 * What a driven car's ground pose (its tyre plane under the body's middle: height, slope along it and across it,
 * `DeformableCar.integrate`) gets wrong, and the pose that holds. The ground sim stands the body on the ground under its
 * middle (on its axle chord across a hollow) with that point's slope. That is exact on a road, and where it is not (a
 * ramp's side edge between the wheels, a dip's far wall under the bumper, a bank's crease under a rocker) it lets the
 * ground through the hull or leaves a tyre hanging while the body balances on a ridge. This reads the four tyre contacts
 * and the underside and bumpers through the one `Ground.heightAt` door, each asked at its own height as every other
 * ground query is, and where the ground pose has a tyre or the hull under the ground, or one wheel of an axle on the
 * ground and its partner hanging, it blends toward the plane that rests there: the least-squares plane of the tyre
 * contacts, pushed up out of every contact the way a rigid box with the car's inertia is (a corner lifts and tilts it, a
 * point on the middle lifts it), so the car sits on the feature it bottoms out on and its other tyres hang. Where the
 * ground pose is right it is returned untouched.
 */

/** A ground pose: the plane's height (m) under the body's origin, its rise per metre along the heading (`a`) and toward the car's +x side (`b`). */
type Plane = { y: number; a: number; b: number };

/** Samples (tyre contacts first, then the underside points and bumper corners): car-local x, z and height above the tyre plane (m). */
const SAMPLES: readonly (readonly [number, number, number])[] = [...WHEEL_POS.map(([x, , z]): [number, number, number] => [x, z, 0]), ...HULL_UNDER];
const N = SAMPLES.length;
const LX = Float64Array.from(SAMPLES, (s) => s[0]);
const LZ = Float64Array.from(SAMPLES, (s) => s[1]);
const LH = Float64Array.from(SAMPLES, (s) => s[2]);
/** A hull point or tyre this far (m) under its ground starts the blend and this far (m) puts the car fully on the solved plane. */
const SINK = [0.01, 0.03] as const;
/** A tyre on its ground while another hangs this far (m) above its own starts it and this far (m) completes it. */
const HANG = [0.03, 0.06] as const;
/** A tyre within this (m) of its ground counts as on it. */
const ON = 0.01;

/** Per sample: plan offset from the body origin along the heading and across it (m), and the plane height it must reach. */
const U = new Float64Array(N);
const W = new Float64Array(N);
const H = new Float64Array(N);
/** The samples that have a ground. */
const IDX = new Int32Array(N);
/** A car-local point turned by yaw, pitch and roll (YXZ): plan x, height, plan z. */
const D = new Float64Array(3);

function turn(sy: number, cy: number, sp: number, cp: number, sr: number, cr: number, lx: number, ly: number, lz: number): void {
  const x1 = lx * cr - ly * sr;
  const y1 = lx * sr + ly * cr;
  const z2 = y1 * sp + lz * cp;
  D[0] = x1 * cy + z2 * sy;
  D[1] = y1 * cp - lz * sp;
  D[2] = -x1 * sy + z2 * cy;
}

function smooth(v: number, [lo, hi]: readonly [number, number]): number {
  const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

/**
 * The ground pose `at` of a body whose origin is at plan (x, z) and `hint` high, facing `yaw`, tilted `pitch` and `roll`
 * (the tilt it last had: it only places the samples), its body lifted `lift` m over the tyre plane, corrected into
 * `out` by up to `crawl` (0..1). Returns the weight of the correction (0: `at` holds and `out` is left alone, 1: the
 * rest plane).
 */
function correct(g: Ground, x: number, z: number, hint: number, yaw: number, pitch: number, roll: number, lift: number, crawl: number, at: Plane, out: Plane): number {
  const sy = Math.sin(yaw);
  const cy = Math.cos(yaw);
  const sp = Math.sin(pitch);
  const cp = Math.cos(pitch);
  const sr = Math.sin(roll);
  const cr = Math.cos(roll);
  turn(sy, cy, sp, cp, sr, cr, 0, 1, 0);
  const upX = D[0]!;
  const upY = D[1]!;
  const upZ = D[2]!;
  let c = 0;
  let sink = 0;
  for (let i = 0; i < N; i++) {
    const wheel = i < 4;
    const h = wheel ? 0 : LH[i]! + lift;
    turn(sy, cy, sp, cp, sr, cr, LX[i]!, 0, LZ[i]!);
    U[i] = D[0]! * sy + D[2]! * cy;
    W[i] = D[0]! * cy - D[2]! * sy;
    // Asked from the tyre plane's height at the sample, as a tyre there would: a face a kerb above it is a wall (the
    // fleet ramps' side), which pushes the car sideways (`contact`), not ground to climb onto with the hull.
    const gh = g.heightAt(x + D[0]! + h * upX, z + D[2]! + h * upZ, hint + D[1]!);
    if (gh === NO_FLOOR) {
      H[i] = NO_FLOOR;
      continue;
    }
    H[i] = gh - h * upY;
    sink = Math.max(sink, H[i]! - (at.y + at.a * U[i]! + at.b * W[i]!));
    if (wheel) c++;
  }
  if (c === 0) return 0;
  // A tyre on the ground while another hangs: a twist or a ridge between them the ground pose's middle sample cannot see.
  let hang = 0;
  let low = Infinity;
  for (let i = 0; i < 4; i++) {
    if (H[i] === NO_FLOOR) continue;
    const r = at.y + at.a * U[i]! + at.b * W[i]! - H[i]!;
    low = Math.min(low, r);
    hang = Math.max(hang, r);
  }
  if (low >= ON) hang = 0;
  const w = crawl * Math.max(smooth(sink, SINK), smooth(hang, HANG));
  if (w === 0) return 0;
  // The rest plane: the lowest the body's middle can stand with every sample above its ground, the plane through the
  // three samples that hold it up (the middle inside their triangle: a rest that stays): two tyres and the belly on a
  // ramp's edge, or three tyres with the fourth hanging. Brute force over triples, only for a car that has gone wrong.
  let m = 0;
  for (let i = 0; i < N; i++) if (H[i] !== NO_FLOOR) IDX[m++] = i;
  let best = Infinity;
  let a = 0;
  let b = 0;
  for (let p = 0; p < m - 2; p++) {
    const i = IDX[p]!;
    for (let q = p + 1; q < m - 1; q++) {
      const j = IDX[q]!;
      const du1 = U[j]! - U[i]!;
      const dw1 = W[j]! - W[i]!;
      const dh1 = H[j]! - H[i]!;
      for (let r = q + 1; r < m; r++) {
        const k = IDX[r]!;
        const du2 = U[k]! - U[i]!;
        const dw2 = W[k]! - W[i]!;
        const det = du1 * dw2 - du2 * dw1;
        if (Math.abs(det) < 1e-3) continue;
        const dh2 = H[k]! - H[i]!;
        const pa = (dh1 * dw2 - dh2 * dw1) / det;
        const pb = (du1 * dh2 - du2 * dh1) / det;
        const py = H[i]! - pa * U[i]! - pb * W[i]!;
        if (py >= best) continue;
        let holds = true;
        for (let s = 0; s < m && holds; s++) {
          const l = IDX[s]!;
          holds = py + pa * U[l]! + pb * W[l]! >= H[l]! - 1e-4;
        }
        if (!holds) continue;
        best = py;
        a = pa;
        b = pb;
      }
    }
  }
  if (best === Infinity) return 0;
  out.y = at.y + (best - at.y) * w;
  out.a = at.a + (a - at.a) * w;
  out.b = at.b + (b - at.b) * w;
  return w;
}

const _at: Plane = { y: 0, a: 0, b: 0 };
const _to: Plane = { y: 0, a: 0, b: 0 };
/** Speeds (m/s) under which a car has time to settle on what it straddles (full) and over which the dynamic ground pose rules (none). */
const CRAWL = [3, 6] as const;

/**
 * The ground pose a driven body was given, `gy` high under its origin at plan (x, z) with the axle chord's rise per metre
 * ahead `grade` (NaN: none) and the ground's unit normal `n` there, made right at `speed` (m/s) of travel: false when it
 * holds (nothing is touched); true when the body rests on a feature, `n` is rewritten to the rest plane's normal (the
 * slope is all in it: take no `grade`) and its height is `out.y`. Quasi-static: a car going over an edge or a lip at
 * speed keeps the dynamic pose its jumps and launches are tuned on, and one crawling or at rest settles.
 */
export function settle(
  g: Ground,
  x: number,
  z: number,
  hint: number,
  yaw: number,
  pitch: number,
  roll: number,
  lift: number,
  speed: number,
  gy: number,
  grade: number,
  n: { x: number; y: number; z: number },
  out: { y: number },
): boolean {
  const crawl = 1 - smooth(speed, CRAWL);
  if (crawl === 0) return false;
  const sy = Math.sin(yaw);
  const cy = Math.cos(yaw);
  _at.y = gy;
  _at.a = Number.isNaN(grade) ? -(n.x * sy + n.z * cy) / n.y : grade;
  _at.b = -(n.x * cy - n.z * sy) / n.y;
  if (correct(g, x, z, hint, yaw, pitch, roll, lift, crawl, _at, _to) === 0) return false;
  const gx = _to.a * sy + _to.b * cy;
  const gz = _to.a * cy - _to.b * sy;
  const len = Math.hypot(gx, 1, gz);
  n.x = -gx / len;
  n.y = 1 / len;
  n.z = -gz / len;
  out.y = _to.y;
  return true;
}
