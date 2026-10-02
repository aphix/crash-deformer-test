import { BOOST, DRIVE, idleDrive, type DriveInput } from "../vehicle/car-drive.ts";
import { mood } from "./ai-aggression.ts";
import { personality, STUCK_SPEED, type AiCar, type Personality } from "./derby-ai.ts";
import { MAX_CARS } from "../scenes/fleet.ts";
import { SURFACE_IDS, SURFACES, type Surface } from "../world/catalog.ts";
import { blankPoint, blankProjection, pointOn, projectPath, type Track, type TrackPath, type TrackPoint } from "../world/track.ts";
import { classStats } from "../vehicle/vehicle-classes.ts";
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
  return out;
}

/** Corner speed margin: plan for this share of the drive model's full-lock yaw rate. */
const CORNER_MARGIN = 0.8;
/** Planned braking: this share of the car's class brake. */
const PLAN_BRAKE = 0.5;
/** Look this far (m) ahead for traffic. */
const SCAN = 18;
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
const PASS_NOSE = 5;
/** Least closing speed (m/s) while going round a car, so the pass never stalls behind a parked one. */
const PASS_CREEP = 2;
/** A driver fights only above this speed (m/s), against a rival doing at least 0.6 of it. */
const FIGHT_PACE = 5;
/** The following gap is kept only behind a car doing at least this (m/s): two stopped cars waited on each other for 40 s. */
const CRAWL = 3;

function surfaceAt(path: TrackPath, k: number): Surface {
  return SURFACES[SURFACE_IDS[path.surface[k]!]!];
}

function sampleAt(path: TrackPath, s: number): number {
  const segs = path.closed ? path.count : path.count - 1;
  const u = Math.floor((s / path.length) * segs);
  return path.closed ? ((u % path.count) + path.count) % path.count : clamp(u, 0, path.count - 1);
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
 *     rival up to `HUNT` m ahead (onto its line to push it, or a PIT tap at its rear quarter) and
 *     boost to catch it. Aggression 0: shy only, clean racing.
 *  L3 drive: pure pursuit to a point ahead on the line; speed from the curvature and grip ahead
 *     under a braking budget. Boost on a clear run where even the boosted speed makes every turn
 *     ahead, from a meter that drains and refills like the player's seat (`BOOST`).
 * Deterministic (no clock, no Math.random); no allocation per call.
 */
export class RaceBrain {
  readonly track: Track;
  /** Ids below this are racers; the rest (traffic) are only avoided. */
  racers: number;
  private readonly out: DriveInput = idleDrive();
  private readonly traits: Personality[] = [];
  private readonly aggression = new Float64Array(MAX_CARS);
  /** Per car: class full-lock yaw rate, top speed, brake (sedan until `setClass`). */
  private readonly turn = new Float64Array(MAX_CARS).fill(DRIVE.turn);
  private readonly top = new Float64Array(MAX_CARS).fill(DRIVE.maxFwd);
  private readonly brake = new Float64Array(MAX_CARS).fill(DRIVE.brake);
  private readonly boostTop = new Float64Array(MAX_CARS).fill(classStats("sedan").boostTop);
  /** Boost meter per car, 0–1, and whether a burst is running (it runs on to empty). */
  private readonly meter = new Float64Array(MAX_CARS);
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
  private readonly pt: TrackPoint = blankPoint();
  /** Speed of the car we are boxed in behind this call, NaN when the way is clear. */
  private follow = Number.NaN;
  /** Fight (0–1) of a shove or block this call: the lane swings over faster by this much. */
  private swerve = 0;
  /** Fight (0–1) toward the rival being hunted or rammed this call, 0 when none. */
  private chase = 0;
  /** Main-loop arc length of each shortcut's mouth and end. */
  private readonly mouthS: number[];
  private readonly exitS: number[];

  constructor(track: Track, racers: number) {
    this.track = track;
    this.racers = racers;
    for (let i = 0; i < MAX_CARS; i++) this.traits.push(personality(i));
    const p = blankProjection();
    this.mouthS = track.shortcuts.map((sc) => projectPath(track.path, sc.path.x[0]!, sc.path.z[0]!, -1, p).s);
    this.exitS = track.shortcuts.map((sc) => {
      const e = sc.path.count - 1;
      return projectPath(track.path, sc.path.x[e]!, sc.path.z[e]!, -1, p).s;
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
  setClass(id: number, s: { turn: number; topSpeed: number; brake: number; boostTop: number }): void {
    this.turn[id] = s.turn;
    this.top[id] = s.topSpeed;
    this.brake[id] = s.brake;
    this.boostTop[id] = s.boostTop;
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
    const speed = Math.hypot(self.vx, self.vz);

    if (this.recover[i]! > 0) {
      this.recover[i]! -= dt;
      out.throttle = -0.9;
      out.steer = this.recoverSteer[i]!;
      this.lastThrottle[i] = 0;
      this.charge(i, dt, false);
      return out;
    }

    const tr = this.track;
    const fresh = this.seg[i] === -1;
    const main = projectPath(tr.path, self.x, self.z, this.seg[i]!, this.mainProj);
    this.seg[i] = main.k;
    // First look (race start, respawn): the line starts where the car is, no swerve to the middle.
    if (fresh) this.lane[i] = clamp(main.lateral, -tr.path.half[main.k]!, tr.path.half[main.k]!);
    this.pickRoute(i, race, main.s);

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
    const turnMax = this.turn[i]! * (0.35 + 0.65 * Math.min(1, speed / 8)) * steerGrip(surf.grip);
    const fx = Math.sin(self.yaw);
    const fz = Math.cos(self.yaw);
    const along = self.vx * fx + self.vz * fz;

    // L2: the line (main loop only; a shortcut is narrow, drive its middle).
    this.follow = Number.NaN;
    this.chase = 0;
    this.swerve = 0;
    const want = route < 0 ? this.line(self, p, proj.s, path.half[k]!, proj.lateral, fx, fz, along, others) : 0;
    const step = LANE_RATE * (1 + this.swerve) * dt;
    this.lane[i] = route < 0 ? this.lane[i]! + clamp(want - this.lane[i]!, -step, step) : 0;
    const lane = this.lane[i]!;

    // L3: pursue a point on the line.
    const ld = clamp(5 + 0.5 * speed, 7, 18);
    // Short of a shortcut's mouth: head for the mouth itself so the car goes through its gate.
    const early = route >= 0 && proj.s < 0.5 && Math.hypot(self.x - path.x[0]!, self.z - path.z[0]!) > 4;
    const pt = this.pointAhead(path, route, early ? 2 : proj.s + ld);
    const tx = pt.x + pt.tz * lane;
    const tz = pt.z - pt.tx * lane;
    const alpha = wrapPi(Math.atan2(tx - self.x, tz - self.z) - self.yaw);
    const reach = early ? Math.max(4, Math.hypot(tx - self.x, tz - self.z)) : ld;
    const omega = (2 * Math.max(speed, 4) * Math.sin(alpha)) / reach;
    out.steer = clamp(omega / Math.max(0.2, turnMax), -1, 1);

    const top = this.top[i]!;
    let target = this.plan(i, path, route, proj.s, speed, top);
    // Boxed in, passing or keeping a gap sets `follow`; otherwise a clear run (or a hunted rival to
    // catch) boosts while every turn in the boosted braking reach still allows more than top.
    if (!Number.isNaN(this.follow)) target = Math.min(target, Math.max(0, this.follow - 0.5));
    else if (
      this.meter[i]! > (this.burst[i] ? 0.02 : BURST_MIN) &&
      speed > (this.chase > 0 ? 0.5 : 0.7) * top &&
      Math.abs(alpha) < (this.chase > 0 ? 0.45 : 0.3)
    ) {
      const boosted = this.plan(i, path, route, proj.s, speed, top * this.boostTop[i]!);
      if (boosted > top * surf.speed + 0.5) {
        out.boost = true;
        target = boosted;
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
      const reach = top * surf.speed * (out.boost ? this.boostTop[i]! : 1);
      out.throttle = clamp(target / reach, err > 0.4 ? 0.35 : 0, 1);
    } else {
      out.brake = clamp(-err / 6, 0.2, 1);
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
    this.charge(i, dt, out.boost);
    return out;
  }

  /** Drain the meter while boosting, refill it otherwise (the seat's rates). */
  private charge(i: number, dt: number, boosting: boolean): void {
    this.meter[i] = boosting ? Math.max(0, this.meter[i]! - dt / BOOST.full) : Math.min(1, this.meter[i]! + dt / BOOST.recharge);
    this.burst[i] = boosting ? 1 : 0;
  }

  /** Main loop or a designed shortcut: one seeded coin per car, lap and shortcut. */
  private pickRoute(i: number, race: RaceAiState, mainS: number): void {
    if (this.route[i]! >= 0) return;
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
      if (hash01(i * 31 + race.lap, 13 + k) < 0.3 + 0.4 * this.aggression[i]!) {
        this.route[i] = k;
        this.routeSeg[i] = -1;
      }
      return;
    }
  }

  /** Point `s` m along the route being driven, running on into the main loop past a shortcut's end. */
  private pointAhead(path: TrackPath, route: number, s: number): TrackPoint {
    if (route < 0) return this.track.pointAt(s, this.pt);
    if (s <= path.length) return pointOn(path, s, this.pt);
    return this.track.pointAt(this.exitS[route]! + (s - path.length), this.pt);
  }

  /** Highest speed now (up to `top`) that still makes every turn ahead within the braking budget. */
  private plan(i: number, path: TrackPath, route: number, s: number, speed: number, top: number): number {
    const tr = this.track;
    const decel = this.brake[i]! * PLAN_BRAKE;
    let best = top;
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
      const yawMax = this.turn[i]! * steerGrip(surf.grip) * CORNER_MARGIN;
      const corner = Math.min(top * surf.speed, curv > 1e-4 ? yawMax / curv : Infinity);
      const allow = Math.sqrt(corner * corner + 2 * decel * d);
      if (allow < best) best = allow;
    }
    return best;
  }

  /** Lateral target (m, + = left of travel) on the main loop; sets `follow` when boxed in. */
  private line(
    self: AiCar,
    p: Personality,
    s: number,
    half: number,
    lat: number,
    fx: number,
    fz: number,
    along: number,
    others: readonly AiCar[],
  ): number {
    const i = self.id;
    const tr = this.track;
    const room = Math.max(0, half - EDGE);
    let curv = 0;
    // Closest car on our line inside its following gap at our own pace (not a pass, just room kept).
    let keep = -1;
    let keepAhead = Infinity;
    let keepAlong = 0;
    let keepGap = GAP_KEEP;
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
    for (const o of others) {
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
      const m = rival ? mood(aggr, self.damage, o.damage) : -1;
      const fight = along > FIGHT_PACE && oAlong > 0.6 * FIGHT_PACE ? clamp(m, 0, 1) : 0;
      const shy = clamp(-m, 0, 1);
      if (ahead > 0.5 && ahead < SCAN && inWay) {
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
          const gap = GAP_KEEP * (0.4 + 0.6 * shy);
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
      } else if (fight > 0 && ahead >= 4 && ahead < preyAhead && ahead < HUNT && Math.abs(side) < HUNT_SIDE) {
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
        this.follow = blockerAlong + 0.5 + clamp((blockerAhead - PASS_NOSE) * 0.8, PASS_CREEP, 6);
      }
    } else if (keep >= 0) {
      // Its speed at the gap's edge, slower inside it (`follow` is read 0.5 m/s under).
      this.follow = keepAlong + 0.5 - 0.8 * (keepGap - keepAhead);
    }
    return clamp(want, -room, room);
  }
}
