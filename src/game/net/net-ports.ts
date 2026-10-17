import type { DeformableCar } from "../vehicle/car.ts";
import type { Ejection } from "../vehicle/ejection.ts";
import type { DriveInput, DriverSeat } from "../vehicle/car-drive.ts";
import type { CarStyleId } from "../vehicle/car-variants.ts";
import type { RaceCommand, RaceOptions, RacePhase, RaceSnapshot } from "../match/types.ts";
import type { CrashPhase } from "../match/phase.ts";
import type { VehicleClassId } from "../vehicle/vehicle-classes.ts";
import type { DerbyNetState, GameKind, LobbyGate } from "./codec.ts";
import type { Reel } from "../match/highlights.ts";
import type { NetPeer } from "./transport.ts";
import type { LookData } from "./look-codec.ts";

/** The race director as netplay sees it (`CrashEngine.race`, while race mode is on; the engine's `RaceDirector` fits it structurally). */
export interface NetRace {
  options: RaceOptions;
  look: number;
  survival: boolean;
  /** The rules phase, null outside a race. */
  readonly phase: RacePhase | null;
  /** The course the director shows. */
  readonly courseId: string;
  /** The courses Survival is played on (the lobby is on one of them). */
  readonly survivalCourses: readonly { id: string; name: string }[];
  setRemoteInput(carId: number, input: DriveInput): void;
  requestRespawn(id?: number): void;
  holdReset(id?: number): void;
  snapshot(): RaceSnapshot | null;
  applySnapshot(snap: RaceSnapshot, self: number): void;
  /** Client: the race clock runs on `dt` s between the host's messages (it is not streamed). */
  advanceClock(dt: number): void;
  showLobby(trackId: string): void;
  seatLobby(self: number): void;
  command(cmd: RaceCommand): void;
  /** Host, between a campaign's rounds: moves on from the results or standings (scores the round, starts the next; after the last, back to the setup menu). */
  advance(): void;
}

/** A course a host can pick: what the setup menu lists. */
interface CourseInfo {
  id: string;
  name: string;
  blurb: string;
}

/** The courses a host picks from: the race menu's, and the ones Survival is played on. */
export interface CourseMenu {
  courses: readonly CourseInfo[];
  survival: readonly CourseInfo[];
}

/** Which game a public room runs; the room name says (`pub-race-…`, `pub-campaign-…`, `pub-survival-…`, `pub-derby-…`). */
export type PublicKind = GameKind;

/** Where a public match stands on the host: waiting for players, running, or showing its result. */
export type MatchStage = "lobby" | "running" | "over";

/** Wire order of the crash phases (`Snapshot.phase`). */
export const PHASES: readonly CrashPhase[] = ["approach", "impact", "slowmo", "aftermath"];

/** The engine as netplay sees it. */
export interface NetGame {
  /** Live cars, index = car id on every peer. */
  cars(): DeformableCar[];
  setCarCount(n: number): void;
  /** Rebuild car `i` on this body style and class when it differs. */
  matchCar(i: number, style: CarStyleId, cls: VehicleClassId): void;
  setRealism(value: number): void;
  /** Host: the crash phase and time scale clients mirror. */
  phase(): CrashPhase;
  timeScale(): number;
  /** Client: show the host's phase and run FX at its time scale. */
  mirrorClock(phase: CrashPhase, timeScale: number): void;
  /** Race mode's director, null outside race mode. */
  race(): NetRace | null;
  /**
   * Race mode on (Survival when `survival`) / off, and (host) start a race with the current seats. A race already on in the other kind is left for the asked one.
   * `lobby`: the Havana free-drive lobby (no setup menu, no rules, no hunters) instead of the setup menu.
   */
  enterRace(survival: boolean, lobby?: boolean): void;
  exitRace(): void;
  startRace(): void;
  /** Host: network peers' cars and names. A race seats them at its next start, a derby at its next match. */
  setSeats(seats: ReadonlyMap<number, string>): void;
  /** This browser's player's name (its `hello` carries it to the host). */
  playerName(): string;
  /** Whether this device can host a full public match (`AutoFx`'s capability sample): a weak one searches longer first and runs a smaller field. */
  hostFit(): boolean;
  /** Host: whether peer car `i` takes its input now (a derby only drives cars it seated and not counted out). */
  remoteDrivable(i: number): boolean;
  /** Host: derby mode's stage, null outside derby mode. */
  derbyPhase(): MatchStage | null;
  /** Host: the derby as clients render it, null outside derby mode. */
  derbyState(): DerbyNetState | null;
  /** Client: show the host's derby as car `self`; null leaves derby mode. */
  applyDerby(state: DerbyNetState | null, self: number): void;
  /** Host: derby mode with a field of at least `field` cars parked and no match (a public lobby), or a fresh match. */
  derbyLobby(field: number): void;
  startDerby(field: number): void;
  /** Host, lobby: car `i` put back at a Havana spawn, repaired and upright (a new peer's car included). */
  resetLobbyCar(i: number): void;
  /** Host, lobby: the whole scene reset (props, debris, every car back at its spawn, repaired). */
  resetLobbyScene(): void;
  /** Client: car `i` vaporizes (the local smoke burst) or comes back, as the host's flag says (fleet disc edge). */
  setVaporized(i: number, on: boolean): void;
  /** Host: how many times the scene has been cleared (mod 128), sent with every snapshot. */
  clearGen(): number;
  /** Client: the host cleared its scene (a change, loop, reset): empty this one the same way (torn parts, loose wheels, dummies, fx, poles). */
  clearScene(): void;
  /** Client: play the host's results reel from `startAt` (this browser's `performance.now()` seconds; docs/HIGHLIGHTS.md). */
  playReel(reel: Reel, startAt: number): void;
  /** Client: a reel or solo clip plays, so host snapshots are not drawn (the reel owns the cars). */
  reelPlaying(): boolean;
  /** Client: the host's thrown driver (`MSG.eject`) flies as a dummy, launched from the host's own numbers. */
  launchEjection(e: Ejection): void;
  /** Host: car `i`'s boost meter as its driver keeps it (0-1), null for a car with no nitrous; each snapshot carries it. */
  meterOf(i: number): number | null;
  /** This browser's player's look: what its `MSG.look` carries. */
  playerLook(): LookData;
  /** Car `i` wears another player's look (`MSG.look`), or (null) its own paint and drawn driver again. */
  wearLook(i: number, look: LookData | null): void;
  /** Leaving the room: every other player's look comes off. */
  dropLooks(): void;
  /** The courses a host picks from, race mode on or not. */
  courseMenu(): CourseMenu;
  readonly seat: DriverSeat;
}

export type NetRole = "off" | "host" | "client";
/** `bc`: BroadcastChannel (tabs of one browser); `rtc`: WebRTC via `/api/rtc`. */
export const NET_TX = { bc: "bc", rtc: "rtc" } as const;
export type NetTx = (typeof NET_TX)[keyof typeof NET_TX];

/** `NetPlay.hostRoom`: everything a host sets before its room opens in the Havana lobby; the same pick for every game. */
export interface HostRoom {
  kind: GameKind;
  /** The room's password: private rooms are unlisted and joined by it; null makes a public room, listed for anyone. */
  code: string | null;
  tx: NetTx;
  /** Players (the host included) Go waits for. */
  minPlayers: number;
  /** The course a race or a Survival run is on (ignored by the other games). */
  course: string;
  /** A campaign's courses in play order. */
  playlist: readonly string[];
  /** Whether a campaign moves on by itself after `BETWEEN_ROUNDS_S`. */
  autoNext: boolean;
}

/** `NetPlay.status()`: what the online entry's chip and panel show. */
export interface NetStatus {
  role: NetRole;
  /** The game a public room runs (`publicHost`, a live-list Join): listed on the relay, anyone may join it; null for a private room. */
  public: PublicKind | null;
  /** `publicMatch` is still looking for a room to join or host. */
  finding: boolean;
  room: string;
  tx: NetTx;
  selfId: string;
  /** This peer's car (host 0); −1 until the host assigns one. */
  car: number;
  /** Seconds until a public match starts (host lobby, mirrored to clients), null otherwise. */
  lobby: number | null;
  /** Seconds until the host moves a campaign on from the round it just ran (mirrored to clients), null when it waits for the host's Next or no campaign is between rounds. */
  nextIn: number | null;
  /** Host of a campaign room: whether the campaign moves on by itself after the between-rounds minute (`setAutoNext`); null for a guest and for every other game. */
  autoNext: boolean | null;
  /** The lobby's start gate (players needed, players here, the game Go starts); null once a game runs or outside a lobby. */
  gate: (LobbyGate & { players: number }) | null;
  /** The course the lobby shows (the one a Survival run starts on) and the Survival courses a host's panel picks from; empty outside race mode. */
  survivalCourse: { id: string; courses: readonly { id: string; name: string }[] };
  peers: readonly NetPeer[];
  /** Snapshots per second sent (host) or taken (client) over the last second, and their payload. */
  snapHz: number;
  bytesPerSec: number;
  /**
   * Client: `version` the host runs another build (reload to play), `host-lost` no word from the host
   * (waiting for one), `host-paused` its tab is hidden, `no-host` nobody answered since joining (a closed room or a stale link); null while all is well.
   */
  problem: "version" | "host-lost" | "host-paused" | "no-host" | null;
  /** Why the relay refused this peer (room full, host seat taken, …), null while fine. */
  relayError: string | null;
}
