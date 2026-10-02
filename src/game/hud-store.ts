import type { FxTier } from "./engine-post.ts";
import { crushStroke } from "./physics-core.js";
import { DEFAULT_REALISM, type VehicleClassId } from "./vehicle-classes.ts";

export type CrashPhase = "approach" | "impact" | "slowmo" | "aftermath";
export type CompactStage = "open" | "contact" | "wells" | "mid" | "max";

/** Piston scene: selected ram (0–7, key order) and the shot config (mirrors `PISTON_DEFAULTS`). */
export type PistonHud = {
  selected: number;
  speedKph: number;
  massKg: number;
  hardness: number;
  holdCar: boolean;
  /** Loop seconds between shots when the orbit isn't pacing them. */
  hopSeconds: number;
  /** The orbit paces the loop (on, camera untouched): one shot per eighth of a turn, `hopSeconds` unused. */
  hopSynced: boolean;
  busy: boolean;
  /** Crush energy the car takes from this shot (kJ). */
  energyKj: number;
  /** Equivalent barrier speed of that energy (km/h). */
  ebsKph: number;
};

/** Doors scene: ram lane side, shot config, the selected door's state and the last shot's outcome. */
export type DoorHud = {
  /** −1 left door, +1 right. */
  side: -1 | 1;
  kph: number;
  kg: number;
  open: boolean;
  busy: boolean;
  /** Ram kinetic energy (J). */
  energyJ: number;
  shot: { detached: string[]; doorDeg: number; latched: boolean; bodyMm: number } | null;
};

export type CrashHudState = {
  playing: boolean;
  looping: boolean;
  showRig: boolean;
  showParticles: boolean;
  showBarrier: boolean;
  showBalls: boolean;
  showCompactor: boolean;
  showPistons: boolean;
  pistons: PistonHud;
  showDoors: boolean;
  doors: DoorHud;
  autoRotate: boolean;
  autoSlomo: boolean;
  audioOn: boolean;
  /** Cinematic FX quality tier (F). */
  fxTier: FxTier;
  /** Night lighting (H) and wet asphalt (X). */
  night: boolean;
  wet: boolean;
  deformMode: "shape" | "lattice";
  phase: CrashPhase;
  timeScale: number;
  userTimeScale: number | null;
  elapsed: number;
  speedA: number;
  speedB: number;
  closingKph: number;
  impactKph: number | null;
  eta: number;
  cageCount: number;
  sensorCount: number;
  squash: number;
  buckle: number;
  fxDensity: number;
  carCount: number;
  speedMin: number;
  speedMax: number;
  traceSamples: number;
  wallGap: number;
  compactStage: CompactStage;
  fps: number;
  captureTrace: boolean;
  derby: boolean;
  derbyWinner: string | null;
  /** `id` is the car index; `watched` marks the car the camera follows or drives. */
  derbyBoard: { id: number; name: string; score: number; alive: boolean; watched: boolean }[];
  seat: "global" | "follow" | "drive";
  boost: number;
  view: "third" | "far" | "first";
  /** Connected gamepad label ("Xbox controller", …), null when none. */
  pad: string | null;
  /** Arcade (0) ↔ realistic (1) handling and damage. */
  realism: number;
  /** The player's car class (slot 0). */
  playerClass: VehicleClassId;
};

/** The stroke slider reads out at 56 km/h, the NCAP full-frontal barrier speed. */
const STROKE_REF_MPS = 56 / 3.6;

/** Dynamic crush stroke (m) of a 56 km/h barrier hit at this squash (`crushStroke`). */
export function strokeAt56(squash: number): number {
  return crushStroke(STROKE_REF_MPS, squash);
}

/** Squash whose 56 km/h stroke is `m` metres (`crushStroke` is affine in squash). */
export function squashForStroke(m: number): number {
  const s0 = crushStroke(STROKE_REF_MPS, 0);
  return (m - s0) / (crushStroke(STROKE_REF_MPS, 1) - s0);
}

/** The Stroke slider's domain in metres at 56 km/h, around the measured realistic band (docs/CRUSH_CALIBRATION.md §0). */
export const STROKE_RANGE_M = { min: 0.4, max: 0.75 } as const;

/**
 * Knob domains; the engine setters clamp to the same bounds. Squash is the Stroke
 * slider's range; buckle only sizes the skin wrinkle, so it keeps the full range;
 * realism is the arcade (0) ↔ realistic (1) axis (`HANDLING.realism`).
 */
export const KNOB_RANGES = {
  squash: { min: squashForStroke(STROKE_RANGE_M.min), max: squashForStroke(STROKE_RANGE_M.max) },
  buckle: { min: 0, max: 1 },
  realism: { min: 0, max: 1 },
} as const;

export const INITIAL_HUD: CrashHudState = {
  playing: true,
  looping: true,
  showRig: false,
  showParticles: false,
  showBarrier: false,
  showBalls: false,
  showCompactor: false,
  showPistons: false,
  pistons: { selected: 0, speedKph: 40, massKg: 1500, hardness: 1, holdCar: false, hopSeconds: 6.5, hopSynced: true, busy: false, energyKj: 0, ebsKph: 0 },
  showDoors: false,
  doors: { side: 1, kph: 12, kg: 300, open: false, busy: false, energyJ: 0, shot: null },
  autoRotate: true,
  autoSlomo: true,
  audioOn: false,
  fxTier: "high",
  night: false,
  wet: false,
  deformMode: "shape",
  phase: "approach",
  timeScale: 1,
  userTimeScale: null,
  elapsed: 0,
  speedA: 0,
  speedB: 0,
  closingKph: 0,
  impactKph: null,
  eta: 0,
  cageCount: 16,
  sensorCount: 20,
  squash: 0.32,
  buckle: 0.45,
  fxDensity: 0.7,
  carCount: 2,
  speedMin: 0,
  speedMax: 32,
  traceSamples: 0,
  wallGap: 0,
  compactStage: "open",
  fps: 0,
  captureTrace: false,
  derby: false,
  derbyWinner: null,
  derbyBoard: [],
  seat: "global",
  boost: 1,
  view: "third",
  pad: null,
  realism: DEFAULT_REALISM,
  playerClass: "sedan",
};

let snapshot: CrashHudState = INITIAL_HUD;
const listeners = new Set<() => void>();

export function getHudSnapshot(): CrashHudState {
  return snapshot;
}

export function subscribeHud(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishHud(next: CrashHudState): void {
  snapshot = next;
  for (const listener of listeners) listener();
}
