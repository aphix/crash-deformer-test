import { CRASH, TRANSFER } from "../kernel/physics-core.js";
import { BEAM_SPECS, CAGES, MASS_SPECS, SENSORS, SHAPE_CLUSTERS } from "../kernel/rig-spec.ts";
import { DRIVE } from "../vehicle/car-drive.ts";
import type { DeformMode } from "../deform/deform-rig.ts";
import type { CarStyleId } from "../vehicle/car-variants.ts";
import type { Ejection } from "../vehicle/ejection.ts";
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
/**
 * A clip's scope (owner 10-07): its main car (the faster car of its strongest impact), the cars the main car directly hit,
 * and whatever happens within this many metres of the main car's own hit points. The clip's score, title, reel moments,
 * thrown-driver ride-along and camera lookahead count only those: another crash in the same cluster is a clip of its own.
 */
const SCOPE_R = 10;
/** Events (impacts, kills, throws) a cluster remembers to scope its clips when it closes: a pathological pile-up drops its weakest impacts. */
const MAX_EVENTS = 96;
/** Hits a clip lists for the reel's camera: the strongest, in time order, when its scope holds more. */
export const MAX_HITS = 24;
/**
 * Closing speed (m/s) at which any contact counts as an impact: car–car, wall and prop alike (45 km/h). Measured on 192 races
 * (docs/HIGHLIGHTS.md): below it a hit cannot make a clip alone (a sedan head-on scores `MIN_SCORE` at 12.5 m/s), so a
 * slower bump could only ever join a cluster and lift its score and car count: the "pile-ups of slow bumps".
 */
export const IMPACT_MIN = 12.5;
/** A contact is an impact only when its pair (or its car and the walls) had been apart this long (s): grinding never re-counts. */
export const REHIT_S = 0.35;
/**
 * Score = Σ weight × energy / ENERGY_REF + CAR_POINTS × weight(peak) per car past the first + KILL_POINTS per engine
 * destroyed + EJECT_POINTS per driver thrown out + DENSITY_POINTS × Σ weight per second (capped at DENSITY_CAP), all over
 * the clip's scope (`SCOPE_R`), + DEFORM_POINTS per metre of aggregate deformation. Energy is closing² × reduced mass
 * (kg·m²/s²): a 30 km/h sedan tap is ~0.5e5, a 100 km/h head-on ~5e5. Ranking only; the weights are set so a 4-car
 * pile-up and an engine kill beat a single tap or a wall scrape (highlights.test.ts).
 */
const ENERGY_REF = 1e5;
const CAR_POINTS = 1.5;
const KILL_POINTS = 4;
/**
 * Impact force scales each impact (`impactWeight`): its closing speed over the reference hit's (50 km/h, a hit the
 * reel scored ×1 before the scale) to the power SCALE_POW. Linear in speed on top of energy's v² (so the energy term
 * goes as v³, the car and density terms as v): a 100 km/h head-on scores ~4.2× a 50 km/h one (2.1× unscaled), a 20 km/h
 * tap ~0.4× its old score. Energy is the physical cost of a hit; the weight is how much of a highlight it is, and a
 * soft tap is a collision, not a crash.
 */
const SCALE_REF = 50 / 3.6;
const SCALE_POW = 1;
/**
 * A driver thrown out of his car (`EjectionWatch`) is the moment the owner wants in the reel: 26 points each, and the
 * engine kill that throws him is 4 more. The hit that throws him is in the cluster (measured: a 55 km/h wall hit at least, a
 * 110 km/h head-on). The softest ejection clip (a 55 km/h wall hit, impact 32.5 + 2.6 m of crush) outscores the hardest hit that
 * spares both engines (a 109 km/h head-on, impact 19.0 + 6.0 m of crush: 43.0 to 45.0, engine-record-scale.test.ts). Racer-only
 * rules still decide whose ejection counts (`CrashRecorder.eject`).
 */
const EJECT_POINTS = 26;
const DENSITY_POINTS = 0.4;
const DENSITY_CAP = 6;
/**
 * Points per metre of aggregate deformation (`HighlightClip.deform`), "the sum of all the deformations within a clip" (owner
 * 10-07): per car the sum over its cages of what each gained, summed over the clip's scope. The other terms are impact force
 * and what it broke; this one is how much the cars show it. The owner's example sets its size: a 2 m total crush at 30 km/h
 * outscores a 1 m crush at 60 km/h, so a metre must be worth more than the 3.42 points a lone sedan hit gains from 30 km/h
 * (1.67) to 60 km/h (5.09) per extra metre: 4 (highlights.test.ts). The crush the sim makes is of that size: two sedans
 * head-on gain 1.5 m at 30 km/h, 2.2 m at 45, 2.8 at 60 and 5.3 at 100 (engine-record-scale.test.ts).
 */
const DEFORM_POINTS = 4;

/** A clip's score: its scope's impact score (`CrashCluster.score`) and `DEFORM_POINTS` per metre of the `deform` it gained. */
export function clipScore(impact: number, deform: number): number {
  return impact + DEFORM_POINTS * deform;
}

/** Below this a cluster is a scrape, not a highlight (a lone 20 km/h tap scores ~1.0). */
export const MIN_SCORE = 3;

/**
 * Crush (m, the measure of `HighlightClip.deform`, summed over the two cars) at which a contact slower than `IMPACT_MIN` counts
 * anyway: a car rolling onto another's roof closes slowly and wrecks it. It is what two sedans gain in a hit at `IMPACT_MIN`
 * (45 km/h; measured through the recorder, engine-record-scale.test.ts: 2.2 m, as deep as the owner's 2 m at 30 km/h), so a
 * slow contact counts once it has crushed its cars as deep as a hit at the threshold speed does. The crush alone then earns
 * 4 × 2.2 = 8.8 points, above `MIN_SCORE`: a slow deep crush makes a clip (roof onto roof from 3 m: 4.4 m, 17.8 points).
 */
export const CRUSH_MIN = 2.2;

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

/** How much an impact closing at `closing` m/s counts: 1 at `SCALE_REF` (50 km/h), above it more, below it less. */
function impactWeight(closing: number): number {
  return (closing / SCALE_REF) ** SCALE_POW;
}

/**
 * Whether a contact is an impact: its pair (or its car and the walls) had been apart `apart` s, at least `REHIT_S`, and it
 * closes at `strength` m/s, at least `IMPACT_MIN` (grinding never re-counts); or the pair has crushed its cars `crush` m
 * deep since their contacts began, at least `CRUSH_MIN`, however slowly it closed (the caller hands over 0 for a run of
 * contacts that has counted already). The recorder's ledger and the replay's first-hit marker (`ClipSim`) both ask it; the
 * marker sees no crush (0).
 */
export function countsAsImpact(apart: number, strength: number, crush = 0): boolean {
  return (apart >= REHIT_S && strength >= IMPACT_MIN) || crush >= CRUSH_MIN;
}

/** The kinds of event a cluster remembers. */
const IMPACT = 0;
const KILL = 1;
const EJECT = 2;
/** Doubles per event, and where each lies: kind, race second, cars a and b (−1: none), closing speed, energy, position, each car's own speed, in the scope (0/1). */
const EV = 12;
const [K, T, A, B, CLOSING, ENERGY, X, Y, Z, VA, VB, IN] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const;

/** One impact of a clip's scope: when (race seconds), where, between which cars (−1: a wall or a prop) and how hard (m/s). */
type ScopeHit = { t: number; x: number; y: number; z: number; a: number; b: number; closing: number };

/**
 * One burst of events (impacts, kills, throws): the cars in it, when, where and how hard. It remembers each event and what
 * they come to for the scope of its clip (`SCOPE_R`): the totals below are the current scope's, kept as events arrive. A cluster
 * holds more than one scope when separate crashes joined it (`rest`): each is a clip of its own.
 */
export class CrashCluster {
  /** Race-clock seconds of the first and the last event of the whole cluster (the ledger's windows). */
  first = 0;
  last = 0;
  /** Bit i: car i took part in any event of the cluster: the cars its clips carry, and what the ledger joins on. */
  cars = 0;
  /** The current scope's main car (−1: none left), the faster car of its strongest impact. */
  main = -1;
  /** Race-clock seconds of the scope's first and last event. */
  scopeFirst = 0;
  scopeLast = 0;
  /** Σ impact energy × `impactWeight`: a hard hit counts for more than its energy, a soft one for less. */
  energy = 0;
  impacts = 0;
  /** Σ `impactWeight` over the impacts (the density term's count). */
  weight = 0;
  kills = 0;
  /** Drivers thrown out inside the scope. */
  ejects = 0;
  /** Strongest closing speed (m/s) in the scope. */
  peak = 0;
  /** The main car's own speed (m/s) in its strongest impact: a wall hit's closing speed. */
  hitMps = 0;
  /** The camera's subject: the first driver thrown out in the scope, else the main car. */
  focus = -1;
  /** Bit i: car i is in an event of the scope. */
  hitCars = 0;
  /** The scope's first impact: where, and its cars (`b0` −1: a wall, a prop or a kill). */
  x0 = 0;
  z0 = 0;
  a0 = -1;
  b0 = -1;
  /** Position sum of the impacts (and of the event that opened the cluster): centre = sum / count. */
  private sx = 0;
  private sz = 0;
  private count = 0;
  private ev = new Float64Array(0);
  private anchors = new Int16Array(0);
  private n = 0;
  /** The scope's reach: bit i for the main car and each car it directly hit, and the events (`anchors`, indices) of the main car's own hits. */
  private direct = 0;
  private anchorCount = 0;

  /** Cars in the scope (impacts, an engine kill, a throw): the pile-up count of its title. */
  get hit(): number {
    return popcount(this.hitCars);
  }

  get x(): number {
    return this.sx / Math.max(1, this.count);
  }

  get z(): number {
    return this.sz / Math.max(1, this.count);
  }

  get score(): number {
    const span = Math.max(this.scopeLast - this.scopeFirst, 0.5);
    return (
      this.energy / ENERGY_REF +
      CAR_POINTS * Math.max(0, this.hit - 1) * impactWeight(this.peak) +
      KILL_POINTS * this.kills +
      EJECT_POINTS * this.ejects +
      DENSITY_POINTS * Math.min(DENSITY_CAP, this.weight / span)
    );
  }

  /** An impact between `a` and `b` (−1: a wall or a prop) closing at `closing` m/s at (x, y, z), the cars driving at `va` and `vb` m/s. */
  add(t: number, a: number, b: number, closing: number, energy: number, x: number, y: number, z: number, va: number, vb: number): void {
    this.put(IMPACT, t, a, b, closing, energy, x, y, z, va, vb);
  }

  /** Car `i`'s engine was destroyed inside this cluster. */
  kill(t: number, i: number, x: number, z: number): void {
    this.put(KILL, t, i, -1, 0, 0, x, 0, z, 0, 0);
  }

  /** Car `i`'s driver was thrown out inside this cluster; the first one in the scope is its subject (the camera frames his flight). */
  eject(t: number, i: number, x: number, z: number): void {
    this.put(EJECT, t, i, -1, 0, 0, x, 0, z, 0, 0);
  }

  private put(kind: number, t: number, a: number, b: number, closing: number, energy: number, x: number, y: number, z: number, va: number, vb: number): void {
    if (this.ev.length === 0) {
      this.ev = new Float64Array(MAX_EVENTS * EV);
      this.anchors = new Int16Array(MAX_EVENTS);
    }
    const ev = this.ev;
    let i = this.n;
    if (i === MAX_EVENTS) {
      // Full: the weakest impact makes room for a stronger one, a kill or a throw; a weaker impact is dropped.
      let least = Infinity;
      i = -1;
      for (let k = 0; k < MAX_EVENTS; k++) {
        const o = k * EV;
        if (ev[o + K] === IMPACT && ev[o + CLOSING] < least) {
          least = ev[o + CLOSING];
          i = k;
        }
      }
      if (i < 0 || (kind === IMPACT && closing <= least)) return;
    } else this.n++;
    const o = i * EV;
    ev[o + K] = kind;
    ev[o + T] = t;
    ev[o + A] = a;
    ev[o + B] = b;
    ev[o + CLOSING] = closing;
    ev[o + ENERGY] = energy;
    ev[o + X] = x;
    ev[o + Y] = y;
    ev[o + Z] = z;
    ev[o + VA] = va;
    ev[o + VB] = vb;
    ev[o + IN] = 0;
    if (this.cars === 0) this.first = t;
    this.last = Math.max(this.last, t);
    if (kind === IMPACT || this.cars === 0) {
      this.sx += x;
      this.sz += z;
      this.count++;
    }
    this.cars = (this.cars | (1 << a) | (b >= 0 ? 1 << b : 0)) >>> 0;
    this.rescope();
  }

  /** The scope of the cluster's events: the main car, the cars it directly hit, and every event within `SCOPE_R` of its own hit points. */
  private rescope(): void {
    const ev = this.ev;
    const n = this.n;
    let strongest = -1;
    let most = -1;
    for (let i = 0; i < n; i++) {
      const o = i * EV;
      if (ev[o + K] === IMPACT && ev[o + ENERGY] > most) {
        most = ev[o + ENERGY];
        strongest = i;
      }
    }
    let main = -1;
    if (strongest >= 0) main = ev[strongest * EV + VA] >= ev[strongest * EV + VB] ? ev[strongest * EV + A] : ev[strongest * EV + B];
    else if (n > 0) main = ev[A];
    this.main = main;
    this.energy = this.weight = this.peak = this.hitMps = this.hitCars = 0;
    this.impacts = this.kills = this.ejects = 0;
    this.focus = main;
    this.a0 = this.b0 = -1;
    if (main < 0) return;
    // The cars the main car directly hit (with it, the scope's cars), and where: every impact of those cars, the main car's own hits and the hits of the cars it hit (a kill or a throw of the main car when there is none).
    let direct = (1 << main) >>> 0;
    for (let i = 0; i < n; i++) {
      const o = i * EV;
      if (ev[o + K] !== IMPACT || (ev[o + A] !== main && ev[o + B] !== main)) continue;
      direct = (direct | (1 << ev[o + A]) | (ev[o + B] >= 0 ? 1 << ev[o + B] : 0)) >>> 0;
    }
    let anchors = 0;
    for (let i = 0; i < n; i++) {
      const o = i * EV;
      if (ev[o + K] === IMPACT && (((1 << ev[o + A]) | (ev[o + B] >= 0 ? 1 << ev[o + B] : 0)) & direct) !== 0) this.anchors[anchors++] = i;
    }
    if (anchors === 0) for (let i = 0; i < n; i++) if (ev[i * EV + A] === main) this.anchors[anchors++] = i;
    this.direct = direct;
    this.anchorCount = anchors;
    let firstAt = Infinity;
    let firstImpactAt = Infinity;
    let firstEjectAt = Infinity;
    let lastAt = -Infinity;
    let e0 = -1;
    let i0 = -1;
    for (let i = 0; i < n; i++) {
      const o = i * EV;
      ev[o + IN] = 0;
      if (!this.takes(ev[o + A], ev[o + B], ev[o + X], ev[o + Z])) continue;
      const cars = ((1 << ev[o + A]) | (ev[o + B] >= 0 ? 1 << ev[o + B] : 0)) >>> 0;
      ev[o + IN] = 1;
      this.hitCars = (this.hitCars | cars) >>> 0;
      const t = ev[o + T];
      lastAt = Math.max(lastAt, t);
      if (t < firstAt) {
        firstAt = t;
        e0 = i;
      }
      if (ev[o + K] === IMPACT) {
        const w = impactWeight(ev[o + CLOSING]);
        this.impacts++;
        this.energy += ev[o + ENERGY] * w;
        this.weight += w;
        this.peak = Math.max(this.peak, ev[o + CLOSING]);
        if (t < firstImpactAt) {
          firstImpactAt = t;
          i0 = i;
        }
      } else if (ev[o + K] === KILL) this.kills++;
      else {
        this.ejects++;
        if (t < firstEjectAt) {
          firstEjectAt = t;
          this.focus = ev[o + A];
        }
      }
    }
    this.scopeLast = lastAt;
    const f = (i0 >= 0 ? i0 : e0) * EV;
    this.scopeFirst = ev[f + T];
    this.x0 = ev[f + X];
    this.z0 = ev[f + Z];
    this.a0 = ev[f + A];
    this.b0 = ev[f + K] === IMPACT ? ev[f + B] : -1;
    if (strongest >= 0) this.hitMps = ev[strongest * EV + B] < 0 ? ev[strongest * EV + CLOSING] : main === ev[strongest * EV + A] ? ev[strongest * EV + VA] : ev[strongest * EV + VB];
  }

  /**
   * Whether an event of cars `a` and `b` (−1: none) at (x, z) is in the scope as it stands: it involves the main car or a car
   * it directly hit, or lies within `SCOPE_R` of one of the main car's own hit points. The one rule of membership: the
   * ledger joins events to a cluster by it, and a cluster scopes its clip by it.
   */
  takes(a: number, b: number, x: number, z: number): boolean {
    if (this.main < 0) return false;
    if ((((1 << a) | (b >= 0 ? 1 << b : 0)) & this.direct) !== 0) return true;
    const ev = this.ev;
    for (let k = 0; k < this.anchorCount; k++) {
      const q = this.anchors[k]! * EV;
      if ((x - ev[q + X]!) ** 2 + (z - ev[q + Z]!) ** 2 < SCOPE_R * SCOPE_R) return true;
    }
    return false;
  }

  /**
   * The cluster without the scope's events: what the crash of other cars it joined makes (its own scope, its own clip), or
   * null when the scope is all of it. The cluster itself is left as it is.
   */
  rest(): CrashCluster | null {
    const ev = this.ev;
    let out: CrashCluster | null = null;
    for (let i = 0; i < this.n; i++) {
      const o = i * EV;
      if (ev[o + IN] !== 0) continue;
      out ??= new CrashCluster();
      out.put(ev[o + K], ev[o + T], ev[o + A], ev[o + B], ev[o + CLOSING], ev[o + ENERGY], ev[o + X], ev[o + Y], ev[o + Z], ev[o + VA], ev[o + VB]);
    }
    return out;
  }

  /** The scope's impacts in time order, the strongest `MAX_HITS` when it holds more. */
  hits(): ScopeHit[] {
    const ev = this.ev;
    const out: ScopeHit[] = [];
    for (let i = 0; i < this.n; i++) {
      const o = i * EV;
      if (ev[o + IN] !== 0 && ev[o + K] === IMPACT) out.push({ t: ev[o + T], x: ev[o + X], y: ev[o + Y], z: ev[o + Z], a: ev[o + A], b: ev[o + B], closing: ev[o + CLOSING] });
    }
    out.sort((p, q) => p.t - q.t);
    while (out.length > MAX_HITS) {
      let weakest = 0;
      for (let k = 1; k < out.length; k++) if (out[k]!.closing < out[weakest]!.closing) weakest = k;
      out.splice(weakest, 1);
    }
    return out;
  }

  /** Whether the throw of car `i`'s driver at race second `t` is one of the scope's (its `ejects`). */
  owns(i: number, t: number): boolean {
    const ev = this.ev;
    for (let k = 0; k < this.n; k++) {
      const o = k * EV;
      if (ev[o + IN] !== 0 && ev[o + K] === EJECT && ev[o + A] === i && ev[o + T] === t) return true;
    }
    return false;
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

  /** The open cluster an impact at (x, z) between `a` and `b` (−1: no car) joins, or null: the cluster whose scope takes it (`CrashCluster.takes`), the one joinability rule (impact, kill, eject, and the recorder's guard on a bystander's death). */
  joins(t: number, a: number, b: number, x: number, z: number): CrashCluster | null {
    for (const c of this.open) {
      if (t - c.last > QUIET_GAP || t - c.first > MAX_SPAN) continue;
      if (c.takes(a, b, x, z)) return c;
    }
    return null;
  }

  /** An impact at (x, y, z) (the cars driving at `va` and `vb` m/s); returns its cluster. */
  impact(t: number, a: number, b: number, closing: number, energy: number, x: number, y: number, z: number, va: number, vb: number): CrashCluster {
    let c = this.joins(t, a, b, x, z);
    if (!c) {
      c = new CrashCluster();
      this.open.push(c);
    }
    c.add(t, a, b, closing, energy, x, y, z, va, vb);
    return c;
  }

  /** Car `i`'s engine died at (x, z): it joins (or opens) a cluster like an impact. */
  kill(t: number, i: number, x: number, z: number): CrashCluster {
    let c = this.joins(t, i, -1, x, z);
    if (!c) {
      c = new CrashCluster();
      this.open.push(c);
    }
    c.kill(t, i, x, z);
    return c;
  }

  /** Car `i`'s driver was thrown out at (x, z): it joins (or opens) a cluster like an impact. */
  eject(t: number, i: number, x: number, z: number): CrashCluster {
    let c = this.joins(t, i, -1, x, z);
    if (!c) {
      c = new CrashCluster();
      this.open.push(c);
    }
    c.eject(t, i, x, z);
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

/**
 * Per car per step: throttle i8, steer i8 (1/127 steps, as a netplay peer's input), brake u8 (0–255), flags u8 (1 ebrake, 2 boost,
 * 4 drafting, 8 neutral: a thrown-out driver's freewheel). Exactly the pedals the sim ran: `applyDrive` puts them on this grid.
 */
export const INPUT_BYTES = 4;
/**
 * Doubles of course memory per car in a keyframe: where the race's wall contact last stood (x, z), how far past a wall
 * line it stood (m), and the road segment its projection hint is on (-1: none), as `RaceField` keeps them.
 */
export const MEMORY = 4;

export type ReelCar = { slot: number; style: CarStyleId; cls: VehicleClassId; name: string };

/** Most props a clip lists as knocked by cars it leaves out (the recorder remembers no more knocks than this, and a decoder takes no more). */
export const MAX_KNOCKS = 256;

/**
 * A driver thrown out during a clip: the step he left in (counted from the clip's first step) and the event, its `car` a clip
 * car index. `own`: the throw is in the clip's scope (`SCOPE_R`): the reel holds its slow-mo for him and rides along; another
 * crash's throw in the clip's steps flies as recorded and is neither.
 */
export type ClipEjection = { step: number; e: Ejection; own: boolean };

/** One impact of a clip's scope: when (seconds from the clip's start), where, and between which clip cars (−1: a wall or a prop). */
export type ClipHit = { t: number; x: number; y: number; z: number; a: number; b: number };

/** A prop (the course's placed props, by index) a car the clip does not carry knocked off its spot in the step `step` (counted from the clip's first step). */
export type ClipKnock = { step: number; prop: number };

/** One highlight: initial conditions, every step's dt and drive outputs, and the steps a car was put on a spot. */
export type HighlightClip = {
  trackId: string;
  score: number;
  impacts: number;
  kills: number;
  /** Drivers thrown out inside the clip's cluster: its title, and the reel's flight shot follows `ejections`. */
  ejects: number;
  /** Cars the clip's cluster involved (impacts, a kill, a throw): `cars` also holds bystanders, so the title counts these. */
  hit: number;
  /** Every ejection during the clip's steps, in step order (cars the clip carries only). */
  ejections: ClipEjection[];
  /**
   * The props knocked off their spot during the clip by cars it leaves out, in step order. A knocked prop is gone for every
   * car: a clip car that reaches its place finds nothing there in the record, and would hit it standing in a replay that
   * did not knock it. Knocks by the clip's own cars are not listed: the replay does them itself. Keyframe 0 holds the props knocked before the clip.
   */
  knocks: ClipKnock[];
  /** Strongest closing speed (km/h) in the clip's scope: the flash a replayed hit throws. */
  peakKph: number;
  /** The main car's own speed (km/h) in its strongest impact (a wall hit's speed into the wall): the title's speed. */
  hitKph: number;
  /**
   * Aggregate deformation (m) the score counts `DEFORM_POINTS` per metre of: each car of the clip's scope's cages summed, each
   * cage's rise in frame strain (`DeformState.cageStrain`: the largest change of a corner-to-corner distance of a panel frame)
   * from the car joining the crash to the most it reached.
   */
  deform: number;
  /** The scope's impacts in time order, at most `MAX_HITS`: what the reel's camera keeps in view. */
  hits: ClipHit[];
  /** Race-clock seconds of the clip's first step. */
  t0: number;
  /** Seconds from the clip's start: first and last impact. */
  firstImpact: number;
  lastImpact: number;
  /** The step the first impact came in (counted from the clip's first step). */
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
  /** The race's driver-look seed (`driverLook`): every peer, and a clip saved for another day, replays the same tees, hair and women. */
  look: number;
  cars: ReelCar[];
  /** Per step: dt (s), exactly as the recorder's ring (float32) and the live step had it. */
  h: Float32Array;
  /**
   * Per step: the schedule the live world ran it on (`World.shape`: slices and each slice's SAT passes). Every car in
   * the world sets it, the ones outside the clip too (a pair hit anywhere keeps the passes going), so the replay runs it as recorded.
   */
  shape: Uint32Array;
  /** Per step × car: `INPUT_BYTES`. */
  inputs: Uint8Array;
  /**
   * Per keyframe: the step it applies at (before that step's drive). Keyframe 0 is step 0, the clip's start; any other is
   * a step some of the clip's cars were put on a spot in (a respawn, a police wake or put-away: `DeformableCar.placements`),
   * which the replay cannot drive there.
   */
  keyStep: Uint32Array;
  /** Per keyframe: a mask of the clip cars (bit j: `cars[j]`) it carries. Keyframe 0 carries them all, a later one the cars placed in its step. */
  keyCars: Uint32Array;
  /**
   * Per keyframe: its cars as a netplay snapshot message (`net/codec.ts` `writeSnapshot`, `cars` order; a wreck carries its
   * wreck section), then the course's knocked props (u16 byte count, a bit per prop), then per car its flight block, its
   * course memory (`MEMORY` doubles) and its solver state (`CrashRecorder.encodeKey`).
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

/** HUD line for a clip: "Driver thrown out", "4-car pile-up", "Engine destroyed", "52 km/h smash" (the main car's own speed into it). Counts the cars in the clip's scope, not the bystanders the clip also carries. */
export function clipTitle(c: Pick<HighlightClip, "hit" | "kills" | "ejects" | "hitKph">): string {
  if (c.ejects > 0) return c.ejects > 1 ? `${c.ejects} drivers thrown out` : "Driver thrown out";
  if (c.hit >= 3) return `${c.hit}-car pile-up`;
  if (c.kills > 0) return c.kills > 1 ? `${c.kills} engines destroyed` : "Engine destroyed";
  if (c.hit === 2) return `${Math.round(c.hitKph)} km/h smash`;
  return `Wall hit, ${Math.round(c.hitKph)} km/h`;
}
