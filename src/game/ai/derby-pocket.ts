import { hypot2 } from "../kernel/physics-core.js";
import { hash01 } from "../kernel/scalar.ts";
import { MAX_CARS } from "../scenes/fleet.ts";

/**
 * Deadlock breaker for the derby brain. A driver that wants to keep clear but stays inside POCKET m of one spot for DWELL s
 * is pacing, not keeping clear: the rivals and wrecks round it leave no move that helps, and the gear flips every 0.7 s on
 * the `|aim| < 0.25` line (owner capture `derby-scoot-2026-10-04`: four cars, no hit for 20 s). It drops the caution and
 * attacks for up to BRAVE s, or until its hit lands. DWELL and BRAVE scale a per-driver hash roll (0.5 … 1.5 ×), so a
 * field of sandbaggers never breaks out on the same tick; the roll count advances the hash, never `Math.random`, so a
 * replay and the netplay host agree. Measured in `derby-ai.test.ts` (late-heat scoot share) and docs/DERBY_AI.md.
 */
const POCKET = 9;
const DWELL = 6;
const BRAVE = 6;

export class DerbyPocket {
  /** Per car: where the pocket began, seconds spent in it, seconds of bravery left, the idle clock it began at and the rolls so far. */
  private readonly x = new Float64Array(MAX_CARS);
  private readonly z = new Float64Array(MAX_CARS);
  private readonly dwell = new Float64Array(MAX_CARS);
  private readonly braveFor = new Float64Array(MAX_CARS);
  private readonly braveIdle = new Float64Array(MAX_CARS);
  private readonly rolls = new Uint16Array(MAX_CARS);

  reset(): void {
    this.x.fill(Number.NaN);
    this.z.fill(Number.NaN);
    this.dwell.fill(0);
    this.braveFor.fill(0);
    this.braveIdle.fill(0);
    this.rolls.fill(0);
  }

  /**
   * Whether driver `i`, at (`x`, `z`) with `idle` s since its last aggressive hit, has dropped its caution this tick.
   * `clear`: it wants to keep clear right now (mood, hit clock and rivals left say so).
   */
  bold(i: number, x: number, z: number, idle: number, clear: boolean, dt: number): boolean {
    if (this.braveFor[i]! > 0) {
      this.braveFor[i]! -= dt;
      if (idle >= this.braveIdle[i]!) return true;
      this.braveFor[i] = 0;
    }
    if (!clear || !(hypot2(x - this.x[i]!, z - this.z[i]!) <= POCKET)) {
      this.x[i] = x;
      this.z[i] = z;
      this.dwell[i] = 0;
      return false;
    }
    this.dwell[i]! += dt;
    const roll = this.rolls[i]!;
    if (this.dwell[i]! < DWELL * (0.5 + hash01(i, 30 + roll))) return false;
    this.rolls[i] = roll + 1;
    this.braveFor[i] = BRAVE * (0.5 + hash01(i, 60 + roll));
    this.braveIdle[i] = idle;
    this.dwell[i] = 0;
    return true;
  }
}
