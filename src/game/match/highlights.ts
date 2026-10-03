import { CRASH, TRANSFER } from "../kernel/physics-core.js";
import { BEAM_SPECS, CAGES, MASS_SPECS, SENSORS, SHAPE_CLUSTERS } from "../kernel/rig-spec.ts";
import { DRIVE } from "../vehicle/car-drive.ts";
import type { DeformMode } from "../deform/deform-rig.ts";
import type { CarStyleId } from "../vehicle/car-variants.ts";
import { CLASSES, type VehicleClassId } from "../vehicle/vehicle-classes.ts";

/**
 * Crash highlights (docs/HIGHLIGHTS.md): a race's impacts grouped into clusters, each scored, the best `TOP`
 * kept as clips for the end-of-race reel. Numbers only; the recorder (`engine/engine-record.ts`) feeds it.
 */

/** Clips kept for the reel. */
export const TOP = 5;
/** A cluster closes after this long (s) with no impact in it. */
export const QUIET_GAP = 1.5;
/** Clip context before the first impact and after the last (s). */
export const PRE_ROLL = 3;
const POST_ROLL = 3;
/** Longest first-to-last impact span (s): a later impact opens a new cluster. Keeps a clip inside the recorder's ring. */
export const MAX_SPAN = 6;
/** An impact joins an open cluster that shares a car, or whose centre is within this distance (m). */
const JOIN_R = 30;
/** Car–car closing speed (m/s) that counts as an impact: wrecks grinding in a pile close at 3–4, a real hit at 5+ (18 km/h). */
export const PAIR_MIN = 5;
/** Wall and prop closing speed (m/s) that counts: a wall brush along the barrier closes at 1–4. */
export const WALL_MIN = 5;
/** A contact is an impact only when its pair (or its car and the walls) had been apart this long (s): grinding never re-counts. */
export const REHIT_S = 0.35;
/**
 * Score = Σ energy / ENERGY_REF + CAR_POINTS per car past the first + KILL_POINTS per engine destroyed + DENSITY_POINTS
 * per impact per second (capped at DENSITY_CAP). Energy is closing² × reduced mass (kg·m²/s²): a 30 km/h sedan tap
 * is ~0.5e5, a 100 km/h head-on ~5e5. Ranking only; the weights are set so a 4-car pile-up and an engine kill beat a
 * single tap or a wall scrape (highlights.test.ts).
 */
const ENERGY_REF = 1e5;
const CAR_POINTS = 1.5;
const KILL_POINTS = 4;
const DENSITY_POINTS = 0.4;
const DENSITY_CAP = 6;
/** Below this a cluster is a scrape, not a highlight (a lone 20 km/h tap scores ~2.3). */
export const MIN_SCORE = 3;

/** Number of set bits (cars in a 32-car mask). */
function popcount(x: number): number {
  let v = x >>> 0;
  let n = 0;
  while (v) {
    v &= v - 1;
    n++;
  }
  return n;
}

/** Impact energy of a contact: closing² × the pair's reduced mass (`massB` Infinity: a wall). */
export function impactEnergy(closing: number, massA: number, massB: number): number {
  const mu = Number.isFinite(massB) ? (massA * massB) / (massA + massB) : massA;
  return closing * closing * mu;
}

/** One burst of impacts: the cars in it, when, where and how hard. */
export class CrashCluster {
  /** Race-clock seconds of the first and the last impact. */
  first = 0;
  last = 0;
  energy = 0;
  impacts = 0;
  kills = 0;
  /** Bit i: car i took part. */
  cars = 0;
  /** Strongest closing speed (m/s) and the car with the most energy in it (the camera's subject). */
  peak = 0;
  focus = -1;
  private focusEnergy = 0;
  /** Impact position sum (centre = sum / impacts). */
  private sx = 0;
  private sz = 0;
  /** The first impact: where, and its cars (`b0` −1: a wall, a prop or a kill). */
  x0 = 0;
  z0 = 0;
  a0 = -1;
  b0 = -1;

  get x(): number {
    return this.sx / Math.max(1, this.impacts);
  }

  get z(): number {
    return this.sz / Math.max(1, this.impacts);
  }

  get score(): number {
    const span = Math.max(this.last - this.first, 0.5);
    return (
      this.energy / ENERGY_REF +
      CAR_POINTS * Math.max(0, popcount(this.cars) - 1) +
      KILL_POINTS * this.kills +
      DENSITY_POINTS * Math.min(DENSITY_CAP, this.impacts / span)
    );
  }

  add(t: number, a: number, b: number, closing: number, energy: number, x: number, z: number): void {
    if (this.impacts === 0) {
      this.first = t;
      this.x0 = x;
      this.z0 = z;
      this.a0 = a;
      this.b0 = b;
    }
    this.last = t;
    this.impacts++;
    this.energy += energy;
    this.cars = (this.cars | (1 << a) | (b >= 0 ? 1 << b : 0)) >>> 0;
    this.peak = Math.max(this.peak, closing);
    this.sx += x;
    this.sz += z;
    if (energy > this.focusEnergy) {
      this.focusEnergy = energy;
      this.focus = a;
    }
  }

  /** Car `i`'s engine was destroyed inside this cluster. */
  kill(t: number, i: number): void {
    this.kills++;
    this.last = Math.max(this.last, t);
    this.cars = (this.cars | (1 << i)) >>> 0;
    if (this.focus < 0) this.focus = i;
  }
}

/**
 * Open clusters and the kept clips. `impact` / `kill` feed it as the race runs; `due` hands back a cluster whose
 * post-roll has passed, and `keep` files its clip if it ranks in the top `TOP`.
 */
export class HighlightLedger<C extends { score: number }> {
  readonly open: CrashCluster[] = [];
  /** Best first. */
  readonly kept: C[] = [];

  clear(): void {
    this.open.length = 0;
    this.kept.length = 0;
  }

  /** The open cluster an impact at (x, z) between `a` and `b` (−1: no car) joins, or null. */
  private joins(t: number, a: number, b: number, x: number, z: number): CrashCluster | null {
    const mask = (1 << a) | (b >= 0 ? 1 << b : 0);
    for (const c of this.open) {
      if (t - c.last > QUIET_GAP || t - c.first > MAX_SPAN) continue;
      if ((c.cars & mask) !== 0 || (c.x - x) ** 2 + (c.z - z) ** 2 < JOIN_R * JOIN_R) return c;
    }
    return null;
  }

  /** An impact; returns its cluster, and whether that cluster is new (its first impact). */
  impact(t: number, a: number, b: number, closing: number, energy: number, x: number, z: number): CrashCluster {
    let c = this.joins(t, a, b, x, z);
    if (!c) {
      c = new CrashCluster();
      this.open.push(c);
    }
    c.add(t, a, b, closing, energy, x, z);
    return c;
  }

  /** Car `i`'s engine died at (x, z): it joins (or opens) a cluster like an impact. */
  kill(t: number, i: number, x: number, z: number): CrashCluster {
    let c = this.joins(t, i, -1, x, z);
    if (!c) {
      c = new CrashCluster();
      c.add(t, i, -1, 0, 0, x, z);
      this.open.push(c);
    }
    c.kill(t, i);
    return c;
  }

  /** A cluster whose post-roll is over at `t` (removed from `open`), or null. `force`: any open cluster (race over). */
  due(t: number, force = false): CrashCluster | null {
    for (let k = 0; k < this.open.length; k++) {
      const c = this.open[k]!;
      if (!force && t - c.last < Math.max(QUIET_GAP, POST_ROLL) && t - c.first <= MAX_SPAN + POST_ROLL) continue;
      this.open.splice(k, 1);
      return c;
    }
    return null;
  }

  /** Whether a cluster scoring `score` makes the reel now. */
  ranks(score: number): boolean {
    if (score < MIN_SCORE) return false;
    return this.kept.length < TOP || score > this.kept[this.kept.length - 1]!.score;
  }

  /** File `clip` by score; the lowest past `TOP` drops out. */
  keep(clip: C): void {
    let k = this.kept.length;
    while (k > 0 && this.kept[k - 1]!.score < clip.score) k--;
    this.kept.splice(k, 0, clip);
    if (this.kept.length > TOP) this.kept.length = TOP;
  }
}

/** Per car per step: throttle i8, steer i8 (1/127 steps, as a netplay peer's input), brake u8 (0–255), flags u8 (1 ebrake, 2 boost). */
export const INPUT_BYTES = 4;

export type ReelCar = { slot: number; style: CarStyleId; cls: VehicleClassId; name: string };

/** One highlight: initial conditions, every step's dt and drive outputs, and the keyframes that correct drift. */
export type HighlightClip = {
  trackId: string;
  score: number;
  impacts: number;
  kills: number;
  /** Strongest closing speed (km/h). */
  peakKph: number;
  /** Race-clock seconds of the clip's first step. */
  t0: number;
  /** Seconds from the clip's start: first and last impact. */
  firstImpact: number;
  lastImpact: number;
  /** The step the first impact came in (the last one a keyframe corrects; one keyframe sits there). */
  firstStep: number;
  /** The first impact's world position. */
  x: number;
  z: number;
  /** The camera's subject (index into `cars`). */
  focus: number;
  /** The first impact's cars (indices into `cars`; `firstB` −1: a wall, a prop or an engine kill). */
  firstA: number;
  firstB: number;
  /** `HANDLING.realism` the race ran at. */
  realism: number;
  /** The engine's wreck-slide rule was on (`bleedAfterSlide`): it reads the crash clock, which a race never moves. */
  bleed: boolean;
  /** The race's deform dress (the HUD's crumple settings): every peer replays with the recording's, not its own. */
  squash: number;
  buckle: number;
  deformMode: DeformMode;
  cars: ReelCar[];
  /** Per step: dt (s, whole microseconds). */
  h: Float32Array;
  /** Per step × car: `INPUT_BYTES`. */
  inputs: Uint8Array;
  /** Per keyframe: the step it applies at (before that step's drive). Keyframe 0 is step 0; one may sit at the first impact. */
  keyStep: Uint32Array;
  /**
   * Per keyframe: the clip's cars as a netplay snapshot message (`net/codec.ts` `writeSnapshot`, `cars` order; a wreck
   * carries its wreck section in keyframe 0), then each car's drift-assist state (`drive.drift`, q16).
   */
  keys: Uint8Array[];
};

/** The reel a race shows: its clips (best first) and the seed every peer picks shots from. */
export type Reel = { seed: number; clips: HighlightClip[] };

/** Tuning a replay depends on: a clip recorded under other numbers replays as another crash, so storage refuses it. */
export function simFingerprint(): number {
  const json = JSON.stringify([CLASSES, DRIVE, CRASH, TRANSFER, MASS_SPECS, BEAM_SPECS, CAGES, SENSORS, SHAPE_CLUSTERS]);
  // FNV-1a, 32-bit.
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) h = Math.imul(h ^ json.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** HUD line for a clip: "4-car pile-up", "Engine destroyed", "Head-on, 96 km/h". */
export function clipTitle(c: Pick<HighlightClip, "cars" | "kills" | "peakKph" | "impacts">): string {
  const n = c.cars.length;
  if (n >= 3) return `${n}-car pile-up`;
  if (c.kills > 0) return c.kills > 1 ? `${c.kills} engines destroyed` : "Engine destroyed";
  if (n === 2) return `${Math.round(c.peakKph)} km/h smash`;
  return `Wall hit, ${Math.round(c.peakKph)} km/h`;
}
