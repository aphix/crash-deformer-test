import { DRIVE, idleDrive, type DriveInput } from "../car-drive.ts";
import { personality, STUCK_SPEED, type AiCar, type Personality } from "../derby-ai.ts";
import { MAX_CARS } from "../fleet.ts";
import { SURFACE_IDS, SURFACES, type Surface } from "./catalog.ts";
import { blankPoint, blankProjection, pointOn, projectPath, type Track, type TrackPath, type TrackPoint } from "./track.ts";

/** Steering authority on a surface: the race glue scales every car's steer by this. */
export function steerGrip(grip: number): number {
  return 0.45 + 0.55 * grip;
}

/** A car's drive input on `surf`: steer authority × `steerGrip`, forward throttle × the surface's top-speed share. */
export function onSurface(input: DriveInput, surf: Surface, out: DriveInput): DriveInput {
  out.throttle = input.throttle > 0 ? input.throttle * surf.speed : input.throttle;
  out.steer = input.steer * steerGrip(surf.grip);
  out.brake = input.brake;
  out.ebrake = input.ebrake;
  out.boost = input.boost;
  return out;
}

/** Corner speed margin: plan for this share of the drive model's full-lock yaw rate. */
const CORNER_MARGIN = 0.8;
/** Planned braking (m/s²): a share of `DRIVE.brake`. */
const PLAN_DECEL = DRIVE.brake * 0.5;
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

function wrapPi(a: number): number {
  return a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2));
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function hash01(id: number, k: number): number {
  const x = Math.sin(id * 127.1 + k * 311.7 + 17.13) * 43758.5453;
  return x - Math.floor(x);
}

function surfaceAt(path: TrackPath, k: number): Surface {
  return SURFACES[SURFACE_IDS[path.surface[k]!]!];
}

function sampleAt(path: TrackPath, s: number): number {
  const segs = path.closed ? path.count : path.count - 1;
  const u = Math.floor((s / path.length) * segs);
  return path.closed ? ((u % path.count) + path.count) % path.count : clamp(u, 0, path.count - 1);
}

/** What the brain needs from the race rules about one car. */
export type RaceAiState = {
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
 *     the side with room, else follow its speed. Aggression (0–1): ram a slower rival instead of
 *     passing, close the door on a rival coming through, lean on a rival alongside.
 *  L3 drive: pure pursuit to a point ahead on the line; speed from the curvature and grip ahead
 *     under a braking budget.
 * Deterministic (no clock, no Math.random); no allocation per call.
 */
export class RaceBrain {
  readonly track: Track;
  /** Ids below this are racers; the rest (traffic) are only avoided. */
  racers: number;
  private readonly out: DriveInput = idleDrive();
  private readonly traits: Personality[] = [];
  private readonly aggression = new Float64Array(MAX_CARS);
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
  }

  /** 0 clean racer … 1 rams and blocks. */
  setAggression(id: number, a: number): void {
    this.aggression[id] = clamp(a, 0, 1);
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
    const turnMax = DRIVE.turn * (0.35 + 0.65 * Math.min(1, speed / 8)) * steerGrip(surf.grip);
    const fx = Math.sin(self.yaw);
    const fz = Math.cos(self.yaw);
    const along = self.vx * fx + self.vz * fz;

    // L2: the line (main loop only; a shortcut is narrow, drive its middle).
    this.follow = Number.NaN;
    const want = route < 0 ? this.line(self, p, proj.s, path.half[k]!, proj.lateral, fx, fz, along, others) : 0;
    const step = LANE_RATE * dt;
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

    let target = this.plan(path, route, proj.s, speed);
    if (!Number.isNaN(this.follow)) target = Math.min(target, Math.max(0, this.follow - 0.5));
    const err = target - along;
    if (Math.abs(alpha) > 1.9 && speed < 6) {
      // Facing the wrong way: full lock and crawl round.
      out.throttle = 0.6;
      out.steer = Math.sign(alpha) || p.side;
    } else if (err > 0.4) {
      out.throttle = clamp(err / 2, 0.35, 1);
    } else if (err < -1.5) {
      out.brake = clamp(-err / 6, 0.2, 1);
    } else {
      out.throttle = clamp(target / (DRIVE.maxFwd * surf.speed), 0, 1);
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
    return out;
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

  /** Highest speed now that still makes every turn ahead within the braking budget. */
  private plan(path: TrackPath, route: number, s: number, speed: number): number {
    const tr = this.track;
    let best = DRIVE.maxFwd;
    const reach = (speed * speed) / (2 * PLAN_DECEL) + 12;
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
      const yawMax = DRIVE.turn * steerGrip(surf.grip) * CORNER_MARGIN;
      const corner = Math.min(DRIVE.maxFwd * surf.speed, curv > 1e-4 ? yawMax / curv : Infinity);
      const allow = Math.sqrt(corner * corner + 2 * PLAN_DECEL * d);
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
    for (let d = 10; d <= 34; d += 6) curv += tr.path.curv[sampleAt(tr.path, s + d)]!;
    curv /= 5;
    let want = clamp(Math.sign(curv) * Math.min(1, Math.abs(curv) * 30) * half * 0.45 + p.side * 0.8, -room, room);
    const aggr = this.aggression[i]!;
    let blocker = -1;
    let blockerAhead = Infinity;
    let blockerSide = 0;
    let blockerAlong = 0;
    for (const o of others) {
      if (o.id === i || !o.alive) continue;
      const dx = o.x - self.x;
      const dz = o.z - self.z;
      const ahead = dx * fx + dz * fz;
      // Left of travel = (fz, −fx).
      const side = dx * fz - dz * fx;
      const oAlong = o.vx * fx + o.vz * fz;
      const inWay = Math.abs(side) < LINE_W + 0.4 || Math.abs(lat + side - this.lane[i]!) < LINE_W;
      if (ahead > 0.5 && ahead < SCAN && inWay && along > oAlong + 0.3 && ahead < blockerAhead) {
        blocker = o.id;
        blockerAhead = ahead;
        blockerSide = side;
        blockerAlong = oAlong;
      }
      if (o.id >= this.racers) continue;
      if (ahead < -1 && ahead > -11 && Math.abs(side) < 4.5 && oAlong > along + 0.5 && aggr > 0.35) {
        want += (lat + side - want) * (aggr - 0.35) * 1.2;
      } else if (Math.abs(ahead) < 3 && Math.abs(side) < 3.6 && aggr > 0.6) {
        want += Math.sign(side) * (aggr - 0.6) * 4;
      }
    }
    if (blocker >= 0) {
      const oLat = lat + blockerSide;
      if (blocker < this.racers && aggr > 0.55 && hash01(i * 7 + blocker, 21) < aggr) return clamp(oLat, -room, room);
      const left = oLat + LINE_W + 0.9;
      const right = oLat - LINE_W - 0.9;
      const leftOk = left <= room;
      const rightOk = right >= -room;
      if (leftOk && (!rightOk || Math.abs(left - want) <= Math.abs(right - want))) want = left;
      else if (rightOk) want = right;
      else if (blockerAhead < 10) this.follow = blockerAlong;
    }
    return clamp(want, -room, room);
  }
}
