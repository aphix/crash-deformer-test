import { hypot2 } from "../kernel/physics-core.js";
import { CAR_HALF } from "../vehicle/car-mesh.ts";
import { clamp } from "../kernel/scalar.ts";
import { OPEN_REACH, blankPoint, blankProjection, crossGate, inCorridor, pointOn, projectPath, type Projection, type Track, type TrackPath } from "../world/track.ts";
import type {
  CarPose,
  CarRecord,
  CarStatus,
  Entrant,
  RaceEvent,
  RacePhase,
  RaceResultRow,
  RaceSnapshot,
  TeamHud,
  WinBy,
} from "./types.ts";

/** Seconds on the grid with the lights off, then the red–yellow–green countdown. */
export const GRID_TIME = 1.5;
export const COUNTDOWN = 3;
/** Pause before a dead car is dropped back on the track. */
export const RESPAWN_DELAY = 3;
/** Pause for a respawn the driver asked for (stuck, flipped). */
export const RESPAWN_REQUEST_DELAY = 1.5;
/** A respawn spot keeps this far (m) from every other car. */
export const CLEARANCE = 6;
/** A respawn waits for a car racing down on its spot: braking at this (m/s², the AI guard's budget for a sedan: 0.72 of its 28) it must be able to stop `CLEARANCE` short; within this lane (m) of the spot's line. */
export const RESPAWN_BRAKE = 20;
const RESPAWN_LANE = 2.5;
/** Seconds past its due time a respawn waits for such a car to pass before it drops in anyway. */
const RESPAWN_WAIT = 2;
/**
 * After the winner, every other car finishes the next time it crosses the line, classified by laps completed. A car not there by its
 * deadline is DNF: `FINISH_GRACE` after the winner, or `LAP_SLACK` × its own lap pace after its current lap started, whichever is later.
 */
export const FINISH_GRACE = 30;
const LAP_SLACK = 1.5;
/** Seconds against the track before the wrong-way flag goes up. */
export const WRONG_WAY_ON = 0.7;
/** Heading (cosine to the road's tangent) below which a car goes against the road: more against it than across it (135°), as a car crossing the road into a shortcut that leaves it at 90° or more, weaving, is not. */
const WRONG_DOT = -Math.SQRT1_2;
const WRONG_SPEED = 1.5;
/** A move longer than this in one step is a teleport (respawn, host reset): no gate credit. */
const TELEPORT = 25;
/** A respawn lands at least this far short of the next gate. */
export const GATE_MARGIN = 3;
const RESPAWN_TRIES = 12;
/**
 * Drafting: a racing car in another's wake, a cone opening behind its rear bumper. In the leader's velocity frame, `x` m behind the bumper (the stock hull, `CAR_HALF`), the follower is in when 0 <= x <= `range` car lengths and its offset from the leader's line is within the leader's half width + x·`fan`.
 * Both must be over `speed` m/s, and the follower's velocity within `align` (cosine) of the leader's, so a car crossing behind does not draft.
 * Every `every` s unbroken earns `bonus` of a boost meter; while it lasts top speed is × `top` (`applyDrive`'s `topScale`).
 * `range` 3 car lengths: the owner's sketch, research 2.5-3. `fan` tan 18°: a 36° wake, inside the owner's 35-45° and the research's 12-18° half angle. `align` cos 45°: the research's heading check. Research: `.extraResearch/perplexity/2026-10-13-arcade-draft-zone-values.md`, `2026-10-13-slipstream-zone-around-corners.md`.
 */
export const DRAFT = { range: 3, fan: Math.tan((18 * Math.PI) / 180), align: Math.SQRT1_2, speed: 15, every: 2, bonus: 0.05, top: 1.02 };
/** Busted: a racing car held under `kph` within `near` m of a chasing police car for over `time` s in a row is out, as a DNF is (out in a no-reset race). */
export const BUST = { near: 20, kph: 20, time: 4 };

/** 0 off, 1 red, 2 yellow, 3 green (held 1.5 s after the start). */
export function startLights(time: number): 0 | 1 | 2 | 3 {
  if (time < -COUNTDOWN) return 0;
  if (time < -1) return 1;
  if (time < 0) return 2;
  return time < 1.5 ? 3 : 0;
}

const NO_EVENTS: readonly RaceEvent[] = [];
const NO_COPS: readonly { x: number; z: number }[] = [];

/** Slots of `RaceSession.io`, written by `step`/`stepCar`, read by the per-car rules. A number passed to a call V8 does not inline is heap-boxed; a slot is not. */
const WIN_FROM_IDX = 0; // race clock (s) where the step's racing part starts
const WIN_SPAN_IDX = 1; // its length (s); 0 where the clock does not run (no wrong-way timer)
const MOVE_X0_IDX = 2; // the car's position when the step began
const MOVE_Z0_IDX = 3;
const VEL_X_IDX = 4; // its velocity at the end of the step
const VEL_Z_IDX = 5;
const IO_COUNT = 6;

const RANK_GROUP: Record<CarStatus, number> = { finished: 0, racing: 1, respawning: 1, dnf: 1, out: 2 };

function newRecord(e: Entrant, grid: number, x: number, z: number): CarRecord {
  return {
    id: e.id,
    name: e.name,
    kind: e.kind,
    grid,
    status: "racing",
    lap: 0,
    next: 0,
    armed: false,
    route: -1,
    routeNext: 0,
    progress: 0,
    place: grid + 1,
    lapStart: 0,
    lapTimes: [],
    bestLap: null,
    finishTime: null,
    split: null,
    outTime: null,
    wrongWay: false,
    missed: false,
    respawnAt: null,
    deaths: 0,
    x,
    z,
    wrongFor: 0,
    seg: -1,
    safe: null,
    draft: 0,
    drafts: 0,
    stopped: 0,
    bustedAt: null,
  };
}

/**
 * The race rules for one course: grid → countdown → racing → finished. Deterministic for a given sequence of `step(dt, poses)`
 * calls (one `CarPose` per entrant per fixed step); no scene, DOM or clock. The host drains `events()` after each step.
 */
export class RaceSession {
  readonly track: Track;
  readonly laps: number;
  readonly noReset: boolean;
  /** Seconds a car must stay held slow beside a chasing police car before the bust (`BUST.time`; a Survival run's own). */
  readonly bustTime: number;
  /** No gate credit, so no lap or finish: a Survival run ends only when its car is out (`Survival` rules). */
  readonly endless: boolean;
  phase: RacePhase = "grid";
  time = -(GRID_TIME + COUNTDOWN);
  winnerId: number | null = null;
  winBy: WinBy | null = null;
  readonly cars: CarRecord[];
  private readonly rank: number[];
  private readonly firstAt: Float64Array;
  private readonly queue: RaceEvent[] = [];
  private readonly finishers: number[] = [];
  private readonly proj = blankProjection();
  /** Scratch projection for the gate rules (`onRoad`, `reroute`, the shortcut leave test); `proj` stays the measure's. */
  private readonly back = blankProjection();
  private readonly pt = blankPoint();
  /** `stretch`'s result (a field, not a returned object: it runs per car per step). */
  private readonly span = { lo: 0, hi: 0, u: 0, at: NaN };
  private readonly io = new Float64Array(IO_COUNT);
  /** This step's poses, for the respawn's look at the cars about (`unthreatened`). */
  private poses: readonly CarPose[] = [];

  /** `entrants` in grid order (index 0 on pole). */
  constructor(track: Track, entrants: readonly Entrant[], opts: { laps: number; noReset: boolean; survival?: { bustTime: number } }) {
    this.track = track;
    this.laps = Math.max(1, Math.round(opts.laps));
    this.noReset = opts.noReset;
    this.bustTime = opts.survival?.bustTime ?? BUST.time;
    this.endless = opts.survival !== undefined;
    this.cars = entrants.map((e, i) => {
      const slot = track.gridSlot(i);
      return newRecord(e, i, slot.x, slot.z);
    });
    // An AI car of a Survival run is nobody's: the humans' places the room did not seat (a peer left) stay where they were put.
    if (this.endless) for (const c of this.cars) if (c.kind === "ai") c.status = "out";
    this.rank = this.cars.map((_, i) => i);
    this.firstAt = new Float64Array((this.laps + 1) * track.gates.length).fill(NaN);
    for (let i = 0; i < this.cars.length; i++) this.measure(i);
    this.sortRank();
  }

  static restore(track: Track, snap: RaceSnapshot): RaceSession {
    if (snap.trackId !== track.id) throw new Error(`snapshot is for ${snap.trackId}, not ${track.id}`);
    const s = new RaceSession(
      track,
      snap.cars.map((c) => ({ id: c.id, name: c.name, kind: c.kind, aggression: 0 })),
      { laps: snap.laps, noReset: snap.noReset, survival: snap.survival ?? undefined },
    );
    s.phase = snap.phase;
    s.time = snap.time;
    s.winnerId = snap.winnerId;
    s.winBy = snap.winBy;
    for (const [i, c] of snap.cars.entries()) Object.assign(s.cars[i]!, structuredClone(c));
    for (const [k, id] of snap.order.entries()) s.rank[k] = s.cars.findIndex((c) => c.id === id);
    for (const [k, t] of snap.firstAt.entries()) s.firstAt[k] = t ?? NaN;
    return s;
  }

  get lights(): 0 | 1 | 2 | 3 {
    return startLights(this.time);
  }

  /** Car ids in position order (fresh array). */
  order(): number[] {
    return this.rank.map((i) => this.cars[i]!.id);
  }

  /** Events since the last call, oldest first (a shared empty array when there are none). */
  events(): readonly RaceEvent[] {
    if (this.queue.length === 0) return NO_EVENTS;
    const out = this.queue.slice();
    this.queue.length = 0;
    return out;
  }

  /** Advance the clock by `dt` with the cars' poses at the end of the step, and the chasing police cars' positions (`BUST`). */
  step(dt: number, poses: readonly CarPose[], cops: readonly { x: number; z: number }[] = NO_COPS): void {
    if (this.phase === "finished" || dt <= 0) return;
    const t0 = this.time;
    this.time += dt;
    if (this.phase === "grid" && this.time >= -COUNTDOWN) this.phase = "countdown";
    if (this.phase === "countdown" && this.time >= 0) {
      this.phase = "racing";
      this.announceGo();
    }
    if (this.phase !== "racing") {
      this.io[VEL_X_IDX] = 0;
      this.io[VEL_Z_IDX] = 0;
      this.io[WIN_SPAN_IDX] = 0;
      for (let i = 0; i < this.cars.length; i++) {
        const p = poses[i]!;
        this.cars[i]!.x = p.x;
        this.cars[i]!.z = p.z;
        this.measure(i);
      }
      this.sortRank();
      return;
    }
    // The green light fell inside this step: the move before it earns nothing.
    const from = Math.max(t0, 0);
    const span = this.time - from;
    this.io[WIN_FROM_IDX] = from;
    this.io[WIN_SPAN_IDX] = span;
    this.finishers.length = 0;
    this.poses = poses;
    for (let i = 0; i < this.cars.length; i++) this.stepCar(i, poses[i]!);
    this.drafting(poses, span);
    this.busting(poses, cops, span);
    this.sortRank();
    this.settle();
  }

  private announceGo(): void {
    this.queue.push({ type: "go" });
  }

  /** This step's finishers for the host, and the winner when the first of them is home. */
  private announceFinishers(): void {
    for (let k = 0; k < this.finishers.length; k++) {
      const c = this.cars[this.finishers[k]!]!;
      this.queue.push({ type: "finish", id: c.id, place: c.place, time: c.finishTime! });
    }
    if (this.winnerId == null) {
      const first = this.cars[this.rank[0]!]!;
      this.winnerId = first.id;
      this.winBy = "laps";
    }
  }

  /** `DRAFT`: each racing car's unbroken seconds in another's trail, and the boost bonuses that earned. */
  private drafting(poses: readonly CarPose[], dt: number): void {
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i]!;
      const p = poses[i]!;
      let trail = false;
      for (let j = 0; j < this.cars.length && !trail && c.status === "racing" && p.alive; j++) {
        const q = poses[j]!;
        const v = hypot2(q.vx, q.vz);
        if (j === i || !q.alive || this.cars[j]!.status !== "racing" || v < DRAFT.speed) continue;
        const fx = q.vx / v;
        const fz = q.vz / v;
        const back = (q.x - p.x) * fx + (q.z - p.z) * fz;
        const off = Math.abs((p.x - q.x) * fz - (p.z - q.z) * fx);
        const x = back - CAR_HALF.z; // m behind the leader's rear bumper
        const pf = p.vx * fx + p.vz * fz;
        trail = x >= 0 && x <= DRAFT.range * 2 * CAR_HALF.z && off <= CAR_HALF.x + x * DRAFT.fan && pf >= DRAFT.speed && pf >= DRAFT.align * hypot2(p.vx, p.vz);
      }
      if (!trail) {
        c.draft = 0;
        continue;
      }
      const was = Math.floor(c.draft / DRAFT.every);
      c.draft += dt;
      if (Math.floor(c.draft / DRAFT.every) > was) c.drafts++;
    }
  }

  /** `BUST`: each racing car's unbroken seconds held slow beside a chasing police car, and the bust once that runs out. */
  private busting(poses: readonly CarPose[], cops: readonly { x: number; z: number }[], dt: number): void {
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i]!;
      const p = poses[i]!;
      let near = false;
      for (let k = 0; k < cops.length && !near; k++) near = hypot2(cops[k]!.x - p.x, cops[k]!.z - p.z) <= BUST.near;
      if (c.status !== "racing" || !near || hypot2(p.vx, p.vz) * 3.6 >= BUST.kph) {
        c.stopped = 0;
        continue;
      }
      c.stopped += dt;
      if (c.stopped <= this.bustTime) continue;
      c.bustedAt = this.time;
      c.wrongWay = false;
      c.wrongFor = 0;
      c.draft = 0;
      if (!this.noReset) {
        c.status = "dnf";
        continue;
      }
      c.status = "out";
      c.outTime = this.time;
    }
  }

  /** The driver asks to be put back (stuck / flipped). Refused in no-reset races and outside racing. */
  requestRespawn(id: number): boolean {
    const i = this.cars.findIndex((c) => c.id === id);
    const c = this.cars[i];
    if (!c || this.noReset || this.phase !== "racing" || c.status !== "racing") return false;
    c.status = "respawning";
    c.respawnAt = this.time + RESPAWN_REQUEST_DELAY;
    c.wrongWay = false;
    c.wrongFor = 0;
    this.queue.push({ type: "died", id: c.id, respawnAt: c.respawnAt });
    return true;
  }

  /** Close the race now; cars still running are DNF. */
  end(): void {
    if (this.phase === "finished") return;
    for (const c of this.cars) if (c.status === "racing" || c.status === "respawning") c.status = "dnf";
    this.close();
  }

  snapshot(): RaceSnapshot {
    return {
      trackId: this.track.id,
      laps: this.laps,
      noReset: this.noReset,
      phase: this.phase,
      time: this.time,
      lights: this.lights,
      winnerId: this.winnerId,
      winBy: this.winBy,
      cars: structuredClone(this.cars),
      order: this.order(),
      firstAt: Array.from(this.firstAt, (t) => (Number.isNaN(t) ? null : t)),
      survival: this.endless ? { bustTime: this.bustTime } : null,
      pack: null,
      campaign: null,
      standings: false,
    };
  }

  /**
   * Co-op: the humans (cars no AI drives) as one team; null with fewer than two. Race: `place` is the best human place, `won` once
   * the event is over says a human finished first. Survival: ends when no human is free (`settle`), so only ever lost.
   */
  team(): TeamHud | null {
    let humans = 0;
    let free = 0;
    let place = Infinity;
    for (const c of this.cars) {
      if (c.kind === "ai") continue;
      humans++;
      if (c.status === "racing" || c.status === "respawning") free++;
      if (c.place < place) place = c.place;
    }
    if (humans < 2) return null;
    const winner = this.winnerId == null ? undefined : this.cars.find((c) => c.id === this.winnerId);
    const won = this.phase !== "finished" ? null : !this.endless && winner !== undefined && winner.kind !== "ai";
    return { humans, free, place: this.endless ? null : place, won };
  }

  results(): RaceResultRow[] {
    const win = this.winnerId == null ? null : this.cars.find((c) => c.id === this.winnerId)!;
    const winTime = win?.finishTime ?? null;
    return this.rank.map((i) => {
      const c = this.cars[i]!;
      return {
        id: c.id,
        name: c.name,
        kind: c.kind,
        place: c.place,
        status: c.status,
        time: c.status === "finished" ? c.finishTime : null,
        // Lapped finishers and DNF rows carry `laps` instead of a time gap.
        gap: c.status === "finished" && c.lap >= this.laps && c.finishTime != null && winTime != null ? c.finishTime - winTime : null,
        bestLap: c.bestLap,
        laps: c.lap,
        busted: c.bustedAt != null,
      };
    });
  }

  private stepCar(i: number, pose: CarPose): void {
    const c = this.cars[i]!;
    if (c.status === "finished" || c.status === "out" || c.status === "dnf") {
      c.x = pose.x;
      c.z = pose.z;
      return;
    }
    if (c.status === "respawning") {
      // The wreck still occupies the road and is where the respawn is measured from.
      c.x = pose.x;
      c.z = pose.z;
      if (this.time >= c.respawnAt! && (this.time >= c.respawnAt! + RESPAWN_WAIT || this.unthreatened(i))) this.respawn(i);
      return;
    }
    if (!pose.alive) {
      c.x = pose.x;
      c.z = pose.z;
      this.kill(i);
      return;
    }
    const x0 = c.x;
    const z0 = c.z;
    c.x = pose.x;
    c.z = pose.z;
    const mx = pose.x - x0;
    const mz = pose.z - z0;
    const io = this.io;
    io[MOVE_X0_IDX] = x0;
    io[MOVE_Z0_IDX] = z0;
    io[VEL_X_IDX] = pose.vx;
    io[VEL_Z_IDX] = pose.vz;
    if (!this.endless && mx * mx + mz * mz < TELEPORT * TELEPORT) this.gates(i);
    if (!this.endless && c.status === "racing") this.measure(i);
  }

  /**
   * Gate credit for the move (x0, z0) → (c.x, c.z) over [t0, t0 + dt] (the `io` slots). A designed shortcut counts from any of its
   * gates but the last, through any later one, so a car driving its own line across the shortcut's ground still took it. Main
   * checkpoints stay strict: crossing a later one with one owed sets `missed`. A shortcut gate counts as entering only off the main
   * road, a main gate as back on it only on the main road; among shortcuts leaving one checkpoint the car is on the nearest road's.
   */
  private gates(i: number): void {
    const c = this.cars[i]!;
    const tr = this.track;
    const n = tr.gates.length;
    const io = this.io;
    const x0 = io[MOVE_X0_IDX]!;
    const z0 = io[MOVE_Z0_IDX]!;
    const t0 = io[WIN_FROM_IDX]!;
    const dt = io[WIN_SPAN_IDX]!;
    for (let guard = 0; guard < 4 && c.status === "racing"; guard++) {
      if (c.route >= 0) {
        this.reroute(c);
        const sc = tr.shortcuts[c.route]!;
        const last = sc.gates.length - 1;
        let hit = -1;
        for (let g = last; g >= c.routeNext && hit < 0; g--) if (crossGate(sc.gates[g]!, x0, z0, c.x, c.z) >= 0) hit = g;
        if (hit >= 0) {
          c.routeNext = hit + 1;
          c.safe = null;
          if (c.routeNext > last) this.leaveRoute(c, sc.to);
          continue;
        }
        // Every gate but the exit crossed, then onto the main road at the rejoin checkpoint: done.
        if (c.routeNext === last && sc.to !== c.next) {
          const r = crossGate(tr.gates[sc.to]!, x0, z0, c.x, c.z);
          if (r >= 0) {
            this.leaveRoute(c, sc.to);
            this.pass(i, sc.to, t0 + r * dt);
            continue;
          }
        }
        const g = crossGate(tr.gates[c.next]!, x0, z0, c.x, c.z);
        if (g < 0 || !tr.onRoad(x0 + (c.x - x0) * g, z0 + (c.z - z0) * g, this.back)) return;
        this.leaveRoute(c, c.next);
        this.pass(i, c.next, t0 + g * dt);
        continue;
      }
      // A shortcut gate crossed off the main road comes first: a shortcut that runs through the reach of a main gate is not the main road.
      if (c.armed) {
        this.reroute(c);
        if (c.route >= 0) continue;
      }
      const f = crossGate(tr.gates[c.next]!, x0, z0, c.x, c.z);
      if (f >= 0) {
        this.pass(i, c.next, t0 + f * dt);
        continue;
      }
      if (!c.armed) return;
      // A gate ahead of the owed one (not the one just passed, crossed again after a spin).
      for (let g = 0; g < n && !c.missed; g++) {
        if (g !== c.next && g !== (c.next + n - 1) % n && crossGate(tr.gates[g]!, x0, z0, c.x, c.z) >= 0) c.missed = true;
      }
      return;
    }
  }

  private leaveRoute(c: CarRecord, next: number): void {
    c.route = -1;
    c.routeNext = 0;
    c.next = next;
    c.seg = -1;
    c.safe = null;
  }

  /**
   * Onto a shortcut not yet on, or a sibling: of the shortcuts with a gate (but the exit) crossed this move off the main road, the car
   * takes the one whose road is nearest; a car already on one only moves to a nearer.
   */
  private reroute(c: CarRecord): void {
    const x0 = this.io[MOVE_X0_IDX]!;
    const z0 = this.io[MOVE_Z0_IDX]!;
    const tr = this.track;
    const n = tr.gates.length;
    let best = -1;
    let bestGate = 0;
    let bestD = Infinity;
    for (let k = 0; k < tr.shortcuts.length; k++) {
      const sc = tr.shortcuts[k]!;
      if (k === c.route || (sc.from + 1) % n !== c.next) continue;
      for (let g = 0; g < sc.gates.length - 1; g++) {
        const t = crossGate(sc.gates[g]!, x0, z0, c.x, c.z);
        if (t < 0 || tr.onRoad(x0 + (c.x - x0) * t, z0 + (c.z - z0) * t, this.back)) continue;
        const d = projectPath(sc.path, c.x, c.z, -1, this.back).dist2;
        if (d < bestD) {
          best = k;
          bestGate = g;
          bestD = d;
        }
        break;
      }
    }
    if (best < 0) return;
    if (c.route >= 0 && projectPath(tr.shortcuts[c.route]!.path, c.x, c.z, c.seg, this.back).dist2 <= bestD) return;
    c.route = best;
    c.routeNext = bestGate + 1;
    c.seg = -1;
    c.safe = null;
  }

  private pass(i: number, gate: number, t: number): void {
    const c = this.cars[i]!;
    c.missed = false;
    c.safe = null;
    const n = this.track.gates.length;
    if (gate !== 0) {
      c.next = (gate + 1) % n;
      this.split(c, c.lap * n + gate, t);
      return;
    }
    if (!c.armed) {
      c.armed = true;
      c.next = 1;
      this.split(c, 0, t);
      return;
    }
    c.lap++;
    const lapTime = t - c.lapStart;
    c.lapTimes.push(lapTime);
    c.bestLap = c.bestLap == null ? lapTime : Math.min(c.bestLap, lapTime);
    c.lapStart = t;
    c.next = 1;
    this.split(c, c.lap * n, t);
    this.queue.push({ type: "lap", id: c.id, lap: c.lap, time: lapTime });
    // All laps done, or the winner is home: the chequered flag finishes every car at the line.
    if (c.lap >= this.laps || this.winBy === "laps") {
      c.status = "finished";
      c.finishTime = t;
      c.wrongWay = false;
      this.finishers.push(i);
    }
  }

  private split(c: CarRecord, key: number, t: number): void {
    if (key >= this.firstAt.length) return;
    if (Number.isNaN(this.firstAt[key]!)) this.firstAt[key] = t;
    c.split = t - this.firstAt[key]!;
  }

  /**
   * Fills `span` for car `c` on its path (`p` its projection, `road` whether it is on that road): the stretch between the last checkpoint hit (`lo`)
   * and the first owed (`hi`), `u` the car's arc length (main loop wrapped to within half a lap of the stretch), `at` that arc length when on the
   * road inside the stretch, else NaN. `measure` records `at` as the safe spot, `spot` puts a reset there.
   */
  private stretch(c: CarRecord, p: Projection, road: boolean): void {
    const tr = this.track;
    const sp = this.span;
    sp.u = p.s;
    if (c.route >= 0) {
      const gates = tr.shortcuts[c.route]!.gates;
      sp.lo = gates[c.routeNext - 1]!.s;
      sp.hi = gates[c.routeNext]!.s;
    } else {
      const L = tr.length;
      const n = tr.gates.length;
      sp.lo = tr.gates[(c.next - 1 + n) % n]!.s;
      sp.hi = c.next === 0 ? L : tr.gates[c.next]!.s;
      if (sp.u < sp.lo - L * 0.5) sp.u += L;
      else if (sp.u > sp.hi + L * 0.5) sp.u -= L;
    }
    sp.at = road && sp.u >= sp.lo && sp.u <= sp.hi ? sp.u : NaN;
  }

  /** Projection, ranking distance and the wrong-way timer (the car's velocity and the step's window from `io`; no window, no timer). */
  private measure(i: number): void {
    const c = this.cars[i]!;
    const tr = this.track;
    const L = tr.length;
    const p = this.proj;
    let path: TrackPath;
    let s: number;
    let road: boolean;
    if (c.route >= 0) {
      const sc = tr.shortcuts[c.route]!;
      path = sc.path;
      projectPath(path, c.x, c.z, c.seg, p);
      // A car that is beyond the shortcut's gates (so no longer on it) and on the main road is back on the main road: a car
      // that crossed a gate at a mouth while driving past, and one that left the shortcut for the road, owes the main gate it owed.
      if (p.dist2 > (path.half[p.k]! + OPEN_REACH) ** 2 && tr.onRoad(c.x, c.z, this.back)) {
        this.leaveRoute(c, c.next);
        this.measure(i);
        return;
      }
      const a = tr.gates[sc.from]!.s;
      const b = sc.to === 0 ? L : tr.gates[sc.to]!.s;
      s = a + clamp(p.s / path.length, 0, 1) * (b - a);
      road = inCorridor(path, p);
      this.stretch(c, p, road);
      if (!Number.isNaN(this.span.at)) c.safe = this.span.at;
    } else {
      path = tr.path;
      projectPath(path, c.x, c.z, c.seg, p);
      road = inCorridor(path, p);
      if (!c.armed) {
        s = clamp(p.s < L * 0.5 ? p.s : p.s - L, -L * 0.5, 0);
      } else {
        this.stretch(c, p, road);
        s = clamp(this.span.u, this.span.lo, this.span.hi);
        if (!Number.isNaN(this.span.at)) c.safe = this.span.at;
      }
    }
    c.seg = p.k;
    c.progress = c.lap * L + s;
    const dt = this.io[WIN_SPAN_IDX]!;
    if (dt <= 0) return;
    const vx = this.io[VEL_X_IDX]!;
    const vz = this.io[VEL_Z_IDX]!;
    const speed = hypot2(vx, vz);
    const k = p.k;
    // Heading against the road means nothing off it (a car leaving through a mouth, a spin in the field): only on the road, its runoff and its wall.
    const along = speed > WRONG_SPEED && road ? (vx * path.tx[k]! + vz * path.tz[k]!) / speed : 0;
    if (along < WRONG_DOT) c.wrongFor += dt;
    else c.wrongFor = Math.max(0, c.wrongFor - 2 * dt);
    if (c.wrongFor >= WRONG_WAY_ON) c.wrongWay = true;
    else if (c.wrongFor <= 0) c.wrongWay = false;
  }

  private kill(i: number): void {
    const c = this.cars[i]!;
    c.deaths++;
    c.wrongWay = false;
    c.wrongFor = 0;
    if (this.noReset) {
      c.status = "out";
      c.outTime = this.time;
      this.queue.push({ type: "out", id: c.id });
      return;
    }
    c.status = "respawning";
    c.respawnAt = this.time + RESPAWN_DELAY;
    this.queue.push({ type: "died", id: c.id, respawnAt: c.respawnAt });
  }

  /** Drop the car back on the road: where it was last on it between the last checkpoint it hit and the first it still owes (`spot`), clear of the others. */
  private respawn(i: number): void {
    const c = this.cars[i]!;
    const spot = this.spot(i);
    c.status = "racing";
    c.respawnAt = null;
    c.x = spot.x;
    c.z = spot.z;
    c.wrongFor = 0;
    c.wrongWay = false;
    this.queue.push({ type: "respawn", id: c.id, x: spot.x, z: spot.z, yaw: spot.yaw, keep: false });
  }

  /** The driver holds reset: back on the road at once, car as it is (host keeps its damage), also in a no-reset race; refused in an endless run and unless racing. */
  holdReset(id: number): boolean {
    const i = this.cars.findIndex((c) => c.id === id);
    const c = this.cars[i];
    if (!c || this.endless || this.phase !== "racing" || c.status !== "racing") return false;
    const spot = this.spot(i);
    c.x = spot.x;
    c.z = spot.z;
    c.seg = -1;
    c.wrongFor = 0;
    c.wrongWay = false;
    this.queue.push({ type: "respawn", id: c.id, x: spot.x, z: spot.z, yaw: spot.yaw, keep: true });
    return true;
  }

  /**
   * Where car `i` goes back to: on its path's centreline, `GATE_MARGIN` short of the checkpoint it owes and never behind the last it hit.
   * Its own spot if on the road between the two, else the last such spot it passed (`CarRecord.safe`), else the checkpoint it last hit. Clear of the other cars.
   */
  private spot(i: number): { x: number; z: number; yaw: number } {
    const c = this.cars[i]!;
    const tr = this.track;
    const L = tr.length;
    const p = this.proj;
    const path = c.route >= 0 ? tr.shortcuts[c.route]!.path : tr.path;
    projectPath(path, c.x, c.z, c.seg, p);
    let s: number;
    if (c.route < 0 && !c.armed) {
      s = clamp(p.s < L * 0.5 ? p.s + L : p.s, L * 0.5, L - GATE_MARGIN);
    } else {
      this.stretch(c, p, inCorridor(path, p));
      const sp = this.span;
      s = clamp(Number.isNaN(sp.at) ? (c.safe ?? sp.lo) : sp.at, sp.lo, Math.max(sp.lo, sp.hi - GATE_MARGIN));
    }
    const pt = this.pt;
    let x = 0;
    let z = 0;
    for (let t = 0; t < RESPAWN_TRIES; t++) {
      const back = Math.floor(t / 3) * CLEARANCE;
      pointOn(path, path.closed ? s - back : Math.max(0, s - back), pt);
      const lat = t % 3 === 0 ? 0 : (t % 3 === 1 ? 0.5 : -0.5) * pt.half;
      x = pt.x + pt.tz * lat;
      z = pt.z - pt.tx * lat;
      if (this.clear(i, x, z)) break;
    }
    return { x, z, yaw: Math.atan2(pt.tx, pt.tz) };
  }

  private clear(i: number, x: number, z: number): boolean {
    for (let j = 0; j < this.cars.length; j++) {
      if (j === i) continue;
      const o = this.cars[j]!;
      const dx = o.x - x;
      const dz = o.z - z;
      if (dx * dx + dz * dz < CLEARANCE * CLEARANCE) return false;
    }
    return true;
  }

  /**
   * No car is racing down on car `i`'s spot faster than it can stop: one within `RESPAWN_LANE` m of the spot's line and ahead of it by less than
   * `CLEARANCE` plus its braking distance (at `RESPAWN_BRAKE`) would meet the respawned car with nothing left to do (city x4: a racer at 31 m/s, a car put 8.8 m in front of it).
   */
  private unthreatened(i: number): boolean {
    const spot = this.spot(i);
    for (let j = 0; j < this.cars.length; j++) {
      const q = this.poses[j];
      if (j === i || !q || !q.alive || this.cars[j]!.status !== "racing") continue;
      const v = hypot2(q.vx, q.vz);
      if (v < 1) continue;
      const dx = spot.x - q.x;
      const dz = spot.z - q.z;
      const ahead = (dx * q.vx + dz * q.vz) / v;
      const off = Math.abs(dx * q.vz - dz * q.vx) / v;
      if (ahead > -CAR_HALF.z && ahead < CLEARANCE + (v * v) / (2 * RESPAWN_BRAKE) && off < RESPAWN_LANE) return false;
    }
    return true;
  }

  /** Position order: finishers by laps then time, then the field by progress, then the out cars (last out first). Ties keep grid order. */
  private sortRank(): void {
    const r = this.rank;
    const cars = this.cars;
    for (let a = 1; a < r.length; a++) {
      const v = r[a]!;
      let b = a - 1;
      while (b >= 0 && this.before(cars[v]!, cars[r[b]!]!)) {
        r[b + 1] = r[b]!;
        b--;
      }
      r[b + 1] = v;
    }
    for (let k = 0; k < r.length; k++) cars[r[k]!]!.place = k + 1;
  }

  private before(a: CarRecord, b: CarRecord): boolean {
    const ga = RANK_GROUP[a.status];
    const gb = RANK_GROUP[b.status];
    if (ga !== gb) return ga < gb;
    if (ga === 0 && a.lap !== b.lap) return a.lap > b.lap;
    if (ga === 0 && a.finishTime !== b.finishTime) return a.finishTime! < b.finishTime!;
    if (ga === 2 && a.outTime !== b.outTime) return a.outTime! > b.outTime!;
    if (ga !== 0 && a.progress !== b.progress) return a.progress > b.progress;
    return a.grid < b.grid;
  }

  private settle(): void {
    if (this.finishers.length > 0) this.announceFinishers();
    let winTime = Number.NaN;
    if (this.winBy === "laps") for (let k = 0; k < this.cars.length; k++) if (this.cars[k]!.id === this.winnerId) winTime = this.cars[k]!.finishTime!;
    let running = 0;
    let last = -1;
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i]!;
      if (c.status !== "racing" && c.status !== "respawning") continue;
      if (!Number.isNaN(winTime) && this.time >= this.deadline(c, winTime)) {
        c.status = "dnf";
        continue;
      }
      running++;
      last = i;
    }
    // A Survival run has no last-alive winner: it ends when no human is free (`running` 0, below).
    if (!this.endless && this.noReset && this.winnerId == null && this.cars.length > 1 && running <= 1) {
      const champ = running === 1 ? this.cars[last]! : this.cars[this.rank[0]!]!;
      if (running === 1) {
        champ.status = "finished";
        champ.finishTime = this.time;
        this.sortRank();
      }
      this.winnerId = champ.id;
      this.winBy = "survival";
      this.close();
      return;
    }
    if (running === 0) this.close();
  }

  /** When a car still running after the winner is home stops being waited for (see `LAP_SLACK`). The pace is its slowest lap so far: its best may be a shortcut's lap, which the loop lap after it cannot match (razor-shelf: 38 s round the cut, 65 s on the loop). */
  private deadline(c: CarRecord, winTime: number): number {
    let pace = c.lapTimes.length > 0 ? 0 : winTime / this.laps;
    for (let k = 0; k < c.lapTimes.length; k++) if (c.lapTimes[k]! > pace) pace = c.lapTimes[k]!;
    return Math.max(winTime + FINISH_GRACE, c.lapStart + LAP_SLACK * pace);
  }

  private close(): void {
    this.phase = "finished";
    this.sortRank();
    this.queue.push({ type: "over", winnerId: this.winnerId });
  }
}
