/**
 * Race contracts shared by the rules (`session.ts`), campaign, AI, engine glue and HUD.
 * Everything here is plain JSON-able data: a host can ship it to peers as is.
 */

/** Who feeds a car's `DriveInput`: this browser's seat, a race brain, or (later) a network peer. */
export type SlotKind = "player" | "ai" | "remote";

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
  /** 3–5 in the menu; the rules accept any ≥ 1. */
  laps: number;
  /** A dead car is out for good; last car alive also wins. */
  noReset: boolean;
  /** AI opponents (the field is aiCount + players). */
  aiCount: number;
  /** Field aggression 0–1; each AI gets a personal spread around it. */
  aggression: number;
};

export const DEFAULT_RACE_OPTIONS: RaceOptions = { trackId: "oval", laps: 3, noReset: false, aiCount: 7, aggression: 0.35 };

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
  /** Race time the pending respawn fires, null when none. */
  respawnAt: number | null;
  deaths: number;
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
  points: number;
  wins: number;
  /** Finishing place per completed round (0 = did not start). */
  places: number[];
};

export type CampaignSnapshot = {
  tracks: string[];
  /** Index of the round being raced or about to be raced; tracks.length when complete. */
  round: number;
  standings: CampaignRow[];
};

/** UI → engine. The HUD never touches race state; it sends these. */
export type RaceCommand =
  | { type: "open" }
  | { type: "options"; options: Partial<RaceOptions> }
  | { type: "start" }
  | { type: "campaign" }
  | { type: "retry" }
  | { type: "next" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "end" }
  | { type: "spectate"; dir: 1 | -1 }
  | { type: "quit" };

export type RaceMenu = "setup" | "pause" | "dead" | "results" | "standings" | null;

export type RaceHudRow = {
  id: number;
  name: string;
  place: number;
  lap: number;
  status: CarStatus;
  /** Seconds behind the leader on the road (null for the leader / not comparable). */
  gap: number | null;
  bestLap: number | null;
  you: boolean;
  watched: boolean;
};

/** What the HUD reads (built by the engine glue for the local viewer). */
export type RaceHud = {
  menu: RaceMenu;
  options: RaceOptions;
  courses: { id: string; name: string; blurb: string }[];
  phase: RacePhase | null;
  trackName: string;
  laps: number;
  noReset: boolean;
  time: number;
  lights: 0 | 1 | 2 | 3;
  /** The local player's car, null when there is none in this race. */
  you: {
    id: number;
    place: number;
    lap: number;
    lapTime: number;
    lastLap: number | null;
    bestLap: number | null;
    status: CarStatus;
    wrongWay: boolean;
    /** Seconds until the pending respawn, null when none. */
    respawnIn: number | null;
    finishTime: number | null;
    speedKph: number;
  } | null;
  field: number;
  standings: RaceHudRow[];
  /** Car the camera follows while spectating, null otherwise. */
  spectating: string | null;
  winnerName: string | null;
  winBy: WinBy | null;
  results: RaceResultRow[] | null;
  campaign: CampaignSnapshot | null;
};
