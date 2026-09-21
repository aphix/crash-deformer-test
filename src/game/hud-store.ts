export type CrashPhase = "approach" | "impact" | "slowmo" | "aftermath";
export type CompactStage = "open" | "contact" | "wells" | "mid" | "max";

export type CrashHudState = {
  playing: boolean;
  looping: boolean;
  showRig: boolean;
  showBarrier: boolean;
  showBalls: boolean;
  showCompactor: boolean;
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
};

export const INITIAL_HUD: CrashHudState = {
  playing: true,
  looping: true,
  showRig: false,
  showBarrier: false,
  showBalls: false,
  showCompactor: false,
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
