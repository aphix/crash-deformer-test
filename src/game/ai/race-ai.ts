import { hypot2, detSin, detCos } from "../kernel/physics-core.js";
import { chargeBoost, idleDrive, topUpBoost, type DriveInput } from "../vehicle/car-drive.ts";
import { mood } from "./ai-aggression.ts";
import { GUARD_BRAKE_IDX, GUARD_COUNT, GUARD_LEAD_IDX, GUARD_TURN_IDX } from "./constants.ts";
import { guardContact } from "./contact-guard.ts";
import { DERBY_RULES, STUCK_SPEED, type AiCar } from "./derby-ai.ts";
import { personality, type Personality } from "./personality.ts";
import { MAX_CARS } from "../scenes/fleet.ts";
import { SURFACE_IDS, SURFACES, type Surface } from "../world/catalog.ts";
import { blankPoint, blankProjection, pointOn, projectPath, type Track, type TrackPath, type TrackPoint } from "../world/track.ts";
import { classStats, cornerSpeed, type ClassStats } from "../vehicle/vehicle-classes.ts";
import { clamp, hash01, wrapPi } from "../kernel/scalar.ts";

/** Steering authority on a surface: `applyDrive` scales the yaw rate by this (front-axle grip). */
export function steerGrip(grip: number): number {
  return 0.45 + 0.55 * grip;
}

/** A car's drive input on `surf`: forward throttle × the surface's top-speed share (grip itself is `applyDrive`'s, per axle). */
export function onSurface(input: DriveInput, surf: Surface, out: DriveInput): DriveInput {
  out.throttle = input.throttle > 0 ? input.throttle * surf.speed : input.throttle;
  out.steer = input.steer;
  out.brake = input.brake;
  out.ebrake = input.ebrake;
  out.boost = input.boost;
  out.neutral = input.neutral;
  return out;
}

/** Corner margin: plan every turn as if this share of its radius, so a car keeps this share of its class's
 *  full-lock yaw rate and lateral grip in hand. */
const CORNER_MARGIN = 0.8;
/** Planned braking: this share of the car's class brake. */
const PLAN_BRAKE = 0.5;
/** The guard counts on this share of the class brake: a steered or locked car sheds less of it than `applyDrive` asks (a hit at 0.9 came from braking at the limit). */
const GUARD_BRAKE = 0.72;
/** Look this far (m) ahead for traffic. */
const SCAN = 18;
/** `SCAN`, `GAP_KEEP` and `HUNT` hold at up to this speed (m/s), the field's pace they were tuned at, and stretch with speed above it. */
const PACE = 18;
/** Two cars closer than this sideways (m) share a line. */
const LINE_W = 2.4;
/** Lateral room (m) kept between the planned line and the road edge. */
const EDGE = 1.4;
/** Lane change rate (m/s). */
const LANE_RATE = 3.2;
/** A shortcut is chosen this far (m) before its mouth. */
const COMMIT = 45;
/** A boost burst starts only with at least this much meter (no stutter on the dregs). */
const BURST_MIN = 0.5;
/** A burst runs while the plan at the boosted top wants this much (m/s) more than the car has: boost pulls harder (and past top by `boostTop`). */
const BOOST_SHORT = 2;
/** Pursuit look-ahead (m) at speed; a junction's turn is planned as spread over it. */
const LOOK = 18;
/** An aggressive driver hunts a rival up to this far (m) ahead within this far sideways. */
const HUNT = 25;
const HUNT_SIDE = 5;
/** A hunter with more fight than this comes up offset from its rival (a PIT tap at its rear quarter, then door to door) instead of pushing it from behind. */
const PIT_FIGHT = 0.3;
/** Lateral offset (m) from the rival's centre for a PIT tap: about half a car's width of overlap. */
const PIT_OFFSET = 1;
/** A car on our line closer than this (m, centre to centre) is in the way even at our own pace. */
const GAP_KEEP = 9;
/** Centre-to-centre distance (m) a passing car closes to behind the car it is going round, until clear sideways. */
const PASS_NOSE = 7;
/** A car with a racer this near (m) when its shortcut coin is tossed stays on the loop. */
const MOUTH_GAP = 12;
/** Cars this near lengthwise (m, centre to centre) still overlap each other's flanks: their lanes stay a car width apart. */
const ABREAST = 6.5;
/** Least closing speed (m/s) while going round a car, so the pass never stalls behind a parked one. */
const PASS_CREEP = 2;
/** A driver fights only above this speed (m/s), against a rival doing at least 0.6 of it. */
const FIGHT_PACE = 5;
/** The following gap is kept only behind a car doing at least this (m/s): two stopped cars waited on each other for 40 s. */
const CRAWL = 3;
/** A driver with this much aggression or less takes only a shove that is safe (`RaceBrain.safeShove`); above it `mood` alone decides. */
const CAREFUL = 0.5;
/** What a safe shove adds to a careful driver's mood, a quarter of the most a driver wants a fight: aggression 0.5 shoves a safe one, under 0.375 never fights. */
const SAFE_SHOVE = 0.25;
/** A shove is safe at a closing speed under this (m/s, the derby's hit speed: a nudge, not a ram), ... */
const SHOVE_SPEED = DERBY_RULES.hitSpeed;
/** A careful driver's shove swings its lane over at no more than this (m/s), so two of them shoving each other close sideways at under `SHOVE_SPEED`. */
const SHOVE_LAT = 0.5;
/** ... and with this much road (m) beyond the rival on the side it is pushed to. */
const WALL_ROOM = 2.5;
/**
 * Slots of `RaceBrain.args`: the scalars `think` hands to the calls it makes per car per step (`line`, `plan`, `pickRoute`,
 * `upcoming`, `pointAhead`, `charge`). A number passed to a call V8 does not inline is boxed on the heap; a slot the caller
 * writes and the callee reads is not.
 */
const ARG_S_IDX = 0; // arc length (m) along the route being driven
const ARG_HALF_IDX = 1; // its half width (m) here
const ARG_LAT_IDX = 2; // the car's lateral offset (m) from its line
const ARG_FX_IDX = 3; // the car's heading, unit vector
const ARG_FZ_IDX = 4;
const ARG_ALONG_IDX = 5; // its speed along it (m/s)
const ARG_SPEED_IDX = 6; // its speed (m/s)
const ARG_TOP_IDX = 7; // the top speed (m/s) `plan` works up to
const ARG_MAIN_S_IDX = 8; // arc length (m) along the main loop
const ARG_AHEAD_IDX = 9; // arc length (m) of the point `pointAhead` returns
const ARG_DT_IDX = 10; // the step (s)
const ARG_COUNT = 11;

function surfaceAt(path: TrackPath, k: number): Surface {
  return SURFACES[SURFACE_IDS[path.surface[k]!]!];
}

function sampleAt(path: TrackPath, s: number): number {
  const segs = path.closed ? path.count : path.count - 1;
  const u = Math.floor((s / path.length) * segs);
  return path.closed ? ((u % path.count) + path.count) % path.count : clamp(u, 0, path.count - 1);
}

/** Gravity (m/s²) and the half-span (m) a crest's vertical curvature is read over. */
const G = 9.6;
const CREST_SPAN = 6;

/**
 * Highest speed (m/s) a car stays planted over the road `s` m along `path`: over a crest of vertical curvature κ
 * the road falls away faster than gravity pulls the car down above √(g/κ), and an airborne car can neither steer
 * nor brake for the bend after it. Infinity in a dip or on the level.
 */
export function crestSpeed(path: TrackPath, s: number): number {
  const y = path.y;
  const k = (y[sampleAt(path, s - CREST_SPAN)]! - 2 * y[sampleAt(path, s)]! + y[sampleAt(path, s + CREST_SPAN)]!) / (CREST_SPAN * CREST_SPAN);
  return k < -1e-4 ? Math.sqrt(G / -k) : Infinity;
}

/** What the brain needs from the race rules about one car. */
type RaceAiState = {
  /** Next main checkpoint (`CarRecord.next`). */
  next: number;
  /** Completed laps. */
  lap: number;
};

/**
 * Racing driver for one course, memory per car id. Built on `DerbyBrain`'s personality hash,
 * `AiCar` snapshots and unstick idea:
 *  L0 unstick: throttle held without motion → reverse with the nose swinging toward the line
 *  L1 route: the main loop, or a designed shortcut taken on a seeded per-lap coin
 *  L2 line: inside of the next turn plus a personal offset; a slower car ahead on our line → pass on
 *     the side with room, else follow its speed. Rivals by `mood` (ai-aggression.ts): its positive
 *     part, `fight`, scales every contact move, so a field's contact grows with its aggression; its
 *     negative part, `shy`, keeps a clean driver off other cars. Fight: ram a slower rival ahead on
 *     our line, late-block a rival coming through, shove a rival alongside door to door, hunt a
 *     rival up to `HUNT` m (× pace) ahead (onto its line to push it, or a PIT tap at its rear quarter)
 *     and boost to catch it. Aggression 0: shy only, clean racing. Up to 0.5 (`CAREFUL`) a driver fights only a rival it
 *     can shove safely (`safeShove`: a nudge's closing speed, road beyond it, off a crest), swinging over gently (`SHOVE_LAT`).
 *  L3 drive: pure pursuit to a point ahead on the line; speed from the class's corner speed for the
 *     curvature, grip and shortcut junctions ahead under a braking budget. Boost on a clear run while
 *     the plan at the boosted top wants more speed, from a meter that drains and refills like the
 *     player's seat (`BOOST`).
 *  L4 guard (`contact-guard.ts`): of every car it is closing on except the ones it means to hit (fight > 0), the
 *     soonest contact within 1.5 s is steered clear of and braked for, so a clean driver (aggression 0)
 *     starts no contact (`race-contact.test.ts`) and a hungrier one hits only the rivals its mood sends it after.
 * Deterministic (no clock, no Math.random); no allocation per call.
 */
export class RaceBrain {
  readonly track: Track;
  /** Ids below this are racers; the rest (traffic) are only avoided. */
  racers: number;
  /** Ids below this are the cars a racer keeps clear of (`guardContact`): the racers and the traffic; police past it hit on purpose. */
  guarded: number;
  private readonly out: DriveInput = idleDrive();
  private readonly traits: Personality[] = [];
  private readonly aggression = new Float64Array(MAX_CARS);
  /** Per car: class figures (sedan until `setClass`). */
  private readonly cls: ClassStats[] = Array.from({ length: MAX_CARS }, () => classStats("sedan"));
  /** Boost meter per car, 0–1 (the HUD reads it), and whether a burst is running (it runs on to empty). */
  readonly meter = new Float64Array(MAX_CARS);
  private readonly burst = new Uint8Array(MAX_CARS);
  private readonly seg = new Int32Array(MAX_CARS);
  private readonly route = new Int16Array(MAX_CARS);
  private readonly routeSeg = new Int32Array(MAX_CARS);
  /** Last `lap * 8 + shortcut` the shortcut coin was tossed for. */
  private readonly tossed = new Int32Array(MAX_CARS);
  private readonly lane = new Float64Array(MAX_CARS);
  private readonly stuck = new Float64Array(MAX_CARS);
  private readonly recover = new Float64Array(MAX_CARS);
  private readonly recoverSteer = new Float64Array(MAX_CARS);
  private readonly lastThrottle = new Float64Array(MAX_CARS);
  private readonly mainProj = blankProjection();
  private readonly subProj = blankProjection();
  private readonly args = new Float64Array(ARG_COUNT);
  /** The tune `guardContact` reads (`GUARD_*_IDX`). */
  private readonly guard = new Float64Array(GUARD_COUNT);
  private readonly pt: TrackPoint = blankPoint();
  /** Speed of the car we are boxed in behind this call, NaN when the way is clear. */
  private follow = Number.NaN;
  /** Fight (0–1) of a shove or block this call: the lane swings over faster by this much. */
  private swerve = 0;
  /** This call: a careful driver is shoving a rival, so its lane moves at no more than `SHOVE_LAT`. */
  private nudge = false;
  /** Fight (0–1) toward the rival being hunted or rammed this call, 0 when none. */
  private chase = 0;
  /** Per car id, this call: 1 for a rival this driver is fighting (the contact guard leaves it alone), else 0. */
  private readonly hit = new Uint8Array(MAX_CARS);
  /** This call: the shortcut being turned into (−1 none), the distance (m) to its mouth while short of it, and the turn (rad) still to make onto it. */
  private entry = -1;
  private lead = 0;
  private turnIn = 0;
  /** Main-loop arc length of each shortcut's mouth and end. */
  private readonly mouthS: number[];
  private readonly exitS: number[];
  /** Each shortcut's heading at its mouth, the turn (rad) onto it from the main loop there, and from its end back onto the loop. */
  private readonly mouthYaw: number[];
  private readonly mouthTurn: number[];
  private readonly exitTurn: number[];

  constructor(track: Track, racers: number) {
    this.track = track;
    this.racers = racers;
    this.guarded = racers;
    for (let i = 0; i < MAX_CARS; i++) this.traits.push(personality(i));
    const p = blankProjection();
    this.mouthS = track.shortcuts.map((sc) => projectPath(track.path, sc.path.x[0]!, sc.path.z[0]!, -1, p).s);
    this.exitS = track.shortcuts.map((sc) => {
      const e = sc.path.count - 1;
      return projectPath(track.path, sc.path.x[e]!, sc.path.z[e]!, -1, p).s;
    });
    this.mouthYaw = track.shortcuts.map((sc) => Math.atan2(sc.path.x[1]! - sc.path.x[0]!, sc.path.z[1]! - sc.path.z[0]!));
    this.mouthTurn = track.shortcuts.map((_, k) => {
      const at = track.pointAt(this.mouthS[k]!, this.pt);
      return Math.abs(wrapPi(this.mouthYaw[k]! - Math.atan2(at.tx, at.tz)));
    });
    this.exitTurn = track.shortcuts.map((sc, k) => {
      const e = sc.path.count - 1;
      const back = track.pointAt(this.exitS[k]!, this.pt);
      return Math.abs(wrapPi(Math.atan2(back.tx, back.tz) - Math.atan2(sc.path.x[e]! - sc.path.x[e - 1]!, sc.path.z[e]! - sc.path.z[e - 1]!)));
    });
    this.reset();
  }

  reset(): void {
    this.seg.fill(-1);
    this.route.fill(-1);
    this.routeSeg.fill(-1);
    this.tossed.fill(-1);
    this.lane.fill(0);
    this.stuck.fill(0);
    this.recover.fill(0);
    this.recoverSteer.fill(0);
    this.lastThrottle.fill(0);
    this.meter.fill(1);
    this.burst.fill(0);
  }

  /** 0 avoids every hit … 1 rams regardless of its own state (see `mood`). */
  setAggression(id: number, a: number): void {
    this.aggression[id] = clamp(a, 0, 1);
  }

  /** The car's class figures, so lines and braking points fit what it can do. */
  setClass(id: number, s: ClassStats): void {
    this.cls[id] = s;
  }

  /** Forget a car's route, line and recovery (after a respawn teleport). */
  respawned(id: number): void {
    this.seg[id] = -1;
    this.route[id] = -1;
    this.routeSeg[id] = -1;
    this.lane[id] = 0;
    this.stuck[id] = 0;
    this.recover[id] = 0;
  }

  /** One decision for `self` (scratch output: apply it before the next call). */
  think(self: AiCar, others: readonly AiCar[], race: RaceAiState, dt: number): DriveInput {
    const out = this.out;
    out.throttle = 0;
    out.steer = 0;
    out.brake = 0;
    out.ebrake = false;
    out.boost = false;
    const i = self.id;
    if (i < 0 || i >= MAX_CARS || !self.alive) return out;
    const p = this.traits[i]!;
    const speed = hypot2(self.vx, self.vz);
    const a = this.args;
    a[ARG_DT_IDX] = dt;

    if (this.recover[i]! > 0) {
      this.recover[i]! -= dt;
      out.throttle = -0.9;
      out.steer = this.recoverSteer[i]!;
      this.lastThrottle[i] = 0;
      this.charge(i, false);
      return out;
    }

    const tr = this.track;
    const fresh = this.seg[i] === -1;
    const main = projectPath(tr.path, self.x, self.z, this.seg[i]!, this.mainProj);
    this.seg[i] = main.k;
    // First look (race start, respawn): the line starts where the car is, no swerve to the middle.
    if (fresh) this.lane[i] = clamp(main.lateral, -tr.path.half[main.k]!, tr.path.half[main.k]!);
    a[ARG_MAIN_S_IDX] = main.s;
    this.pickRoute(i, race, self, others);

    let route = this.route[i]!;
    let proj = main;
    let path: TrackPath = tr.path;
    if (route >= 0) {
      const sc = tr.shortcuts[route]!;
      const sub = projectPath(sc.path, self.x, self.z, this.routeSeg[i]!, this.subProj);
      this.routeSeg[i] = sub.k;
      if (sub.s >= sc.path.length - 0.5) {
        this.route[i] = -1;
        this.routeSeg[i] = -1;
        route = -1;
      } else {
        proj = sub;
        path = sc.path;
      }
    }

    const k = proj.k;
    const surf = surfaceAt(path, k);
    const turnMax = this.cls[i]!.turn * (0.35 + 0.65 * Math.min(1, speed / 8)) * steerGrip(surf.grip);
    const fx = detSin(self.yaw);
    const fz = detCos(self.yaw);
    const along = self.vx * fx + self.vz * fz;

    // L2: the line. A shortcut is narrow, drive its middle: only the following gap (`follow`) applies there.
    this.follow = Number.NaN;
    this.chase = 0;
    this.swerve = 0;
    this.nudge = false;
    a[ARG_S_IDX] = proj.s;
    a[ARG_HALF_IDX] = path.half[k]!;
    a[ARG_LAT_IDX] = proj.lateral;
    a[ARG_FX_IDX] = fx;
    a[ARG_FZ_IDX] = fz;
    a[ARG_ALONG_IDX] = along;
    const wanted = this.line(self, p, others);
    const want = route < 0 ? wanted : 0;
    const step = (this.nudge ? SHOVE_LAT : LANE_RATE * (1 + this.swerve)) * dt;
    this.lane[i] = route < 0 ? this.lane[i]! + clamp(want - this.lane[i]!, -step, step) : 0;
    const lane = this.lane[i]!;

    // L3: pursue a point on the line.
    const ld = clamp(5 + 0.5 * speed, 7, LOOK);
    // Short of a shortcut's mouth: head for the mouth itself so the car goes through its gate.
    const toMouth = route >= 0 ? hypot2(self.x - path.x[0]!, self.z - path.z[0]!) : 0;
    const early = route >= 0 && proj.s < 0.5 && toMouth > 4;
    // Onto a shortcut, until a look-ahead into it: the turn still to make onto its heading, from the
    // car's heading and (short of the mouth, `lead` m on) from the run in to the mouth. On the loop:
    // the next mouth this lap's coin will take, planned before the coin is tossed.
    this.entry = route;
    this.lead = early ? toMouth : 0;
    this.turnIn = route >= 0 && proj.s < LOOK ? Math.abs(wrapPi(this.mouthYaw[route]! - self.yaw)) : 0;
    if (early) this.turnIn = Math.max(this.turnIn, Math.abs(wrapPi(this.mouthYaw[route]! - Math.atan2(path.x[0]! - self.x, path.z[0]! - self.z))));
    if (route < 0) this.upcoming(i, race);
    a[ARG_AHEAD_IDX] = early ? 2 : proj.s + ld;
    const pt = this.pointAhead(path, route);
    const tx = pt.x + pt.tz * lane;
    const tz = pt.z - pt.tx * lane;
    const alpha = wrapPi(Math.atan2(tx - self.x, tz - self.z) - self.yaw);
    const reach = early ? Math.max(4, hypot2(tx - self.x, tz - self.z)) : ld;
    const omega = (2 * Math.max(speed, 4) * detSin(alpha)) / reach;
    out.steer = clamp(omega / Math.max(0.2, turnMax), -1, 1);

    const cls = this.cls[i]!;
    const top = cls.topSpeed;
    a[ARG_SPEED_IDX] = speed;
    a[ARG_TOP_IDX] = top;
    let target = this.plan(i, path, route);
    // Boxed in, passing or keeping a gap sets `follow`; otherwise a clear run (or a hunted rival to
    // catch) boosts while the plan at the boosted top wants more speed than the car has.
    if (!Number.isNaN(this.follow)) target = Math.min(target, Math.max(0, this.follow - 0.5));
    else if (this.meter[i]! > (this.burst[i] ? 0.02 : BURST_MIN) && Math.abs(alpha) < (this.chase > 0 ? 0.45 : 0.3)) {
      a[ARG_TOP_IDX] = top * cls.boostTop;
      const boosted = this.plan(i, path, route);
      if (boosted > along + BOOST_SHORT) {
        out.boost = true;
        target = boosted;
      }
    }
    // Off the road, a pursuit asking for more than full lock is a corner the plan does not see: the car (pushed wide, off the
    // road) slows to what it can turn back onto the line at, instead of holding the road's plan at full lock while it runs on out.
    if (Math.abs(proj.lateral) > path.half[k]! && Math.abs(omega) > turnMax) {
      const arc = cornerSpeed(cls, reach / (2 * Math.abs(detSin(alpha))), surf.grip);
      if (arc < target) {
        target = arc;
        out.boost = false;
      }
    }
    const err = target - along;
    if (Math.abs(alpha) > 1.9 && speed < 6) {
      // Facing the wrong way: full lock and crawl round.
      out.throttle = 0.6;
      out.steer = Math.sign(alpha) || p.side;
    } else if (err >= -1.5) {
      // `applyDrive` runs up to throttle × top at the class's full rate, so ask for the target
      // itself (a throttle proportional to the error would settle ~10% short of it).
      out.throttle = clamp(target / (top * surf.speed * (out.boost ? cls.boostTop : 1)), err > 0.4 ? 0.35 : 0, 1);
    } else {
      out.brake = clamp(-err / 6, 0.2, 1);
    }

    // Last rule, for a racer (police drive this line too and hit on purpose): no car it is closing on is driven into, except the ones it means to hit (`hit`); a car ahead is taken to brake as the plan does (`PLAN_BRAKE`).
    if (i < this.racers) {
      const g = this.guard;
      g[GUARD_BRAKE_IDX] = cls.brake * GUARD_BRAKE;
      g[GUARD_LEAD_IDX] = cls.brake * PLAN_BRAKE;
      g[GUARD_TURN_IDX] = turnMax;
      guardContact(self, others, this.guarded, this.hit, g, out);
    }

    // L0: wedged against something.
    if (this.lastThrottle[i]! > 0.35 && speed < STUCK_SPEED) this.stuck[i]! += dt;
    else this.stuck[i] = Math.max(0, this.stuck[i]! - dt * 2);
    if (this.stuck[i]! > p.patience + 0.4) {
      this.stuck[i] = 0;
      this.recover[i] = 0.9 + 0.4 * p.patience;
      // Either gear swings the nose the same way in this drive model.
      this.recoverSteer[i] = Math.sign(alpha) || p.side;
      out.throttle = -0.9;
      out.brake = 0;
      out.steer = this.recoverSteer[i]!;
    }
    this.lastThrottle[i] = out.throttle;
    if (out.throttle <= 0) out.boost = false;
    this.charge(i, out.boost);
    return out;
  }

  /** Drain the meter while boosting, refill it otherwise (the seat's rates). */
  private charge(i: number, boosting: boolean): void {
    this.meter[i] = chargeBoost(this.meter[i]!, boosting, this.args[ARG_DT_IDX]!);
    this.burst[i] = boosting ? 1 : 0;
  }

  /** A bonus onto car `i`'s meter (drafting, `DRAFT.bonus`), as `DriverSeat.addBoost` does for the player. */
  addBoost(i: number, amount: number): void {
    this.meter[i] = topUpBoost(this.meter[i]!, amount);
  }

  /** Main loop or a designed shortcut: one seeded coin per car, lap and shortcut. */
  private pickRoute(i: number, race: RaceAiState, self: AiCar, others: readonly AiCar[]): void {
    if (this.route[i]! >= 0) return;
    const mainS = this.args[ARG_MAIN_S_IDX]!;
    const tr = this.track;
    const n = tr.gates.length;
    for (let k = 0; k < tr.shortcuts.length; k++) {
      if ((tr.shortcuts[k]!.from + 1) % n !== race.next) continue;
      let ahead = this.mouthS[k]! - mainS;
      if (ahead < -tr.length * 0.5) ahead += tr.length;
      if (ahead < 0 || ahead > COMMIT) continue;
      const key = race.lap * 8 + k;
      if (this.tossed[i] === key) continue;
      this.tossed[i] = key;
      if (this.takes(i, race.lap, k) && !this.crowded(k, self, others)) {
        this.route[i] = k;
        this.routeSeg[i] = -1;
      }
      return;
    }
  }

  /** A racer already on shortcut `k` within `MOUTH_GAP` m of `self`: the narrow mouth takes one car at a time, the next stays on the loop. */
  private crowded(k: number, self: AiCar, others: readonly AiCar[]): boolean {
    for (let n = 0; n < others.length; n++) {
      const o = others[n]!;
      if (o.id !== self.id && o.id < this.racers && hypot2(o.x - self.x, o.z - self.z) < MOUTH_GAP) return true;
    }
    return false;
  }

  /** The car's seeded coin for shortcut `k` on lap `lap`: heads (take it) 0.3 + 0.4 × aggression of the time. */
  private takes(i: number, lap: number, k: number): boolean {
    return hash01(i * 31 + lap, 13 + k) < 0.3 + 0.4 * this.aggression[i]!;
  }

  /**
   * Before the coin is tossed (just past the shortcut's from-gate, as little as 10 m short of its mouth):
   * the next mouth ahead this lap's coin will take, as `entry`, `lead` and `turnIn`.
   */
  private upcoming(i: number, race: RaceAiState): void {
    const mainS = this.args[ARG_MAIN_S_IDX]!;
    const tr = this.track;
    const n = tr.gates.length;
    for (let k = 0; k < tr.shortcuts.length; k++) {
      const from = tr.shortcuts[k]!.from;
      if (from !== race.next && (from + 1) % n !== race.next) continue;
      let ahead = this.mouthS[k]! - mainS;
      if (ahead < -tr.length * 0.5) ahead += tr.length;
      // A from-gate on the line is crossed into the next lap, so the coin is tossed for that lap.
      const lap = from === 0 && race.next === 0 ? race.lap + 1 : race.lap;
      if (ahead < 0 || this.tossed[i] === lap * 8 + k || !this.takes(i, lap, k)) continue;
      this.entry = k;
      this.lead = ahead;
      this.turnIn = this.mouthTurn[k]!;
      return;
    }
  }

  /** Point `s` m along the route being driven, running on into the main loop past a shortcut's end. */
  private pointAhead(path: TrackPath, route: number): TrackPoint {
    const s = this.args[ARG_AHEAD_IDX]!;
    if (route < 0) return this.track.pointAt(s, this.pt);
    if (s <= path.length) return pointOn(path, s, this.pt);
    return this.track.pointAt(this.exitS[route]! + (s - path.length), this.pt);
  }

  /** Highest speed now (up to `top`) that still makes every turn ahead within the braking budget. */
  private plan(i: number, path: TrackPath, route: number): number {
    const a = this.args;
    const s = a[ARG_S_IDX]!;
    const speed = a[ARG_SPEED_IDX]!;
    const top = a[ARG_TOP_IDX]!;
    const tr = this.track;
    const cls = this.cls[i]!;
    const decel = cls.brake * PLAN_BRAKE;
    let best = top;
    // A shortcut meets the loop at an angle neither path's curvature shows: the turn into its mouth
    // and the one back onto the loop at its end are corners too.
    if (this.entry >= 0) best = Math.min(best, this.junction(cls, this.turnIn, surfaceAt(tr.shortcuts[this.entry]!.path, 0), this.lead, decel));
    if (route >= 0) best = Math.min(best, this.junction(cls, this.exitTurn[route]!, surfaceAt(path, path.count - 1), this.lead + path.length - s, decel));
    const reach = (speed * speed) / (2 * decel) + 12;
    for (let d = 0; d <= reach; d += 3) {
      let pp = path;
      let ss = s + d;
      if (route >= 0 && ss > path.length) {
        pp = tr.path;
        ss = this.exitS[route]! + (ss - path.length);
      }
      const k = sampleAt(pp, ss);
      const surf = surfaceAt(pp, k);
      const curv = Math.abs(pp.curv[k]!);
      // `cornerSpeed`: the class's top, its lateral grip and its full-lock yaw on this surface at `HANDLING.realism`.
      // The AI lifts over a crest it would fly, like a driver over a blind crest (`crestSpeed`).
      const corner = Math.min(top * surf.speed, curv > 1e-4 ? cornerSpeed(cls, CORNER_MARGIN / curv, surf.grip) : Infinity, crestSpeed(pp, ss));
      const allow = Math.sqrt(corner * corner + 2 * decel * d);
      if (allow < best) best = allow;
    }
    return best;
  }

  /** Speed now that still makes a `turn` (rad) junction `d` m on, the turn spread over the pursuit's look-ahead. */
  private junction(cls: ClassStats, turn: number, surf: Surface, d: number, decel: number): number {
    if (turn < 0.05) return Infinity;
    const corner = cornerSpeed(cls, (CORNER_MARGIN * LOOK) / turn, surf.grip);
    return Math.sqrt(corner * corner + 2 * decel * d);
  }

  /**
   * Whether shoving the car `ahead` m on and `side` m to the left (its lateral `oLat`) is safe: a shove, not a ram (the two cars' speeds along the road,
   * with the sideways speed they close at, come to less than `SHOVE_SPEED`), with `WALL_ROOM` m of road beyond it on the side it is pushed to, and not over a crest.
   */
  private safeShove(s: number, half: number, oLat: number, side: number, ahead: number, along: number, oAlong: number): boolean {
    // The rival may be shoving too, so the sideways closing counts twice.
    if (hypot2(along - oAlong, 2 * SHOVE_LAT) >= SHOVE_SPEED) return false;
    if (half - (side >= 0 ? oLat : -oLat) < WALL_ROOM) return false;
    return crestSpeed(this.track.path, s + ahead) > Math.max(along, oAlong);
  }

  /** Lateral target (m, + = left of travel) on the main loop; sets `follow` when boxed in. */
  private line(self: AiCar, p: Personality, others: readonly AiCar[]): number {
    const a = this.args;
    const s = a[ARG_S_IDX]!;
    const half = a[ARG_HALF_IDX]!;
    const lat = a[ARG_LAT_IDX]!;
    const fx = a[ARG_FX_IDX]!;
    const fz = a[ARG_FZ_IDX]!;
    const along = a[ARG_ALONG_IDX]!;
    const i = self.id;
    const tr = this.track;
    const room = Math.max(0, half - EDGE);
    // Traffic distances below were tuned at `PACE`; faster, they stretch with speed (the same time ahead).
    const pace = Math.max(1, along / PACE);
    let curv = 0;
    // Closest car on our line inside its following gap at our own pace (not a pass, just room kept).
    let keep = -1;
    let keepAhead = Infinity;
    let keepAlong = 0;
    let keepGap = GAP_KEEP * pace;
    for (let d = 10; d <= 34; d += 6) curv += tr.path.curv[sampleAt(tr.path, s + d)]!;
    curv /= 5;
    let want = clamp(Math.sign(curv) * Math.min(1, Math.abs(curv) * 30) * half * 0.45 + p.side * 0.8, -room, room);
    const aggr = this.aggression[i]!;
    let blocker = -1;
    let blockerAhead = Infinity;
    let blockerSide = 0;
    let blockerAlong = 0;
    let blockerFight = 0;
    let prey = -1;
    let preyAhead = Infinity;
    let preySide = 0;
    let preyFight = 0;
    for (let n = 0; n < others.length; n++) {
      const o = others[n]!;
      if (o.id === i || !o.alive) continue;
      const dx = o.x - self.x;
      const dz = o.z - self.z;
      const ahead = dx * fx + dz * fz;
      // Left of travel = (fz, −fx).
      const side = dx * fz - dz * fx;
      const oAlong = o.vx * fx + o.vz * fz;
      const inWay = Math.abs(side) < LINE_W + 0.4 || Math.abs(lat + side - this.lane[i]!) < LINE_W;
      const rival = o.id < this.racers;
      // Rivals: fight or keep clear by mood (aggression, and both cars' damage); traffic is only avoided.
      // Only at racing pace, both cars rolling on: two hungry cars that met slow or stopped brawled on
      // a wall until both were out of the race.
      const rolling = along > FIGHT_PACE && oAlong > 0.6 * FIGHT_PACE;
      let m = rival ? mood(aggr, self.damage, o.damage) : -1;
      // A careful driver (aggression up to `CAREFUL`) fights only a rival it is on terms with and can shove safely; the others fight by `mood` alone.
      if (rival && rolling && aggr > 0 && aggr <= CAREFUL && m + SAFE_SHOVE > 0) {
        const near = ahead > -11 && ahead < HUNT * pace && Math.abs(side) < HUNT_SIDE;
        m = near && this.safeShove(s, half, lat + side, side, ahead, along, oAlong) ? m + SAFE_SHOVE : Math.min(m, 0);
      }
      const fight = rolling ? clamp(m, 0, 1) : 0;
      const shy = clamp(-m, 0, 1);
      this.hit[o.id] = fight > 0 ? 1 : 0;
      if (fight > 0 && aggr <= CAREFUL) this.nudge = true;
      if (ahead > 0.5 && ahead < SCAN * Math.max(pace, (along - oAlong) / PACE) && inWay) {
        if (along > oAlong + 0.3) {
          // Slower and on our line: pass it, ram it, or follow it.
          if (ahead < blockerAhead) {
            blockerFight = fight;
            blocker = o.id;
            blockerAhead = ahead;
            blockerSide = side;
            blockerAlong = oAlong;
          }
        } else if (fight <= 0 && oAlong >= CRAWL) {
          // At our pace: a clean driver keeps a following gap, a hungrier one a shorter one (boost
          // used to close a clean driver onto a rival's bumper and hold it there for 20 s).
          const gap = GAP_KEEP * pace * (0.4 + 0.6 * shy);
          if (ahead < gap && ahead < keepAhead && Math.abs(side) < LINE_W) {
            keep = o.id;
            keepAhead = ahead;
            keepAlong = oAlong;
            keepGap = gap;
          }
        }
      }
      if (!rival) continue;
      const oLat = lat + side;
      // Both rolling and overlapping lengthwise: the lane keeps a car width off it, on the side it is on (the grid's
      // two files, 4 m stagger, all steered for the middle and met nose to tail there).
      if (rolling && Math.abs(ahead) < ABREAST && Math.abs(side) > 0.7) want = side > 0 ? Math.min(want, oLat - LINE_W - 0.9) : Math.max(want, oLat + LINE_W + 0.9);
      if (ahead < -1 && ahead > -11 && Math.abs(side) < 4.5 && oAlong > along + 0.5) {
        // Coming through from behind: a late block onto its line, or room for it.
        if (fight > 0) {
          want += (oLat - want) * Math.min(1, fight * 1.5);
          this.swerve = Math.max(this.swerve, fight);
        } else want += Math.sign(want - oLat || 1) * shy * 2;
      } else if (Math.abs(ahead) < 4 && Math.abs(side) < 4) {
        // Alongside: a door-to-door shove into it, or shy away.
        if (fight > 0) {
          want += (oLat - want) * Math.min(1, fight * 1.5);
          this.swerve = Math.max(this.swerve, fight);
        } else want -= Math.sign(side) * shy * 1.5;
      } else if (fight > 0 && ahead >= 4 && ahead < preyAhead && ahead < HUNT * pace && Math.abs(side) < HUNT_SIDE) {
        prey = o.id;
        preyAhead = ahead;
        preySide = side;
        preyFight = fight;
      }
    }
    if (prey >= 0) {
      // Hunting a rival ahead: onto its line to push it from behind or, with more fight, offset by
      // `PIT_OFFSET` on the side it already leans to (ours by habit when dead ahead), so the nose
      // catches its rear quarter and the car comes up door to door for the shove.
      const off = preyFight > PIT_FIGHT ? (Math.abs(preySide) > 0.3 ? Math.sign(preySide) : -p.side) * PIT_OFFSET : 0;
      const aim = lat + preySide - off;
      want += (aim - want) * Math.min(1, preyFight * 1.5);
      this.chase = preyFight;
    }
    if (blocker >= 0) {
      const oLat = lat + blockerSide;
      if (blockerFight > 0) {
        // A rival in the way: push it from behind (and boost into it).
        this.chase = blockerFight;
        return clamp(oLat, -room, room);
      }
      // Met head-on (closing at both cars' speed): round it at three times the lane change rate.
      if (blockerAlong < 0) this.swerve = Math.max(this.swerve, 2);
      const left = oLat + LINE_W + 0.9;
      const right = oLat - LINE_W - 0.9;
      const leftOk = left <= room;
      const rightOk = right >= -room;
      if (leftOk && (!rightOk || Math.abs(left - want) <= Math.abs(right - want))) want = left;
      else if (rightOk) want = right;
      if (!leftOk && !rightOk) {
        if (blockerAhead < 10) this.follow = blockerAlong;
      } else if (blockerAlong >= CRAWL && Math.abs(blockerSide) < LINE_W + 0.5) {
        // Passing a moving car but not yet clear of it sideways: close no faster than the gap allows
        // (a pass at boost speed side-swiped the car it was going round), so the nose waits beside its
        // tail. A stopped or crawling car is just driven round (capping speed behind one jammed the city's hairpins).
        this.follow = blockerAlong + 0.5 + clamp((blockerAhead - PASS_NOSE) * 0.8, blockerAhead > PASS_NOSE ? PASS_CREEP : -2, 6);
      }
    } else if (keep >= 0) {
      // Its speed at the gap's edge, slower inside it (`follow` is read 0.5 m/s under).
      this.follow = keepAlong + 0.5 - 0.8 * (keepGap - keepAhead);
    }
    return clamp(want, -room, room);
  }
}
