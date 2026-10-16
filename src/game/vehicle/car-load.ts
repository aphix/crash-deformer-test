import { WHEEL_POS } from "./car-mesh.ts";
import { CLASSES, gearAt, type VehicleClassId } from "./vehicle-classes.ts";
import { detSin } from "../kernel/physics-core.js";

/** tanh from `Math.exp` (the same bits in every engine; `Math.tanh` rounds differently in Chromium): saturated past |x| = 20, where it is ±1 in doubles. */
function tanh(x: number): number {
  if (x > 20) return 1;
  if (x < -20) return -1;
  const e = Math.exp(2 * x);
  return (e - 1) / (e + 1);
}

/** Half the wheelbase and half the track (m). */
const AXLE = WHEEL_POS[0]![2];
const TRACK = Math.abs(WHEEL_POS[0]![0]);

/**
 * Drawn-pose feel knobs (mutable: the debug panel sets them live). `driftLean`: extra drawn roll in a slide, a share of the class cap at full slide; the body leans into the drift.
 * `shiftKick`: the gear change's pitch kick, as a multiple of its tuned size (0 off).
 */
export const LOAD_FEEL = { driftLean: 0.6, shiftKick: 1 };

/** A gear change's kick (masterclass 17:03, "the chassis rocks back and forth during gear changes"): a damped ring of `SHIFT_HZ` that starts as the nose dips, `SHIFT_DEG` of body pitch at the most for every class (a slight kick: a share of a class's cap was 4x as much on a monster), lasting under `SHIFT_END` s; a shift sooner than `SHIFT_GAP` s after the last is the speed hovering at a gear's edge and is let go. */
const SHIFT_DEG = 0.45;
const SHIFT_HZ = 4;
const SHIFT_TAU = 0.12;
const SHIFT_END = 0.6;
const SHIFT_GAP = 0.25;
/** A downshift's share of an upshift's kick. */
const SHIFT_DOWN = 0.6;

/**
 * Per class: the most the drawn body pitches (squat / dive) and rolls under load transfer (deg). The spring model alone gives a
 * sedan 2.3° of pitch at 1 g and a monster 15°; these limits are what arcade launches and corners saturate at, small enough that
 * the springs keep room for a landing. The centre of gravity's height is the class's (`ClassStats.cgHeight`).
 */
const LOAD: Readonly<Record<VehicleClassId, { pitch: number; roll: number }>> = {
  sedan: { pitch: 1.5, roll: 3 },
  muscle: { pitch: 1.8, roll: 3 },
  police: { pitch: 1.5, roll: 3 },
  truck: { pitch: 2.2, roll: 3.4 },
  monster: { pitch: 3.5, roll: 4 },
};

/** Time constant (s) the ground pose's acceleration is smoothed over: a few slices, so one contact spike doesn't kick the body. */
const TAU = 0.06;
/** A slice's acceleration is cut here (m/s²) before smoothing, and a ground pose faster than `JUMP` (m/s) was teleported. */
const A_MAX = 80;
const JUMP = 100;
const RAD = Math.PI / 180;

/**
 * `load` (m, a spring offset) that leans the body against the road's own slope `slope` (sin of its angle, + nose / +x
 * side up) shrinks one for one with it and is gone once the road is as steep as the class's limit `cap` (rad): a squat
 * on a descent would hold the nose up off the road it drives down, and read as wheels off the ground. A load along
 * the road stays.
 */
function alongRoad(load: number, slope: number, cap: number): number {
  return load * slope < 0 ? load * Math.max(0, 1 - Math.abs(slope) / cap) : load;
}

/**
 * Longitudinal and lateral load transfer of a car's ground pose, as the drawn springs' resting offsets: under
 * acceleration the rear squats and the nose rises, under braking the nose dives, in a turn the body leans outward.
 * Drawn only: the acceleration is read off `group.matrixWorld` across slices, as `Suspension` reads vertical speed.
 */
export class LoadTransfer {
  /** Each wheel's body offset (m, `Suspension.offset` sign) the load holds the body at, `WHEEL_POS` order. */
  readonly target = new Float64Array(4);
  private px = 0;
  private pz = 0;
  private vx = 0;
  private vz = 0;
  /** The ground pose's horizontal acceleration (world, m/s²), smoothed. */
  private ax = 0;
  private az = 0;
  /** Slices seen since the spawn: 1 gives a position, 2 a velocity, 3 an acceleration. */
  private seen = 0;
  /** The gauge's gear at the last slice (0: none yet or reversing), seconds since the last shift (`Infinity`: none) and its kick's sign and share (a downshift's is smaller). */
  private gear = 0;
  private age = Infinity;
  private dir = 0;

  reset(): void {
    this.seen = 0;
    this.ax = 0;
    this.az = 0;
    this.gear = 0;
    this.age = Infinity;
    this.target.fill(0);
  }

  /**
   * One slice: ground pose `e` (a matrixWorld's elements, current), `air` while no wheel is on the ground (no load),
   * spring stiffness per unit mass `k` (ω², 1/s²) of class `cls`, the drive's slide (0–1) and the driven wheels' spin (`drive.spinSpeed`, m/s).
   */
  step(e: ArrayLike<number>, dt: number, air: boolean, cls: VehicleClassId, k: number, slide = 0, spinSpeed = 0): void {
    const x = e[12]!;
    const z = e[14]!;
    const vx = this.seen > 0 ? (x - this.px) / dt : 0;
    const vz = this.seen > 0 ? (z - this.pz) / dt : 0;
    this.px = x;
    this.pz = z;
    if (vx * vx + vz * vz > JUMP * JUMP) {
      // Placed, not driven: start over from here.
      this.seen = 1;
      this.vx = 0;
      this.vz = 0;
      this.ax = 0;
      this.az = 0;
      this.gear = 0;
      return;
    }
    if (air) {
      this.ax = 0;
      this.az = 0;
    } else if (this.seen > 1) {
      const s = 1 - Math.exp(-dt / TAU);
      this.ax += (Math.max(-A_MAX, Math.min(A_MAX, (vx - this.vx) / dt)) - this.ax) * s;
      this.az += (Math.max(-A_MAX, Math.min(A_MAX, (vz - this.vz) / dt)) - this.az) * s;
    }
    this.vx = vx;
    this.vz = vz;
    if (this.seen < 2) this.seen++;
    this.shift(e, vx, vz, air, cls, spinSpeed);

    // Along the body's nose (+z) and toward its +x side.
    const along = this.ax * e[8]! + this.az * e[10]!;
    const side = this.ax * e[0]! + this.az * e[2]!;
    const c = LOAD[cls];
    const cg = CLASSES[cls].cgHeight;
    // Per wheel a spring k m/4 carries ΔF = m a h / (2 L) (axle) or m a h / (2 T) (side): Δ = 2 a h / (L k) with
    // L the wheelbase and T the track; the springs' own scale is saturated at the class's limit.
    const capP = AXLE * Math.tan(c.pitch * RAD);
    const capR = TRACK * Math.tan(c.roll * RAD * (1 + LOAD_FEEL.driftLean * slide));
    const p = alongRoad(capP * tanh((along * cg) / (AXLE * k * capP)), e[9]!, c.pitch * RAD) + this.kick(dt);
    const r = alongRoad(capR * tanh((side * cg) / (TRACK * k * capR)), e[1]!, c.roll * RAD);
    // Front and the +x side rise under +along and +side; the rear and the −x side sink.
    this.target[0] = p - r;
    this.target[1] = p + r;
    this.target[2] = -p - r;
    this.target[3] = -p + r;
  }

  /** The gauge's gear (`carGear`) of this slice's driven-wheel speed (the body's plus the spin): a change while the wheels are down starts a kick (not on a spawn or a landing). */
  private shift(e: ArrayLike<number>, vx: number, vz: number, air: boolean, cls: VehicleClassId, spinSpeed: number): void {
    const along = vx * e[8]! + vz * e[10]!;
    const g = along < -0.5 ? 0 : gearAt(CLASSES[cls], along + spinSpeed) + 1;
    if (g !== this.gear && !air && this.seen > 1 && this.gear > 0 && g > 0 && this.age > SHIFT_GAP) {
      this.age = 0;
      this.dir = g > this.gear ? 1 : SHIFT_DOWN;
    }
    this.gear = g;
  }

  /** The shift's pitch (m of wheel offset, + nose up) this slice: the nose dips as the torque lets go, then rings out. */
  private kick(dt: number): number {
    this.age += dt;
    if (this.age > SHIFT_END) return 0;
    return -this.dir * LOAD_FEEL.shiftKick * AXLE * Math.tan(SHIFT_DEG * RAD) * detSin(2 * Math.PI * SHIFT_HZ * this.age) * Math.exp(-this.age / SHIFT_TAU);
  }
}
