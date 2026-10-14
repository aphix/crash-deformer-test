import { CHASE_KNOBS, type ChaseKnobId } from "../present/drive-cam.ts";
import { INITIAL_HUD, type CrashHudState } from "./hud-store.ts";

/** The settings menu's sections (`HudSections`). */
export type SectionId = "playback" | "driving" | "tuning" | "debug";

const D = INITIAL_HUD;

/** Whether the Cars and Spawn rows are on screen: the other scenes set their cars up themselves. */
export function fleetLaunched(s: CrashHudState): boolean {
  return !s.race && !s.derby && !s.showCompactor && !s.showPistons && !s.showDoors && !s.stack && !s.range;
}

type Setting = {
  section: SectionId;
  label: string;
  /** The HUD fields the setting owns, at their defaults: it is changed when any of them differs, and a reset puts exactly these back. */
  defaults: Partial<CrashHudState>;
  /** Not on screen (so never counted) when false. */
  shown?: (s: CrashHudState) => boolean;
};

/** The menu's settings but the camera sliders, in menu order. Auto FX, Auto cel and Auto time scale are the defaults. */
const BASE_SETTINGS = {
  loop: { section: "playback", label: "Loop", defaults: { looping: D.looping } },
  slomo: { section: "playback", label: "Slow-mo", defaults: { autoSlomo: D.autoSlomo } },
  orbit: { section: "playback", label: "Orbit", defaults: { autoRotate: D.autoRotate } },
  audio: { section: "playback", label: "Audio", defaults: { audioOn: D.audioOn } },
  music: { section: "playback", label: "Music volume", defaults: { musicVolume: D.musicVolume } },
  engines: { section: "playback", label: "Engine volume", defaults: { engineVolume: D.engineVolume } },
  night: { section: "playback", label: "Night", defaults: { night: D.night } },
  wet: { section: "playback", label: "Wet", defaults: { wet: D.wet } },
  fx: { section: "playback", label: "FX", defaults: { fxAuto: true } },
  cel: { section: "playback", label: "Cel look", defaults: { celLook: D.celLook } },
  ts: { section: "playback", label: "Time scale", defaults: { userTimeScale: D.userTimeScale } },
  car: { section: "driving", label: "Car", defaults: { playerCar: D.playerCar } },
  realism: { section: "driving", label: "Realism", defaults: { realism: D.realism } },
  rumble: { section: "driving", label: "Rumble", defaults: { rumble: D.rumble } },
  cars: { section: "tuning", label: "Cars", defaults: { carCount: D.carCount }, shown: fleetLaunched },
  spawn: { section: "tuning", label: "Spawn speed", defaults: { speedMin: D.speedMin, speedMax: D.speedMax }, shown: fleetLaunched },
  stroke: { section: "tuning", label: "Crush stroke", defaults: { squash: D.squash } },
  wrinkle: { section: "tuning", label: "Panel wrinkle", defaults: { buckle: D.buckle } },
  fxd: { section: "tuning", label: "Particle density", defaults: { fxDensity: D.fxDensity } },
  deform: { section: "tuning", label: "Solver", defaults: { deformMode: D.deformMode } },
  rig: { section: "debug", label: "Rig", defaults: { showRig: D.showRig } },
  particles: { section: "debug", label: "Particles", defaults: { showParticles: D.showParticles } },
  capture: { section: "debug", label: "Capture", defaults: { captureTrace: D.captureTrace } },
} as const satisfies Record<string, Setting>;

/** One setting per camera slider (`CHASE_KNOBS`), under the knob's own id: its HUD field is the one at its default. The cast holds: a row per `ChaseKnobId` (pinned by test). */
const CAMERA_SETTINGS = {} as Record<ChaseKnobId, Setting>;
for (const k of CHASE_KNOBS) CAMERA_SETTINGS[k.id] = { section: "debug", label: `Camera ${k.group.toLowerCase()} ${k.label}`, defaults: { [k.id]: D[k.id] } };

export const SETTINGS: typeof BASE_SETTINGS & Record<ChaseKnobId, Setting> = { ...BASE_SETTINGS, ...CAMERA_SETTINGS };
export type SettingId = keyof typeof SETTINGS;
export const SETTING_IDS = Object.keys(SETTINGS) as SettingId[];

/** Numbers differ at the precision the share URL keeps (4 decimals), so a slider dragged back onto its default is unchanged. */
function differs(a: unknown, b: unknown): boolean {
  return typeof a === "number" && typeof b === "number" ? Math.round(a * 1e4) !== Math.round(b * 1e4) : a !== b;
}

/** Whether setting `id` differs from its default. */
export function isChanged(s: CrashHudState, id: SettingId): boolean {
  const { defaults, shown } = SETTINGS[id] as Setting;
  if (shown && !shown(s)) return false;
  return Object.entries(defaults).some(([k, v]) => differs(s[k as keyof CrashHudState], v));
}

/** The settings of `section` (all when omitted) that differ from their defaults, in menu order. */
export function changedSettings(s: CrashHudState, section?: SectionId): SettingId[] {
  return SETTING_IDS.filter((id) => (section === undefined || SETTINGS[id].section === section) && isChanged(s, id));
}
