import { DerbyBrain, blankAiCar, type AiCar } from "./derby-ai.ts";
import { idleDrive, type DriveInput } from "./car-drive.ts";

export const HIT_POINTS = 1;
export const DISABLE_POINTS = 10;
export const HIT_DEBOUNCE = 0.45;
export const WINNER_HOLD = 4.4;
export const STALEMATE = 90;

export type DerbyBoardRow = {
  id: number;
  name: string;
  score: number;
  hits: number;
  disables: number;
  alive: boolean;
};

export type DerbyHud = {
  derby: boolean;
  winnerId: number | null;
  winnerName: string | null;
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
  hold = 0;
  board: DerbyBoardRow[] = [];
  private lastHitAt = new Map<PairKey, number>();
  private lastAttacker = new Map<number, number>();
  private wasAlive = new Map<number, boolean>();
  private boostQueue: number[] = [];
  readonly brain = new DerbyBrain();
  private snaps: AiCar[] = [];
  private readonly idle = idleDrive();

  begin(cars: { id: number; name: string }[]): void {
    this.active = true;
    this.time = 0;
    this.winnerId = null;
    this.winnerName = null;
    this.hold = 0;
    this.lastHitAt.clear();
    this.lastAttacker.clear();
    this.wasAlive.clear();
    this.boostQueue.length = 0;
    this.brain.reset();
    this.board = cars.map((c) => ({
      id: c.id,
      name: c.name,
      score: 0,
      hits: 0,
      disables: 0,
      alive: true,
    }));
    for (const c of cars) this.wasAlive.set(c.id, true);
  }

  end(): void {
    this.active = false;
    this.winnerId = null;
    this.winnerName = null;
    this.hold = 0;
    this.board = [];
  }

  row(id: number): DerbyBoardRow | undefined {
    return this.board.find((r) => r.id === id);
  }

  /**
   * A contact. Debounced per pair. The aggressor (closing into the other)
   * gets HIT_POINTS.
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
    const row = this.row(attacker);
    if (row && row.alive) {
      row.score += HIT_POINTS;
      row.hits += 1;
    }
    this.lastAttacker.set(victim, attacker);
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

  /** Scratch input — apply before the next call. */
  think(self: AiCar, others: readonly AiCar[], dt: number): DriveInput {
    if (!this.active || this.winnerId != null || !self.alive) return this.idle;
    return this.brain.think(self, others, dt);
  }

  step(dt: number, aliveFlags: { id: number; name: string; alive: boolean }[]): "running" | "winner" | "loop" {
    if (!this.active) return "running";
    this.time += dt;
    for (const f of aliveFlags) {
      const row = this.row(f.id);
      if (row) row.alive = f.alive;
      const was = this.wasAlive.get(f.id) ?? true;
      if (was && !f.alive) this.noteDisable(f.id);
      this.wasAlive.set(f.id, f.alive);
    }

    if (this.winnerId != null) {
      this.hold += dt;
      if (this.hold >= WINNER_HOLD) return "loop";
      return "winner";
    }

    const live = this.board.filter((r) => r.alive);
    if (live.length === 1) {
      this.crown(live[0]!);
      return "winner";
    }
    if (live.length === 0) {
      const last = [...this.board].sort((a, b) => b.score - a.score || a.id - b.id)[0];
      if (last) this.crown(last);
      return this.winnerId != null ? "winner" : "running";
    }
    if (this.time >= STALEMATE) {
      const top = [...live].sort((a, b) => b.score - a.score || a.id - b.id)[0]!;
      this.crown(top);
      return "winner";
    }
    return "running";
  }

  hud(): DerbyHud {
    return {
      derby: this.active,
      winnerId: this.winnerId,
      winnerName: this.winnerName,
      hold: this.hold,
      board: this.board.map((r) => ({ ...r })),
    };
  }

  private crown(row: DerbyBoardRow): void {
    this.winnerId = row.id;
    this.winnerName = row.name;
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
