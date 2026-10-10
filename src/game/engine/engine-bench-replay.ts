import type { RagdollStats } from "../present/engine-ragdoll.ts";
import { stat, type Pair, type RagdollCost, type ReplayTier, type Stat } from "./engine-bench-report.ts";

/**
 * The replay the bench ends on (docs/PERF_BENCH.md): the run's own crash, recorded on this build, played back as the highlight reel at each
 * FX tier in turn. These are its fixed numbers (the same on every device) and the pure parts that turn frames into the card's rows.
 */

/** Wall seconds the reel plays at each FX tier, scored, after `REPLAY_SETTLE_S` unscored (the replay's world is built on a tier's first frames). The reel opens on `FLIGHT_S` of overhead flight, then the crash. */
export const REPLAY_TIER_S = 12;
export const REPLAY_SETTLE_S = 0.5;
/** The scripted crash: the two front-row racers put head-on `CRASH_GAP` m apart (centre to centre) on the start line, each at `CRASH_SPEED` m/s (closing 180 km/h: a driver is thrown). */
export const CRASH_GAP = 12;
export const CRASH_SPEED = 25;
/** Wall seconds the bench waits for the restarted race to go green, and then for the crash's clip to be filed (its post-roll runs on the race clock), at most. */
export const START_WAIT_S = 20;
export const CLIP_WAIT_S = 20;

/** A `Stat`'s mean and 95th percentile. */
const pairOf = (s: Stat): Pair => ({ mean: s.mean, p95: s.p95 });

/**
 * The cosmetic Rapier world's cost since step count `from`: the steps run, the mean and p95 of their ms (the newest `stats.log.length`
 * of them when more ran than the log holds), and the world's size now.
 */
export function ragdollCost(stats: RagdollStats, from: number): RagdollCost {
  const steps = Math.max(0, stats.steps - from);
  const n = Math.min(steps, stats.log.length);
  const ms = new Float64Array(n);
  for (let i = 0; i < n; i++) ms[i] = stats.log[(stats.steps - n + i) % stats.log.length]!;
  return { steps, stepMs: pairOf(stat(ms)), colliders: stats.colliders, bodies: stats.bodies };
}

/** One value per replayed frame at one tier: the frame interval (ms), the engine's frame, its sim and its draw (ms). */
export interface ReplayFrames {
  n: number;
  iv: Float64Array;
  cpu: Float64Array;
  sim: Float64Array;
  draw: Float64Array;
}

/** A tier's row from its frames, the mean GPU draw time of its timer-query block (null: the device has none) and the ragdoll world's cost during it. */
export function replayTier(f: ReplayFrames, gpuMs: number | null, ragdoll: RagdollCost): ReplayTier {
  let wallMs = 0;
  for (let i = 0; i < f.n; i++) wallMs += f.iv[i]!;
  const frameMs = stat(f.iv, f.n);
  return {
    frames: f.n,
    wallS: wallMs / 1000,
    fps: wallMs > 0 ? (1000 * f.n) / wallMs : 0,
    fpsLow1: frameMs.p99 > 0 ? 1000 / frameMs.p99 : 0,
    frameMs: pairOf(frameMs),
    cpuMs: pairOf(stat(f.cpu, f.n)),
    simMs: pairOf(stat(f.sim, f.n)),
    renderMs: pairOf(stat(f.draw, f.n)),
    gpuMs,
    ragdoll,
  };
}
