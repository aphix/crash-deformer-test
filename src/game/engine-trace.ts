import type { DeformableCar } from "./car.ts";
import { compactorStage } from "./compactor.ts";
import type { DebrisSystem, SparkSystem, TireSmokeSystem } from "./engine-fx.ts";
import { BALL_EXPOSE, type JerseyBarrier, type RampBall } from "./engine-props.ts";
import type { CrashPhase } from "./phase.ts";
import { leftoverCrumple, round4, vec3 } from "./physics-util.ts";
import { BARRIER_MASS } from "./sat.ts";
import type { DeformMode } from "./streamed-deform.ts";

type TraceRecord = Record<string, unknown>;

/** Scene knobs stamped on the spawn snapshot and on every sample. */
export type TraceSetup = {
  barrier: boolean;
  barrierYaw: number;
  squash: number;
  buckle: number;
  fxDensity: number;
  balls: boolean;
  compactor: boolean;
  compactFace: number;
  carCount: number;
  speedMin: number;
  speedMax: number;
};

/** Engine clock and fleet aggregates for one sample. */
export type TraceClock = {
  wall: number;
  sim: number;
  phase: CrashPhase;
  timeScale: number;
  /** Fastest pairwise closing speed, m/s. */
  closing: number;
  barrierHit: boolean;
};

/** Long-lived scene objects the samples read; captured once at engine construction. */
type TraceScene = {
  barrier: JerseyBarrier;
  balls: readonly RampBall[];
  sparks: SparkSystem;
  smoke: TireSmokeSystem;
  debris: DebrisSystem;
};

const MAX_SAMPLES = 96;
const SAMPLE_EVERY = 0.25;

function nearestPairDist(cars: readonly DeformableCar[]): number {
  if (cars.length < 2) return 0;
  let best = Infinity;
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) {
      const d = cars[i]!.group.position.distanceTo(cars[j]!.group.position);
      if (d < best) best = d;
    }
  }
  return best;
}

/** 4 Hz crash capture (spawn snapshot + ≤96 samples) behind the HUD's JSON button. */
export class TraceRecorder {
  initial: TraceRecord | null = null;
  samples: TraceRecord[] = [];
  /** Ramp-ball kicks since capture began; every sample references this same array. */
  ballHits: TraceRecord[] = [];
  /** JSON button copied spawn while capture is off — HUD shows 1, does not tick. */
  setupCopied = false;
  private acc = 0;

  constructor(private readonly scene: TraceScene) {}

  snapshotInitial(setup: TraceSetup, cars: readonly DeformableCar[]): void {
    this.initial = {
      barrier: setup.barrier,
      barrierYaw: round4(setup.barrierYaw),
      squash: setup.squash,
      buckle: setup.buckle,
      fxDensity: setup.fxDensity,
      balls: setup.balls,
      compactor: setup.compactor,
      compactFace: round4(setup.compactFace),
      carCount: setup.carCount,
      speedMin: setup.speedMin,
      speedMax: setup.speedMax,
      cars: cars.map((car) => ({
        paint: car.paint.name,
        spawn: {
          x: round4(car.group.position.x),
          y: round4(car.group.position.y),
          z: round4(car.group.position.z),
        },
        yaw: round4(car.yaw),
        speed: round4(car.spawnSpeed),
        vel: vec3(car.velocity),
      })),
    };
  }

  /** Fresh capture: new arrays, spawn snapshot, first sample. */
  begin(setup: TraceSetup, cars: readonly DeformableCar[], clock: TraceClock): void {
    this.acc = 0;
    this.samples = [];
    this.ballHits = [];
    this.snapshotInitial(setup, cars);
    this.push(setup, cars, clock);
  }

  clear(): void {
    this.acc = 0;
    this.samples.length = 0;
    this.ballHits.length = 0;
  }

  /** Advance the sample clock; true when a sample is due while capturing. */
  due(wallDt: number, capturing: boolean): boolean {
    this.acc += wallDt;
    if (!capturing || this.acc < SAMPLE_EVERY) return false;
    this.acc = 0;
    return true;
  }

  push(setup: TraceSetup, cars: readonly DeformableCar[], clock: TraceClock): void {
    if (this.samples.length >= MAX_SAMPLES) return;
    const { barrier, balls, sparks, smoke, debris } = this.scene;
    this.samples.push({
      t: Math.round(clock.wall * 1000) / 1000,
      sim: Math.round(clock.sim * 1000) / 1000,
      phase: clock.phase,
      timeScale: Math.round(clock.timeScale * 1000) / 1000,
      squash: setup.squash,
      buckle: setup.buckle,
      fxDensity: setup.fxDensity,
      compactFace: round4(setup.compactFace),
      compactStage: compactorStage(setup.compactFace),
      closing: Math.round(clock.closing * 3.6 * 10) / 10,
      collision: {
        leftover: cars.map((c) => round4(leftoverCrumple(c.deform.crumpleTravelCorner()))),
        transfer: cars.map((c) => round4(c.deform.frontTransfer())),
        dist: round4(nearestPairDist(cars)),
        barrierHit: clock.barrierHit,
        barrierCrush: round4(barrier.crush),
      },
      ballHits: this.ballHits,
      barrier: {
        pos: vec3(barrier.group.position),
        vel: vec3(barrier.vel),
        yaw: round4(barrier.yaw),
        crush: round4(barrier.crush),
        mass: BARRIER_MASS,
      },
      balls: balls.map((b) => ({
        intact: b.intact,
        radius: round4(b.radius),
        expose: BALL_EXPOSE,
        kicked: [...b.kicked],
        pos: vec3(b.mesh.position),
      })),
      particles: {
        sparks: sparks.snapshot(),
        smoke: smoke.snapshot(),
        debris: debris.snapshot(),
      },
      cars: cars.map((c) => c.snapshot()),
    });
  }

  /** Spawn-only export used while capture is off. */
  setupJson(deformMode: DeformMode, autoSlomo: boolean, timeScale: number | null): string {
    this.setupCopied = true;
    return JSON.stringify(
      {
        version: 1,
        kind: "setup",
        capturedAt: new Date().toISOString(),
        deformMode,
        autoSlomo,
        timeScale,
        ...this.initial,
      },
      null,
      2,
    );
  }

  traceJson(setup: TraceSetup, deformMode: DeformMode): string {
    return JSON.stringify(
      {
        version: 1,
        capturedAt: new Date().toISOString(),
        squash: setup.squash,
        buckle: setup.buckle,
        deformMode,
        fxDensity: setup.fxDensity,
        barrier: setup.barrier,
        balls: setup.balls,
        compactor: setup.compactor,
        carCount: setup.carCount,
        speedMin: setup.speedMin,
        speedMax: setup.speedMax,
        barrierYaw: setup.barrierYaw,
        captureTrace: true,
        initial: this.initial,
        ballHits: this.ballHits,
        samples: this.samples,
      },
      null,
      2,
    );
  }
}
