import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import { compactorStage } from "../scenes/compactor.ts";
import { BALL_EXPOSE, type JerseyBarrier, type RampBall } from "../scenes/engine-props.ts";
import type { CrashPhase } from "../match/phase.ts";
import { leftoverCrumple, round4, vec3 } from "../deform/physics-util.ts";
import { BARRIER_MASS } from "../contact/sat.ts";
import type { DeformMode } from "../deform/deform-rig.ts";

type TraceRecord = Record<string, unknown>;

/** A particle system's trace view (`SparkSystem`, `TireSmokeSystem`, `DebrisSystem`). */
type Snapshot = { snapshot(): unknown };

/** The copied JSON, indented, except each sample's camera: one line (indented, its number arrays cost twice as much). */
const pretty = (v: unknown): string =>
  JSON.stringify(v, null, 2).replace(/"camera": \{[^{}]*\}/g, (m) => `"camera": ${JSON.stringify(JSON.parse(m.slice(10)))}`);

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const _dir = new THREE.Vector3();

/** What the owner sees: the eye, its lens and which rig put it there (`CrashEngine.cameraRig`). */
function cameraJson(camera: THREE.PerspectiveCamera, rig: string, follow: string | null): TraceRecord {
  const p = camera.position;
  const q = camera.quaternion;
  const d = _dir.set(0, 0, -1).applyQuaternion(q);
  return {
    rig,
    follow,
    pos: [r3(p.x), r3(p.y), r3(p.z)],
    quat: [r3(q.x), r3(q.y), r3(q.z), r3(q.w)],
    dir: [r3(d.x), r3(d.y), r3(d.z)],
    fov: r3(camera.fov),
  };
}

/** Every HUD setting that changes what the screen shows or how the run plays, plus the canvas it is drawn on. */
function settingsJson(s: TraceSetup): TraceRecord {
  return {
    scene: s.scene,
    seed: s.seed,
    night: s.night,
    wet: s.wet,
    realism: s.realism,
    fxTier: s.fxTier,
    loop: s.loop,
    autoSlomo: s.autoSlomo,
    timeScale: s.userTimeScale,
    deformMode: s.deformMode,
    playerClass: s.playerClass,
    viewport: { w: s.viewW, h: s.viewH },
    pixelRatio: s.pixelRatio,
    dpr: s.dpr,
  };
}

/** Scene knobs stamped on the spawn snapshot and on every sample. */
export type TraceSetup = {
  barrier: boolean;
  barrierYaw: number;
  squash: number;
  buckle: number;
  fxDensity: number;
  balls: boolean;
  /** The fleet's jump ramps, lined up with `barrierYaw`. */
  ramps: boolean;
  compactor: boolean;
  compactFace: number;
  carCount: number;
  speedMin: number;
  speedMax: number;
  /** `userTimeScale`: the HUD's fixed time scale, null while the auto slow-mo drives. */
  scene: string;
  /** `sceneSeed`: the run's spawn seed, the share URL's `seed=`. */
  seed: number;
  night: boolean;
  wet: boolean;
  realism: number;
  fxTier: string;
  loop: boolean;
  autoSlomo: boolean;
  userTimeScale: number | null;
  deformMode: DeformMode;
  playerClass: string;
  /** The renderer's drawing buffer, px (so it already includes `pixelRatio`). */
  viewW: number;
  viewH: number;
  /** The renderer's (capped) ratio, and the device's own. */
  pixelRatio: number;
  dpr: number;
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
  /** The shared lens, which rig framed the last frame and the car it follows. */
  camera: THREE.PerspectiveCamera;
  rig: string;
  follow: string | null;
};

/** Long-lived scene objects the samples read; captured once at engine construction. */
type TraceScene = {
  barrier: JerseyBarrier;
  balls: readonly RampBall[];
  sparks: Snapshot;
  smoke: Snapshot;
  debris: Snapshot;
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

  private readonly scene: TraceScene;

  constructor(scene: TraceScene) {
    this.scene = scene;
  }

  snapshotInitial(setup: TraceSetup, cars: readonly DeformableCar[]): void {
    this.initial = {
      barrier: setup.barrier,
      barrierYaw: round4(setup.barrierYaw),
      squash: setup.squash,
      buckle: setup.buckle,
      fxDensity: setup.fxDensity,
      balls: setup.balls,
      ramps: setup.ramps,
      compactor: setup.compactor,
      compactFace: round4(setup.compactFace),
      carCount: setup.carCount,
      speedMin: setup.speedMin,
      speedMax: setup.speedMax,
      ...settingsJson(setup),
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
    this.sample(setup, cars, clock);
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

  sample(setup: TraceSetup, cars: readonly DeformableCar[], clock: TraceClock): void {
    if (this.samples.length >= MAX_SAMPLES) return;
    const { barrier, balls, sparks, smoke, debris } = this.scene;
    this.samples.push({
      t: Math.round(clock.wall * 1000) / 1000,
      sim: Math.round(clock.sim * 1000) / 1000,
      phase: clock.phase,
      timeScale: Math.round(clock.timeScale * 1000) / 1000,
      camera: cameraJson(clock.camera, clock.rig, clock.follow),
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
  setupJson(setup: TraceSetup): string {
    this.setupCopied = true;
    return pretty({
      version: 1,
      kind: "setup",
      capturedAt: new Date().toISOString(),
      ...this.initial,
      ...settingsJson(setup),
    });
  }

  /** What the JSON button copies while a capture is on, as an object (`traceJson`'s text, and what Submit sends). */
  traceRecord(setup: TraceSetup): TraceRecord {
    return {
      version: 1,
      capturedAt: new Date().toISOString(),
      squash: setup.squash,
      buckle: setup.buckle,
      fxDensity: setup.fxDensity,
      barrier: setup.barrier,
      balls: setup.balls,
      ramps: setup.ramps,
      compactor: setup.compactor,
      carCount: setup.carCount,
      speedMin: setup.speedMin,
      speedMax: setup.speedMax,
      barrierYaw: setup.barrierYaw,
      ...settingsJson(setup),
      captureTrace: true,
      initial: this.initial,
      ballHits: this.ballHits,
      samples: this.samples,
    };
  }

  traceJson(setup: TraceSetup): string {
    return pretty(this.traceRecord(setup));
  }
}
