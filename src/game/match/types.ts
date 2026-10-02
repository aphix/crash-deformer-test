/**
 * Race contracts shared by the rules (`session.ts`), campaign, AI, engine glue and HUD.
 * Everything here is plain JSON-able data: a host can ship it to peers as is. Plus the player's
 * pick (`DRIVER_CARS`, `cleanName`), which the HUD stores and the engine and netplay read.
 */

import { CAR_STYLE_IDS, type CarStyleId } from "../vehicle/car-variants.ts";
import { CLASSES, STYLE_CLASS, VEHICLE_CLASS_IDS, type VehicleClassId } from "../vehicle/vehicle-classes.ts";

/** Longest player name (characters) on the standings and on the wire. */
export const NAME_MAX = 16;

/**
 * A player's name as typed, or as a peer sent it (untrusted, shown to everyone): whitespace runs
 * (tabs, newlines) become one space, other control and format characters (bidi overrides,
 * zero-width) are dropped, combining marks capped at 2 per letter, trimmed, at most `NAME_MAX`
 * characters. "" when nothing is left.
 */
export function cleanName(raw: string): string {
  const s = raw.replace(/\s+/g, " ").replace(/\p{C}/gu, "").replace(/(\p{M}{2})\p{M}+/gu, "$1").trim();
  return [...s].slice(0, NAME_MAX).join("").trim();
}

/**
 * The setup menu's car types: every vehicle class on its own body, then every other body style on
 * the class it drives as. `id` is what the HUD stores; the engine builds slot 0 from `cls` and `style`.
 */
export const DRIVER_CARS: readonly { id: string; label: string; cls: VehicleClassId; style: CarStyleId }[] = [
  ...VEHICLE_CLASS_IDS.map((cls) => ({ id: cls, label: CLASSES[cls].label, cls, style: CLASSES[cls].style })),
  ...CAR_STYLE_IDS.filter((style) => CLASSES[STYLE_CLASS[style]].style !== style).map((style) => ({
    id: style,
    label: style[0]!.toUpperCase() + style.slice(1),
    cls: STYLE_CLASS[style],
    style,
  })),
];

/** Who feeds a car's `DriveInput`: this browser's seat, a race brain, or (later) a network peer. */
type SlotKind = "player" | "ai" | "remote";

export type Entrant = {
  /** Stable car id for the whole race (engine car index today; a peer-assigned id later). */
  id: number;
  name: string;
  kind: SlotKind;
  /** 0 clean racer … 1 rams and blocks. AI only; ignored for other kinds. */
  aggression: number;
};

export type RaceOptions = {
  trackId: string;
  /** 1–5 in the menu; the rules accept any ≥ 1. */
  laps: number;
  /** A dead car is out for good; last car alive also wins. */
  noReset: boolean;
  /** AI opponents (the field is aiCount + players). */
  aiCount: number;
  /** Field aggression 0–1; each AI gets a personal spread around it. */
  aggression: number;
  /** Watch only: this browser's car is one more AI racer and the camera follows the field (no player car). */
  spectate: boolean;
  /** Police chase: packs of police cars park beside the course from a third of the first lap on and hunt the racers. */
  police: boolean;
};

export const DEFAULT_RACE_OPTIONS: RaceOptions = { trackId: "oval", laps: 3, noReset: false, aiCount: 7, aggression: 0.35, spectate: false, police: false };

/** Per-step input to the rules for one car (same order as the entrants). */
export type CarPose = {
  x: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  /** False once the car is dead (drivetrain gone, or wrecked/stuck as the host judges). */
  alive: boolean;
};

export type RacePhase = "grid" | "countdown" | "racing" | "finished";

export type CarStatus = "racing" | "respawning" | "finished" | "out" | "dnf";

export type CarRecord = {
  id: number;
  name: string;
  kind: SlotKind;
  /** Grid slot (0 = pole). */
  grid: number;
  status: CarStatus;
  /** Completed laps. */
  lap: number;
  /** Next main checkpoint to cross. */
  next: number;
  /** Crossed the start line once (the grid sits behind it). */
  armed: boolean;
  /** Shortcut index being driven (−1 = main route) and the next gate in it. */
  route: number;
  routeNext: number;
  /** Ranking distance (m): lap × length + checkpoint-clamped arc length. */
  progress: number;
  /** Live position 1..n, final once the race is over. */
  place: number;
  /** Race time (s) the current lap started. */
  lapStart: number;
  lapTimes: number[];
  bestLap: number | null;
  /** Race time at the finish line (or at the last-alive win). */
  finishTime: number | null;
  /** Seconds behind the first car through the last main gate this car crossed (same lap); null before the line. */
  split: number | null;
  outTime: number | null;
  wrongWay: boolean;
  /** Crossed a checkpoint ahead of the one it owes (a cut): the lap won't count until it goes back. */
  missed: boolean;
  /** Race time the pending respawn fires, null when none. */
  respawnAt: number | null;
  deaths: number;
  /** Last reported position (gate crossings test the move from here). */
  x: number;
  z: number;
  /** Seconds of travel against the track; `wrongWay` turns on at `WRONG_WAY_ON`. */
  wrongFor: number;
  /** Projection hint: last nearest sample on the path being driven (−1 = none). */
  seg: number;
};

export type RaceEvent =
  | { type: "go" }
  | { type: "lap"; id: number; lap: number; time: number }
  | { type: "died"; id: number; respawnAt: number }
  | { type: "respawn"; id: number; x: number; z: number; yaw: number }
  | { type: "out"; id: number }
  | { type: "finish"; id: number; place: number; time: number }
  | { type: "over"; winnerId: number | null };

export type WinBy = "laps" | "survival";

export type RaceSnapshot = {
  trackId: string;
  laps: number;
  noReset: boolean;
  phase: RacePhase;
  /** Race clock (s): negative through grid and countdown, 0 at the green light. */
  time: number;
  /** 0 off, 1 red, 2 yellow, 3 green. */
  lights: 0 | 1 | 2 | 3;
  winnerId: number | null;
  winBy: WinBy | null;
  cars: CarRecord[];
  /** Car ids in live position order. */
  order: number[];
  /** First crossing time per (lap × gates + gate), null until someone crosses (split timing). */
  firstAt: (number | null)[];
};

export type RaceResultRow = {
  id: number;
  name: string;
  kind: SlotKind;
  place: number;
  status: CarStatus;
  /** Finish time (s) for finishers, else null. */
  time: number | null;
  /** Seconds behind the winner (finishers only, 0 for the winner). */
  gap: number | null;
  bestLap: number | null;
  laps: number;
};

export type CampaignRow = {
  id: number;
  name: string;
  kind: SlotKind;
  /** The rival's aggression, rolled once and kept for every round of the campaign. */
  aggression: number;
  points: number;
  wins: number;
  /** Finishing place per completed round (0 = did not start). */
  places: number[];
};

export type CampaignSnapshot = {
  tracks: string[];
  /** Index of the round being raced or about to be raced; tracks.length when complete. */
  round: number;
  /** Car ids in round-1 grid order (the last tie-break). */
  entry: number[];
  standings: CampaignRow[];
};

/**
 * UI → engine (`CrashEngine.raceCommand`). The HUD never touches race state; it sends these.
 * setup menu: options / start / campaign / quit · pause menu: resume / retry / end / quit ·
 * dead menu: retry / end / spectate · results: retry / next / quit · standings: next / quit.
 */
export type RaceCommand =
  | { type: "options"; options: Partial<RaceOptions> }
  /** Single race on `options.trackId`. */
  | { type: "start" }
  /** New campaign over `CAMPAIGN` from round 1. */
  | { type: "campaign" }
  /** Same course again (a campaign round restarts with the same grid). */
  | { type: "retry" }
  /** Results → next course (single) or the standings screen (campaign); standings → next round. */
  | { type: "next" }
  | { type: "pause" }
  | { type: "resume" }
  /** Close the race now: running cars DNF, results menu. */
  | { type: "end" }
  /** Dead menu → follow the live cars (no control). */
  | { type: "spectate" }
  /** Spectating: next / previous live car. */
  | { type: "cycle"; dir: 1 | -1 }
  /** Spectating or finished: follow car `id` (standings click). Ignored while the player still races. */
  | { type: "watch"; id: number }
  /** Back to the setup menu (from pause / results / standings), or leave race mode from setup. */
  | { type: "quit" }
  /** Race focus view (false) hides the sandbox HUD and its hotkeys; true shows the full menu. */
  | { type: "fullUi"; on: boolean };

export type RaceMenu = "setup" | "pause" | "dead" | "results" | "standings" | null;

export type RaceHudRow = {
  id: number;
  name: string;
  place: number;
  /** Completed laps. */
  lap: number;
  status: CarStatus;
  /** Seconds behind the car in P1: finish-time gap for finishers, last shared checkpoint split otherwise; null for P1 / unknown. */
  gap: number | null;
  bestLap: number | null;
  you: boolean;
  watched: boolean;
};

/** What the HUD reads (built by the engine glue for the local viewer); null in `CrashHudState.race` outside race mode. */
export type RaceHud = {
  menu: RaceMenu;
  /** "campaign" while a campaign is running (results → standings → next round). */
  mode: "single" | "campaign";
  options: RaceOptions;
  courses: { id: string; name: string; blurb: string }[];
  phase: RacePhase | null;
  trackName: string;
  laps: number;
  noReset: boolean;
  /** Race clock (s): negative before green. */
  time: number;
  lights: 0 | 1 | 2 | 3;
  /** The local player's car, null when there is none in this race. */
  you: {
    id: number;
    place: number;
    /** Lap being driven, 1-based, capped at `laps`. */
    lap: number;
    lapTime: number;
    lastLap: number | null;
    bestLap: number | null;
    status: CarStatus;
    wrongWay: boolean;
    missed: boolean;
    /** Seconds until the pending respawn, null when none. */
    respawnIn: number | null;
    finishTime: number | null;
    /** Seconds behind the first car through the last checkpoint (0 when you led it). */
    split: number | null;
    speedKph: number;
  } | null;
  /** Cars in the race. */
  field: number;
  /** Live order (all cars). */
  standings: RaceHudRow[];
  /** Name of the car the camera follows while spectating, null otherwise. */
  spectating: string | null;
  winnerName: string | null;
  winBy: WinBy | null;
  /** Final classification once the race is over, else null. */
  results: RaceResultRow[] | null;
  /** Campaign table (after each round) while `mode` is "campaign". */
  campaign: CampaignSnapshot | null;
  /** Name of the next course for the results/standings button, null when there is none (campaign over). */
  nextCourse: string | null;
  /** The full sandbox HUD (and its hotkeys) is shown; false = race focus view. */
  fullUi: boolean;
};
