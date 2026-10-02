import type { DeformableCar } from "../car.ts";
import type { DriverSeat } from "../car-drive.ts";
import type { CarStyleId } from "../car-variants.ts";
import type { RaceDirector } from "../engine-race.ts";
import type { CrashPhase } from "../hud-store.ts";
import type { VehicleClassId } from "../vehicle-classes.ts";
import type { DerbyNetState } from "./codec.ts";

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
  /** Host: network peers' cars. A race seats them at its next start, a derby at its next match. */
  setSeats(cars: readonly number[]): void;
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
  readonly seat: DriverSeat;
}
