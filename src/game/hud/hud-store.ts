import type { FxTier } from "../present/engine-post.ts";
import type { SceneId } from "../scenes/scene-id.ts";
import type { StackConfig } from "../scenes/stack-rig.ts";
import type { LabPresetId } from "../scenes/lab.ts";
import { crushStroke } from "../kernel/physics-core.js";
import { DEFAULT_REALISM } from "../vehicle/vehicle-classes.ts";
import { DRIVER_CARS, type RaceHud, type RaceView } from "../match/types.ts";
import type { CrashPhase } from "../match/phase.ts";
import type { SpecView } from "../present/engine-camera.ts";
import type { CarPart, PersonPick } from "../match/look-data.ts";
import type { DriverLook } from "../present/driver-look.ts";

type CompactStage = "open" | "contact" | "wells" | "mid" | "max";

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
  shot: { detached: string[]; doorDeg: number; latched: boolean; panelHinge: number; bodyMm: number } | null;
};

/** The stack scene's HUD slice (`CrashHudState.stack`). */
export type StackHud = StackConfig & { dropped: number; loadKn: (number | null)[]; crushMm: number[] };

/**
 * The Lab's HUD slice (`CrashHudState.lab`): its preset, and its last throw since the reset (null before one): what it met first
 * (`hit`: "car", a prop's name or "pegboard"; null while it flies), its speed then (m/s) and how many things it moved off their spots.
 */
export type LabHud = { preset: LabPresetId; shot: { hit: string | null; speed: number; fell: number } | null };

/**
 * The garage's HUD slice (`CrashHudState.garage`): each car part's colour as drawn, the driver as drawn and what the player
 * picked for him, and the spray can (on, radius m, palette colour).
 */
export type GarageHud = { car: Record<CarPart, number>; person: DriverLook; picked: PersonPick; spray: SprayTool };

/** The garage's spray can: on or off, its dot's radius (m) and its palette colour (`SPRAY_PALETTE` index, never 0). */
export type SprayTool = { on: boolean; radius: number; colour: number };

export type CrashHudState = {
  playing: boolean;
  looping: boolean;
  showRig: boolean;
  showParticles: boolean;
  showBarrier: boolean;
  showBalls: boolean;
  /** The fleet's jump ramps on the slab's ends. */
  showRamps: boolean;
  showCompactor: boolean;
  showPistons: boolean;
  pistons: PistonHud;
  showDoors: boolean;
  doors: DoorHud;
  /** The ejection range (null in every other scene): metres past the wall the thrown driver has reached, null before
   *  the throw; `landed` once he lies still. */
  range: { distance: number | null; landed: boolean } | null;
  showCorkscrew: boolean;
  /**
   * The stack scene (null in every other scene): its three settings, the cars in the stack so far (`dropped`), and per
   * car, bottom first, the weight above it (kN) and its roof's sink (mm), read off the sim's cars.
   */
  stack: StackHud | null;
  /** The Lab (null in every other scene): its preset and the last throw's readback. */
  lab: LabHud | null;
  /** The garage (null in every other scene). */
  garage: GarageHud | null;
  /** The scene a pick is fading to (the switch comes at the transition's black), else null; the scene buttons light it. */
  pendingScene: SceneId | null;
  /** This browser is in a netplay room (hosting or joined): the single-player scenes are not offered. */
  inRoom: boolean;
  autoRotate: boolean;
  autoSlomo: boolean;
  audioOn: boolean;
  /** Cinematic FX quality tier (F). */
  fxTier: FxTier;
  /** The tier is the automatic one (`present/auto-fx.ts`); a manual pick turns it off. */
  fxAuto: boolean;
  /** The Ultra tier was picked and is downloading (its code, sky and textures, about 3.5 MB); the tier changes when it arrives. */
  fxLoading: boolean;
  /**
   * Cel look held on at this strength (0-1), under the scene-switch pulse; null = Auto, the pulse alone. It shows
   * at the post tiers only (low / high).
   */
  celLook: number | null;
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
  /** How the derby was won: last car standing (wreck / count-out) or top score at the time limit. */
  derbyDecided: "wreck" | "countout" | "time" | null;
  /** Derby match time (s), negative before the green light (`startLights`); null with no match running. */
  derbyTime: number | null;
  /** The derby driver's gauge (speed, gear, boost; `racer` null); null unless driving a derby car. */
  derbyView: RaceView | null;
  /** The fleet driver's wreck state (`wheelsOff`, `canReset`) outside a race and a derby; null unless driving a sandbox car. Only the reset controls' glow reads it. */
  fleetView: RaceView | null;
  /** `id` is the car index; `watched` marks the car the camera follows or drives; `clock` is seconds to a count-out. */
  derbyBoard: { id: number; name: string; score: number; alive: boolean; out: boolean; clock: number; watched: boolean }[];
  /** Race scene state for the HUD; null outside race mode. */
  race: RaceHud | null;
  seat: "global" | "follow" | "drive";
  boost: number;
  view: "third" | "far" | "first";
  /** The followed (not driven) car's camera (View cycles it); null unless following a car off the rigs. */
  cam: SpecView | null;
  /** Connected gamepad label ("Xbox controller", …), null when none. */
  pad: string | null;
  /** Arcade (0) ↔ realistic (1) handling and damage. */
  realism: number;
  /** The player's car type (slot 0; every car in the Stack): a `DRIVER_CARS` id. */
  playerCar: string;
  /** Mouse look (pointer lock) is on. */
  mouseLook: boolean;
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
 * Knob domains; the engine setters clamp to the same bounds, and so does the share URL. Squash is the Stroke
 * slider's range; buckle only sizes the skin wrinkle, so it keeps the full range; realism is the arcade (0)
 * ↔ realistic (1) axis (`HANDLING.realism`). `speed` is the spawn speed (m/s), `fxDensity` the particle
 * density slider and `timeScale` the fixed slow-mo scale.
 */
export const KNOB_RANGES = {
  squash: { min: squashForStroke(STROKE_RANGE_M.min), max: squashForStroke(STROKE_RANGE_M.max) },
  buckle: { min: 0, max: 1 },
  realism: { min: 0, max: 1 },
  speed: { min: 0, max: 48 },
  fxDensity: { min: 0, max: 1.2 },
  cel: { min: 0, max: 1 },
  timeScale: { min: 0.02, max: 2 },
} as const;

export const INITIAL_HUD: CrashHudState = {
  playing: true,
  looping: true,
  showRig: false,
  showParticles: false,
  showBarrier: false,
  showBalls: false,
  showRamps: false,
  showCompactor: false,
  showPistons: false,
  pistons: { selected: 0, speedKph: 40, massKg: 1500, hardness: 1, holdCar: false, hopSeconds: 6.5, hopSynced: true, busy: false, energyKj: 0, ebsKph: 0 },
  showDoors: false,
  doors: { side: 1, kph: 12, kg: 300, open: false, busy: false, energyJ: 0, shot: null },
  range: null,
  showCorkscrew: false,
  stack: null,
  lab: null,
  garage: null,
  pendingScene: null,
  inRoom: false,
  autoRotate: true,
  autoSlomo: true,
  audioOn: false,
  fxTier: "minimal",
  fxAuto: true,
  fxLoading: false,
  celLook: null,
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
  carCount: 3,
  speedMin: 10,
  speedMax: 32,
  traceSamples: 0,
  wallGap: 0,
  compactStage: "open",
  fps: 0,
  captureTrace: false,
  derby: false,
  derbyWinner: null,
  derbyDecided: null,
  derbyTime: null,
  derbyView: null,
  fleetView: null,
  derbyBoard: [],
  race: null,
  seat: "global",
  boost: 1,
  view: "third",
  cam: null,
  pad: null,
  realism: DEFAULT_REALISM,
  playerCar: DRIVER_CARS[0]!.id,
  mouseLook: false,
};

/** The HUD's read model: the engine publishes a fresh snapshot, the UI subscribes. CrashLab makes one per engine. */
export class HudStore {
  private snapshot: CrashHudState = INITIAL_HUD;
  private readonly listeners = new Set<() => void>();

  readonly get = (): CrashHudState => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  publish(next: CrashHudState): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
