import { DerbyBrain, blankAiCar, DEFAULT_DERBY_AGGRESSION, DERBY_RULES, type AiCar } from "./derby-ai.ts";
import { idleDrive, type DriveInput } from "./car-drive.ts";
import { fieldAggression } from "./ai-aggression.ts";
import { derbyRadius } from "./derby-arena.ts";

/**
 * One point per scoring hit: ≥ `SCORE_SPEED` into a live car, at most one per pair per `SCORE_GAP`.
 * Measured (10 cars, seeds 1–3): tops 10–13 at 2 min, medians 4–6; 2 m/s / 2 s read 15–21.
 */
export const HIT_POINTS = 1;
const SCORE_SPEED = 4;
export const SCORE_GAP = 6;
/** Bonus for the last hit before an engine dies. */
export const DISABLE_POINTS = 2;
const HIT_DEBOUNCE = 2;
const WINNER_HOLD = 4.4;
export const STALEMATE = 90;

/**
 * Heat time limit for a field of `count`: 30 s a car, never under `STALEMATE` (10 cars: 5 min). Real heats
 * run 10–20 min for 20–30 cars; the limit has to leave room for a last-car-standing finish by wrecking.
 */
export function heatLimit(count: number): number {
  return Math.max(STALEMATE, 30 * count);
}

/** How the winner was decided: last car standing after a wreck or a count-out, or top score at the time limit. */
export type DerbyDecided = "wreck" | "countout" | "time";

type DerbyOptions = {
  /** The field's aggression slider: a maximum, each driver rolls its own under it. */
  aggression?: number;
  /** Rolls the field; the same seed gives the same drivers. Default: a new roll every match. */
  seed?: number;
  /** Override `DERBY_RULES.hitClock` (Infinity: no hit-clock count-outs). */
  hitClock?: number;
  /** Heat time limit (s): then the top score among the cars still running wins. Default `heatLimit(cars.length)`. */
  timeLimit?: number;
  /** Bowl radius the drivers keep inside; default `derbyRadius(cars.length)`. */
  radius?: number;
};

export type DerbyBoardRow = {
  id: number;
  name: string;
  score: number;
  hits: number;
  disables: number;
  alive: boolean;
  /** Counted out (no aggressive hit, or no movement, for too long); its engine may still run. */
  out: boolean;
  /** Seconds left on whichever count-out clock runs out first. */
  clock: number;
};

/** One car's state for `DerbyMatch.step`. */
export type DerbyCarFlag = { id: number; name: string; alive: boolean; x: number; z: number };

type DerbyHud = {
  derby: boolean;
  winnerId: number | null;
  winnerName: string | null;
  decided: DerbyDecided | null;
  hold: number;
  board: DerbyBoardRow[];
};

type PairKey = string;

function pairKey(a: number, b: number): PairKey {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export class DerbyMatch {
  active = false;
  time = 0;
  winnerId: number | null = null;
  winnerName: string | null = null;
  decided: DerbyDecided | null = null;
  hold = 0;
  board: DerbyBoardRow[] = [];
  private lastHitAt = new Map<PairKey, number>();
  private lastScoredAt = new Map<PairKey, number>();
  private lastAttacker = new Map<number, number>();
  private wasAlive = new Map<number, boolean>();
  private boostQueue: number[] = [];
  readonly brain = new DerbyBrain();
  private snaps: AiCar[] = [];
  private readonly idle = idleDrive();
  /** Match time of each car's last aggressive hit on a live car. */
  private lastAggro = new Map<number, number>();
  /** Where each car last stopped, and since when (the still clock). */
  private still = new Map<number, { x: number; z: number; t: number }>();
  private readonly counted = new Set<number>();
  private hitClock = DERBY_RULES.hitClock;
  private timeLimit = STALEMATE;
  private round = 0;

  begin(cars: { id: number; name: string }[], opts: DerbyOptions = {}): void {
    this.active = true;
    this.time = 0;
    this.winnerId = null;
    this.winnerName = null;
    this.decided = null;
    this.hold = 0;
    this.lastHitAt.clear();
    this.lastScoredAt.clear();
    this.lastAttacker.clear();
    this.wasAlive.clear();
    this.boostQueue.length = 0;
    this.brain.reset();
    this.brain.radius = opts.radius ?? derbyRadius(cars.length);
    this.lastAggro.clear();
    this.still.clear();
    this.counted.clear();
    this.hitClock = opts.hitClock ?? DERBY_RULES.hitClock;
    this.timeLimit = opts.timeLimit ?? heatLimit(cars.length);
    const seed = opts.seed ?? ++this.round;
    for (const c of cars) this.brain.setAggression(c.id, fieldAggression(opts.aggression ?? DEFAULT_DERBY_AGGRESSION, seed, c.id));
    this.board = cars.map((c) => ({
      id: c.id,
      name: c.name,
      score: 0,
      hits: 0,
      disables: 0,
      alive: true,
      out: false,
      clock: Math.min(this.hitClock, DERBY_RULES.stillClock),
    }));
    for (const c of cars) {
      this.wasAlive.set(c.id, true);
      this.lastAggro.set(c.id, 0);
    }
  }

  end(): void {
    this.active = false;
    this.winnerId = null;
    this.winnerName = null;
    this.decided = null;
    this.hold = 0;
    this.board = [];
  }

  row(id: number): DerbyBoardRow | undefined {
    return this.board.find((r) => r.id === id);
  }

  /**
   * A contact, debounced per pair. An aggressive hit (≥ `DERBY_RULES.hitSpeed` into a live car) resets the
   * attacker's hit clock; a hard one (≥ `SCORE_SPEED`, once per pair per `SCORE_GAP`) also scores. Pushes don't.
   */
  noteHit(a: number, b: number, aIntoB: number, bIntoA: number, closing: number): boolean {
    if (!this.active || this.winnerId != null) return false;
    if (closing < 1.8) return false;
    const key = pairKey(a, b);
    const prev = this.lastHitAt.get(key) ?? -99;
    if (this.time - prev < HIT_DEBOUNCE) return false;
    this.lastHitAt.set(key, this.time);
    const attacker = aIntoB >= bIntoA ? a : b;
    const victim = attacker === a ? b : a;
    this.lastAttacker.set(victim, attacker);
    const row = this.row(attacker);
    const into = attacker === a ? aIntoB : bIntoA;
    if (into >= DERBY_RULES.hitSpeed && this.row(victim)?.alive && row?.alive) {
      this.lastAggro.set(attacker, this.time);
      if (into >= SCORE_SPEED && this.time - (this.lastScoredAt.get(key) ?? -99) >= SCORE_GAP) {
        this.lastScoredAt.set(key, this.time);
        row.score += HIT_POINTS;
        row.hits += 1;
      }
    }
    this.boostQueue.push(attacker);
    return true;
  }

  consumeBoosts(): number[] {
    const q = this.boostQueue.slice();
    this.boostQueue.length = 0;
    return q;
  }

  /** Engine just died — last car that tagged them gets the disable. */
  noteDisable(victim: number): void {
    if (!this.active || this.winnerId != null) return;
    const row = this.row(victim);
    if (row) row.alive = false;
    const attacker = this.lastAttacker.get(victim);
    if (attacker == null || attacker === victim) return;
    const ar = this.row(attacker);
    if (!ar || !ar.alive) return;
    ar.score += DISABLE_POINTS;
    ar.disables += 1;
    this.boostQueue.push(attacker);
  }

  /** Pooled per-car snapshots for one step; fill each with `snapshotAiCar`. */
  snapshots(count: number): AiCar[] {
    while (this.snaps.length < count) this.snaps.push(blankAiCar(this.snaps.length));
    this.snaps.length = count;
    return this.snaps;
  }

  /** Counted out by a count-out clock: the car takes no more input. */
  isOut(id: number): boolean {
    return this.counted.has(id);
  }

  /** Scratch input — apply before the next call. Counted-out cars read as dead to every driver. */
  think(self: AiCar, others: readonly AiCar[], dt: number): DriveInput {
    if (!this.active || this.winnerId != null || !self.alive || this.counted.has(self.id)) return this.idle;
    for (const o of others) if (this.counted.has(o.id)) o.alive = false;
    self.idle = this.time - (this.lastAggro.get(self.id) ?? 0);
    return this.brain.think(self, others, dt);
  }

  step(dt: number, flags: readonly DerbyCarFlag[]): "running" | "winner" | "loop" {
    if (!this.active) return "running";
    this.time += dt;
    for (const f of flags) {
      const row = this.row(f.id);
      if (row) row.alive = f.alive && !row.out;
      const was = this.wasAlive.get(f.id) ?? true;
      if (was && !f.alive) this.noteDisable(f.id);
      this.wasAlive.set(f.id, f.alive);
      const s = this.still.get(f.id);
      if (!s) this.still.set(f.id, { x: f.x, z: f.z, t: this.time });
      else if (Math.hypot(f.x - s.x, f.z - s.z) > DERBY_RULES.stillRadius) {
        s.x = f.x;
        s.z = f.z;
        s.t = this.time;
      }
    }

    if (this.winnerId != null) {
      this.hold += dt;
      if (this.hold >= WINNER_HOLD) return "loop";
      return "winner";
    }

    // Count-outs: no aggressive hit on a live car in `hitClock`, or no movement in `stillClock`.
    let countedNow = false;
    for (const r of this.board) {
      if (!r.alive) continue;
      const sinceHit = this.time - (this.lastAggro.get(r.id) ?? 0);
      const sinceMoved = this.time - (this.still.get(r.id)?.t ?? this.time);
      r.clock = Math.max(0, Math.min(this.hitClock - sinceHit, DERBY_RULES.stillClock - sinceMoved));
      if (r.clock > 0) continue;
      r.alive = false;
      r.out = true;
      this.counted.add(r.id);
      countedNow = true;
    }

    let live = 0;
    let lone: DerbyBoardRow | undefined;
    for (const r of this.board) {
      if (!r.alive) continue;
      live++;
      lone = r;
    }
    if (live === 1) {
      this.crown(lone!, countedNow ? "countout" : "wreck");
      return "winner";
    }
    if (live === 0) {
      const last = leader(this.board, false);
      if (last) this.crown(last, countedNow ? "countout" : "wreck");
      return this.winnerId != null ? "winner" : "running";
    }
    if (this.time >= this.timeLimit) {
      this.crown(leader(this.board, true)!, "time");
      return "winner";
    }
    return "running";
  }

  hud(): DerbyHud {
    return {
      derby: this.active,
      winnerId: this.winnerId,
      winnerName: this.winnerName,
      decided: this.decided,
      hold: this.hold,
      board: this.board.map((r) => ({ ...r })),
    };
  }

  private crown(row: DerbyBoardRow, how: DerbyDecided): void {
    this.winnerId = row.id;
    this.winnerName = row.name;
    this.decided = how;
    this.hold = 0;
  }
}

/** The few structural masses the brain reads. */
type CrushMass = {
  readonly name: string;
  readonly local: { readonly z: number };
  readonly rest: { readonly z: number };
};

function spent(nowLen: number, restLen: number): number {
  const span = restLen - 0.36;
  if (span <= 1e-6) return 0;
  return Math.max(0, Math.min(1, (restLen - nowLen) / span));
}

/**
 * Fill `out` from a live car. Nose / tail spent share come from the bumper
 * pair vs. the cell (same 0.36 m floor as `crumpleTravel`). Crumple is
 * plastic, so these only grow; engine block travel was tried and is mostly
 * elastic slosh (0.5–1.0 on cars with untouched noses).
 */
export function snapshotAiCar(
  out: AiCar,
  id: number,
  x: number,
  z: number,
  yaw: number,
  vx: number,
  vz: number,
  drivetrainAlive: boolean,
  masses: readonly CrushMass[],
): AiCar {
  out.id = id;
  out.x = x;
  out.z = z;
  out.yaw = yaw;
  out.vx = vx;
  out.vz = vz;
  out.alive = drivetrainAlive;
  let cellNow = 0;
  let cellRest = 0;
  let noseNow = 0;
  let noseRest = 0;
  let tailNow = 0;
  let tailRest = 0;
  for (const m of masses) {
    switch (m.name) {
      case "cell":
        cellNow = m.local.z;
        cellRest = m.rest.z;
        break;
      case "bumperFL":
      case "bumperFR":
        noseNow += m.local.z * 0.5;
        noseRest += m.rest.z * 0.5;
        break;
      case "bumperRL":
      case "bumperRR":
        tailNow += m.local.z * 0.5;
        tailRest += m.rest.z * 0.5;
        break;
    }
  }
  out.front = spent(noseNow - cellNow, noseRest - cellRest);
  out.rear = spent(cellNow - tailNow, cellRest - tailRest);
  // The engine sits in the nose: a flat nose is a car one hit from dead.
  out.damage = drivetrainAlive ? Math.max(out.front, out.rear * 0.5) : 1;
  return out;
}

/** The board's leader: highest score, lowest id on a tie; `aliveOnly` skips cars out of the heat. */
function leader(board: readonly DerbyBoardRow[], aliveOnly: boolean): DerbyBoardRow | undefined {
  let best: DerbyBoardRow | undefined;
  for (const r of board) {
    if (aliveOnly && !r.alive) continue;
    if (!best || r.score > best.score || (r.score === best.score && r.id < best.id)) best = r;
  }
  return best;
}
