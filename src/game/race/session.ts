import { clamp } from "../scalar.ts";
import { blankPoint, blankProjection, crossGate, pointOn, projectPath, type Track, type TrackPath } from "./track.ts";
import type {
  CarPose,
  CarRecord,
  CarStatus,
  Entrant,
  RaceEvent,
  RacePhase,
  RaceResultRow,
  RaceSnapshot,
  WinBy,
} from "./types.ts";

/** Seconds on the grid with the lights off, then the red–yellow–green countdown. */
export const GRID_TIME = 1.5;
export const COUNTDOWN = 3;
/** Pause before a dead car is dropped back on the track. */
export const RESPAWN_DELAY = 3;
/** Pause for a respawn the driver asked for (stuck, flipped). */
const RESPAWN_REQUEST_DELAY = 1.5;
/** A respawn spot keeps this far (m) from every other car. */
export const CLEARANCE = 6;
/**
 * After the winner, every other car finishes the next time it crosses the line (the chequered flag),
 * classified by laps completed. A car that hasn't got there by its deadline is DNF: this long after
 * the winner, or `LAP_SLACK` × its own lap pace after it started its current lap, whichever is later.
 */
export const FINISH_GRACE = 30;
const LAP_SLACK = 1.5;
/** Seconds against the track before the wrong-way flag goes up. */
export const WRONG_WAY_ON = 0.7;
const WRONG_DOT = -0.3;
const WRONG_SPEED = 1.5;
/** A move longer than this in one step is a teleport (respawn, host reset): no gate credit. */
const TELEPORT = 25;
/** A respawn lands at least this far short of the next gate. */
const GATE_MARGIN = 3;
const RESPAWN_TRIES = 12;

/** 0 off, 1 red, 2 yellow, 3 green (held 1.5 s after the start). */
export function startLights(time: number): 0 | 1 | 2 | 3 {
  if (time < -COUNTDOWN) return 0;
  if (time < -1) return 1;
  if (time < 0) return 2;
  return time < 1.5 ? 3 : 0;
}

const NO_EVENTS: readonly RaceEvent[] = [];

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
  };
}

/**
 * The race rules for one course: grid → countdown → racing → finished. Deterministic for a given
 * sequence of `step(dt, poses)` calls; no THREE scene, no DOM, no clock of its own. The host
 * feeds one `CarPose` per entrant (entrant order) every fixed step, drains `events()` after it
 * (respawn placements, laps, finishes) and acts on them. `snapshot()` / `RaceSession.restore`
 * round-trip the whole state through plain JSON.
 */
export class RaceSession {
  readonly track: Track;
  readonly laps: number;
  readonly noReset: boolean;
  phase: RacePhase = "grid";
  time = -(GRID_TIME + COUNTDOWN);
  winnerId: number | null = null;
  winBy: WinBy | null = null;
  readonly cars: CarRecord[];
  /** Car indices in position order. */
  private readonly rank: number[];
  private readonly firstAt: Float64Array;
  private readonly queue: RaceEvent[] = [];
  private readonly finishers: number[] = [];
  private readonly proj = blankProjection();
  private readonly pt = blankPoint();

  /** `entrants` in grid order (index 0 on pole). */
  constructor(track: Track, entrants: readonly Entrant[], opts: { laps: number; noReset: boolean }) {
    this.track = track;
    this.laps = Math.max(1, Math.round(opts.laps));
    this.noReset = opts.noReset;
    this.cars = entrants.map((e, i) => {
      const slot = track.gridSlot(i);
      return newRecord(e, i, slot.x, slot.z);
    });
    this.rank = this.cars.map((_, i) => i);
    this.firstAt = new Float64Array((this.laps + 1) * track.gates.length).fill(NaN);
    for (let i = 0; i < this.cars.length; i++) this.measure(i, 0, 0, 0);
    this.sortRank();
  }

  static restore(track: Track, snap: RaceSnapshot): RaceSession {
    if (snap.trackId !== track.id) throw new Error(`snapshot is for ${snap.trackId}, not ${track.id}`);
    const s = new RaceSession(
      track,
      snap.cars.map((c) => ({ id: c.id, name: c.name, kind: c.kind, aggression: 0 })),
      { laps: snap.laps, noReset: snap.noReset },
    );
    s.phase = snap.phase;
    s.time = snap.time;
    s.winnerId = snap.winnerId;
    s.winBy = snap.winBy;
    snap.cars.forEach((c, i) => Object.assign(s.cars[i]!, structuredClone(c)));
    snap.order.forEach((id, k) => (s.rank[k] = s.cars.findIndex((c) => c.id === id)));
    snap.firstAt.forEach((t, k) => (s.firstAt[k] = t ?? NaN));
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

  /** Advance the clock by `dt` with the cars' poses at the end of the step. */
  step(dt: number, poses: readonly CarPose[]): void {
    if (this.phase === "finished" || dt <= 0) return;
    const t0 = this.time;
    this.time += dt;
    if (this.phase === "grid" && this.time >= -COUNTDOWN) this.phase = "countdown";
    if (this.phase === "countdown" && this.time >= 0) {
      this.phase = "racing";
      this.queue.push({ type: "go" });
    }
    if (this.phase !== "racing") {
      for (let i = 0; i < this.cars.length; i++) {
        const p = poses[i]!;
        this.cars[i]!.x = p.x;
        this.cars[i]!.z = p.z;
        this.measure(i, 0, 0, 0);
      }
      this.sortRank();
      return;
    }
    // The green light fell inside this step: the move before it earns nothing.
    const from = Math.max(t0, 0);
    const span = this.time - from;
    this.finishers.length = 0;
    for (let i = 0; i < this.cars.length; i++) this.stepCar(i, poses[i]!, from, span);
    this.sortRank();
    this.settle();
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
    };
  }

  /** Final (or live) classification in position order. */
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
      };
    });
  }

  private stepCar(i: number, pose: CarPose, t0: number, dt: number): void {
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
      if (this.time >= c.respawnAt!) this.respawn(i);
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
    if (mx * mx + mz * mz < TELEPORT * TELEPORT) this.gates(i, x0, z0, t0, dt);
    if (c.status === "racing") this.measure(i, pose.vx, pose.vz, dt);
  }

  /**
   * Gate credit for the move (x0, z0) → (c.x, c.z) over [t0, t0 + dt]. A designed shortcut counts
   * from any of its gates but the last, through any later one: a car that drives its own line
   * across the shortcut's ground (skipping a gate of it) still took the shortcut. Main checkpoints
   * stay strict; crossing a later one with a checkpoint still owed sets `missed`.
   */
  private gates(i: number, x0: number, z0: number, t0: number, dt: number): void {
    const c = this.cars[i]!;
    const tr = this.track;
    const n = tr.gates.length;
    for (let guard = 0; guard < 4 && c.status === "racing"; guard++) {
      if (c.route >= 0) {
        const sc = tr.shortcuts[c.route]!;
        const last = sc.gates.length - 1;
        let hit = -1;
        for (let g = last; g >= c.routeNext && hit < 0; g--) if (crossGate(sc.gates[g]!, x0, z0, c.x, c.z) >= 0) hit = g;
        if (hit >= 0) {
          c.routeNext = hit + 1;
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
        // Back on the main road past `from`: the shortcut is abandoned.
        const g = crossGate(tr.gates[c.next]!, x0, z0, c.x, c.z);
        if (g < 0) return;
        this.leaveRoute(c, c.next);
        this.pass(i, c.next, t0 + g * dt);
        continue;
      }
      const f = crossGate(tr.gates[c.next]!, x0, z0, c.x, c.z);
      if (f >= 0) {
        this.pass(i, c.next, t0 + f * dt);
        continue;
      }
      if (!c.armed) return;
      let entered = false;
      for (let k = 0; k < tr.shortcuts.length && !entered; k++) {
        const sc = tr.shortcuts[k]!;
        if ((sc.from + 1) % n !== c.next) continue;
        // Anywhere onto the shortcut short of its exit gate.
        for (let g = 0; g < sc.gates.length - 1; g++) {
          if (crossGate(sc.gates[g]!, x0, z0, c.x, c.z) < 0) continue;
          c.route = k;
          c.routeNext = g + 1;
          c.seg = -1;
          entered = true;
          break;
        }
      }
      if (entered) continue;
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
  }

  private pass(i: number, gate: number, t: number): void {
    const c = this.cars[i]!;
    c.missed = false;
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

  /** Projection, ranking distance and the wrong-way timer (velocity, dt = 0 to skip the timer). */
  private measure(i: number, vx: number, vz: number, dt: number): void {
    const c = this.cars[i]!;
    const tr = this.track;
    const L = tr.length;
    const p = this.proj;
    let path: TrackPath;
    let s: number;
    if (c.route >= 0) {
      const sc = tr.shortcuts[c.route]!;
      path = sc.path;
      projectPath(path, c.x, c.z, c.seg, p);
      const a = tr.gateS(sc.from);
      const b = sc.to === 0 ? L : tr.gateS(sc.to);
      s = a + clamp(p.s / path.length, 0, 1) * (b - a);
    } else {
      path = tr.path;
      projectPath(path, c.x, c.z, c.seg, p);
      if (!c.armed) {
        s = clamp(p.s < L * 0.5 ? p.s : p.s - L, -L * 0.5, 0);
      } else {
        const n = tr.gates.length;
        const lo = tr.gateS((c.next - 1 + n) % n);
        const hi = c.next === 0 ? L : tr.gateS(c.next);
        let u = p.s;
        if (u < lo - L * 0.5) u += L;
        else if (u > hi + L * 0.5) u -= L;
        s = clamp(u, lo, hi);
      }
    }
    c.seg = p.k;
    c.progress = c.lap * L + s;
    if (dt <= 0) return;
    const speed = Math.hypot(vx, vz);
    const k = p.k;
    const along = speed > WRONG_SPEED ? (vx * path.tx[k]! + vz * path.tz[k]!) / speed : 0;
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

  /** Drop the car back on the centreline at its progress, short of its next gate, clear of the others. */
  private respawn(i: number): void {
    const c = this.cars[i]!;
    const tr = this.track;
    const L = tr.length;
    const p = this.proj;
    let path: TrackPath;
    let s: number;
    if (c.route >= 0) {
      const sc = tr.shortcuts[c.route]!;
      path = sc.path;
      projectPath(path, c.x, c.z, c.seg, p);
      const lo = sc.gates[c.routeNext - 1]!.s;
      s = clamp(p.s, lo, Math.max(lo, sc.gates[c.routeNext]!.s - GATE_MARGIN));
    } else {
      path = tr.path;
      projectPath(path, c.x, c.z, c.seg, p);
      if (!c.armed) {
        s = clamp(p.s < L * 0.5 ? p.s + L : p.s, L * 0.5, L - GATE_MARGIN);
      } else {
        const n = tr.gates.length;
        const lo = tr.gateS((c.next - 1 + n) % n);
        const hi = c.next === 0 ? L : tr.gateS(c.next);
        let u = p.s;
        if (u < lo - L * 0.5) u += L;
        else if (u > hi + L * 0.5) u -= L;
        s = clamp(u, lo, Math.max(lo, hi - GATE_MARGIN));
      }
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
    c.status = "racing";
    c.respawnAt = null;
    c.x = x;
    c.z = z;
    c.wrongFor = 0;
    c.wrongWay = false;
    this.queue.push({ type: "respawn", id: c.id, x, z, yaw: Math.atan2(pt.tx, pt.tz) });
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

  /** Finish events, the winner, the last-alive rule and the close. */
  private settle(): void {
    if (this.finishers.length > 0) {
      for (const i of this.finishers) {
        const c = this.cars[i]!;
        this.queue.push({ type: "finish", id: c.id, place: c.place, time: c.finishTime! });
      }
      if (this.winnerId == null) {
        const first = this.cars[this.rank[0]!]!;
        this.winnerId = first.id;
        this.winBy = "laps";
      }
    }
    let winTime = Number.NaN;
    if (this.winBy === "laps") for (const c of this.cars) if (c.id === this.winnerId) winTime = c.finishTime!;
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
    if (this.noReset && this.winnerId == null && this.cars.length > 1 && running <= 1) {
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

  /** When a car still running after the winner is home stops being waited for (see `LAP_SLACK`). */
  private deadline(c: CarRecord, winTime: number): number {
    const pace = c.bestLap ?? winTime / this.laps;
    return Math.max(winTime + FINISH_GRACE, c.lapStart + LAP_SLACK * pace);
  }

  private close(): void {
    this.phase = "finished";
    this.sortRank();
    this.queue.push({ type: "over", winnerId: this.winnerId });
  }
}
