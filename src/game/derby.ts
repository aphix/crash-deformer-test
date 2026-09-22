import { leftoverCrumple } from "./physics-util.ts";
import { thinkDerby, engineDamage, type AiCar } from "./derby-ai.ts";
import { idleDrive, type DriveInput } from "./car-drive.ts";
import { DERBY_RADIUS } from "./derby-arena.ts";

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

  think(self: AiCar, others: AiCar[]): DriveInput {
    if (!this.active || this.winnerId != null || !self.alive) return idleDrive();
    return thinkDerby(self, others, { radius: DERBY_RADIUS, time: this.time });
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

export function snapshotAiCar(
  id: number,
  name: string,
  x: number,
  z: number,
  yaw: number,
  vx: number,
  vz: number,
  drivetrainAlive: boolean,
  crumpleTravel: number,
): AiCar {
  void name;
  return {
    id,
    x,
    z,
    yaw,
    vx,
    vz,
    alive: drivetrainAlive,
    damage: engineDamage(drivetrainAlive, crumpleTravel),
  };
}
