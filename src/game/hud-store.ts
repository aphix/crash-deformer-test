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
  squash: 0.4,
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
