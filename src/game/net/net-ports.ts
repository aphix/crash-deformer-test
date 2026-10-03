import type { DeformableCar } from "../vehicle/car.ts";
import type { DriverSeat } from "../vehicle/car-drive.ts";
import type { CarStyleId } from "../vehicle/car-variants.ts";
import type { RaceDirector } from "../engine/engine-race.ts";
import type { CrashPhase } from "../match/phase.ts";
import type { VehicleClassId } from "../vehicle/vehicle-classes.ts";
import type { DerbyNetState } from "./codec.ts";
import type { Reel } from "../match/highlights.ts";
import type { NetPeer } from "./transport.ts";

/** The race director as netplay sees it (`CrashEngine.race`, while race mode is on). */
export type NetRace = Pick<
  RaceDirector,
  | "options"
  | "phase"
  | "setRemoteInput"
  | "requestRespawn"
  | "snapshot"
  | "applySnapshot"
  | "showLobby"
  | "command"
>;

/** Which public match a room runs; the room name says (`pub-race-…`, `pub-derby-…`). */
export type PublicKind = "race" | "derby";
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
  /** Race mode on / off, and (host) start a race with the current seats. */
  enterRace(): void;
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
  /** Client: car `i` vaporizes (the local smoke burst) or comes back, as the host's flag says (fleet disc edge). */
  setVaporized(i: number, on: boolean): void;
  /** Client: play the host's results reel from `startAt` (this browser's `performance.now()` seconds; docs/HIGHLIGHTS.md). */
  playReel(reel: Reel, startAt: number): void;
  /** Client: a reel or solo clip plays, so host snapshots are not drawn (the reel owns the cars). */
  reelPlaying(): boolean;
  readonly seat: DriverSeat;
}

export type NetRole = "off" | "host" | "client";
/** `bc`: BroadcastChannel (tabs of one browser); `rtc`: WebRTC via `/api/rtc`. */
export type NetTx = "bc" | "rtc";

/** `NetPlay.status()`: what the Net panel and the live-rooms chip show. */
export interface NetStatus {
  role: NetRole;
  /** A public room's match (`publicMatch`): anyone pressing that Public button may land in it. */
  public: PublicKind | null;
  /** Play online is still looking for a room to join or host (`publicMatch`). */
  finding: boolean;
  room: string;
  tx: NetTx;
  selfId: string;
  /** This peer's car (host 0); −1 until the host assigns one. */
  car: number;
  /** Seconds until a public match starts (host lobby, mirrored to clients), null otherwise. */
  lobby: number | null;
  peers: readonly NetPeer[];
  /** Snapshots per second sent (host) or taken (client) over the last second, and their payload. */
  snapHz: number;
  bytesPerSec: number;
  /**
   * Client: `version` the host runs another build (reload to play), `host-lost` no word from the host
   * (waiting for one), `host-paused` its tab is hidden; null while all is well.
   */
  problem: "version" | "host-lost" | "host-paused" | null;
  /** Why the relay refused this peer (room full, host seat taken, …), null while fine. */
  relayError: string | null;
}
