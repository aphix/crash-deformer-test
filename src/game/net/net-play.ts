import { z } from "zod";
import type { DeformableCar } from "../car.ts";
import type { CrashPhase } from "../hud-store.ts";
import type { RaceDirector } from "../engine-race.ts";
import type { RaceSnapshot } from "../race/types.ts";
import { applyDrive, idleDrive, type DriveInput, type DriverSeat } from "../car-drive.ts";
import { CAR_STYLE_IDS, type CarStyleId } from "../car-variants.ts";
import { carClass, HANDLING, VEHICLE_CLASS_IDS, type VehicleClassId } from "../vehicle-classes.ts";
import {
  ensureFrames,
  makeSnapshot,
  MSG,
  readInput,
  Reader,
  readSnapshot,
  writeInput,
  writeSnapshot,
  writeWreck,
  Writer,
  type NetLayout,
  type Snapshot,
  type DerbyNetState,
  readDerby,
  writeDerby,
} from "./codec.ts";
import { RtcTransport } from "./rtc-transport.ts";
import { BroadcastTransport, type NetPeer, type NetTransport } from "./transport.ts";
import { PUBLIC_PREFIX, ROOM_MAX } from "@/lib/multiplayer/rooms";

/** `GET api/rtc?list=public` (signaling.server.ts `listPublic`), fullest room first. */
const PUBLIC_LIST = z.object({
  rooms: z.array(z.object({ room: z.string().startsWith(PUBLIC_PREFIX).max(64), players: z.number().int() })),
});

/** `MSG.race` body. `snap` is the host's `RaceSnapshot` (null between races); a peer's data, so applied guarded. */
const RACE_MSG = z.object({ lobby: z.number().nullable(), trackId: z.string().max(64), snap: z.unknown() });

/** The race director as netplay sees it (`CrashEngine.race`, while race mode is on). */
type NetRace = Pick<RaceDirector, "options" | "phase" | "setRemoteInput" | "requestRespawn" | "snapshot" | "applySnapshot" | "showLobby">;

/** Which public match a room runs; the room name says (`pub-race-…`, `pub-derby-…`). */
type PublicKind = "race" | "derby";
/** Where a public match stands on the host: waiting for players, running, or showing its result. */
type MatchStage = "lobby" | "running" | "over";

/** Wire order of the crash phases (`Snapshot.phase`). */
const PHASES: readonly CrashPhase[] = ["approach", "impact", "slowmo", "aftermath"];

type NetRole = "off" | "host" | "client";
/** `bc`: BroadcastChannel (tabs of one browser); `rtc`: WebRTC via `/api/rtc`. */
export type NetTx = "bc" | "rtc";

/** The engine as netplay sees it. */
interface NetGame {
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
  readonly seat: DriverSeat;
}

export interface NetStatus {
  role: NetRole;
  /** A public room's match (`publicMatch`): anyone pressing that Public button may land in it. */
  public: PublicKind | null;
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
}

const SEND_HZ = 30;
const KEYFRAME_EVERY = 30;
/** A changed wreck section rides along this many snapshots (cover for lost packets). */
const REDUNDANT = 3;
/** Clients draw this far (s) behind the host's newest snapshot. */
const INTERP_DELAY = 0.1;
const RING = 8;
/** A public-race client with no host snapshot this long (ms) after joining hosts a fresh room. */
const HOST_WAIT_MS = 5000;
/** A public host waits this long (s) for players before the AI fills the empty seats and the race starts. */
const LOBBY_S = 15;
/** Seconds a finished public race shows its results before the next one starts (late joiners race then). */
const RESULTS_HOLD = 12;
/** The race state rides along every this many snapshots (5 Hz), and with every keyframe. */
const RACE_EVERY = 6;
/** A client in race mode with no race message from its host this long (ms) leaves race mode. */
const RACE_GONE_MS = 2000;
/** A public derby's field: peers plus AI up to this many cars. */
const PUBLIC_DERBY_FIELD = 6;

/**
 * Host-authoritative netplay (docs/MULTIPLAYER.md). The host simulates and broadcasts snapshots; each
 * client drives one car by sending its seat's shaped `DriveInput`, and draws every car from the
 * snapshots: poses interpolated, deform and parts applied as the host last skinned them.
 */
export class NetPlay {
  role: NetRole = "off";
  private readonly game: NetGame;
  private transport: NetTransport | null = null;
  private room = "";
  private tx: NetTx = "bc";
  private publicKind: PublicKind | null = null;
  private car = -1;
  private layout: NetLayout | null = null;
  private readonly w = new Writer();
  private readonly scratch = new Writer(4096);
  private readonly r = new Reader();
  private sendAcc = 0;
  private statAcc = 0;
  private statSnaps = 0;
  private statBytes = 0;
  private snapHz = 0;
  private bytesPerSec = 0;

  // Host
  private seq = 0;
  private keyframeDue = false;
  /** Peer id → car. */
  private readonly slots = new Map<string, number>();
  private readonly inputs: DriveInput[] = [];
  private readonly hasInput: boolean[] = [];
  private readonly out = makeSnapshot();
  private readonly lastWreck: Uint8Array[] = [];
  private readonly lastWreckLen: number[] = [];
  private readonly wreckChangedAt: number[] = [];

  // Client
  private readonly ring: Snapshot[] = [];
  /** Receive order of each ring slot (0 = empty). */
  private readonly ringOrder = new Array<number>(RING).fill(0);
  private order = 0;
  private lastSeq = -1;
  /** Smallest seen (local clock − host clock), s: the host time "now" is local − offset. */
  private offset = Infinity;
  /** Per car: receive order of the wreck section last applied. */
  private readonly applied: number[] = [];
  private readonly idle = idleDrive();
  private helloAcc = 0;
  /** `performance.now()` at join, and whether any host snapshot has arrived since. */
  private joinedAt = 0;
  private heardHost = false;
  /** Seconds left in the public-race lobby (host counts down, clients mirror it); null outside one. */
  private lobbyLeft: number | null = null;
  /** Host: seconds the finished public race has been showing its results. */
  private finishedFor = 0;
  /** Client: R was pressed; rides on the next input packet. */
  private respawnWanted = false;
  /** Client: `performance.now()` of the host's last race message (race mode follows the host's). */
  private raceAt = 0;
  /** Client: `performance.now()` of the host's last derby message (0: not in derby mode). */
  private derbyAt = 0;
  /** A closed tab never runs the engine's dispose: leave the room so the relay drops us at once. */
  private readonly onPageHide = (): void => this.leave();

  constructor(game: NetGame) {
    this.game = game;
  }

  get client(): boolean {
    return this.role === "client";
  }

  host(room: string, tx: NetTx = "bc"): void {
    this.start("host", room, tx);
    this.car = 0;
  }

  join(room: string, tx: NetTx = "bc"): void {
    this.start("client", room, tx);
    this.joinedAt = performance.now();
    this.heardHost = false;
  }

  /**
   * Public race or derby: join the fullest open public room of that kind over WebRTC (the relay
   * lists rooms whose host polled in the last few seconds and that have a free seat), or host a new
   * one when none is open. A joined room whose host never sends a snapshot within `HOST_WAIT_MS` is
   * abandoned for a fresh one.
   */
  async publicMatch(kind: PublicKind): Promise<void> {
    let open: string | undefined;
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}api/rtc?list=public&kind=${kind}`);
      const list = PUBLIC_LIST.safeParse(res.ok ? await res.json() : null);
      if (list.success) open = list.data.rooms[0]?.room;
    } catch {
      // Offline or relay down: host a room of our own, which others can still find later.
    }
    if (open) {
      this.join(open, "rtc");
      this.publicKind = kind;
    } else this.hostPublic(kind);
  }

  /** Host a fresh public room: the lobby counts `LOBBY_S` down on the course or in the bowl, then the match starts. */
  private hostPublic(kind: PublicKind): void {
    this.host(`${PUBLIC_PREFIX}${kind}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, "rtc");
    this.publicKind = kind;
    if (kind === "race") {
      this.game.enterRace();
      // No setup menu: the lobby picks nothing; the race starts on its own when the countdown ends.
      const race = this.game.race();
      race?.showLobby(race.options.trackId);
    } else this.game.derbyLobby(PUBLIC_DERBY_FIELD);
    this.lobbyLeft = LOBBY_S;
    this.syncSeats();
  }

  /** Client: ask the host to put this peer's car back on the track (race R / D-pad down). */
  requestRespawn(): void {
    this.respawnWanted = true;
  }

  leave(): void {
    if (typeof window !== "undefined") window.removeEventListener("pagehide", this.onPageHide);
    if (this.role === "client" && this.game.race()) this.game.exitRace();
    if (this.role === "client" && this.derbyAt > 0) this.game.applyDerby(null, this.car);
    this.derbyAt = 0;
    this.transport?.close();
    this.transport = null;
    this.role = "off";
    this.car = -1;
    this.slots.clear();
    this.hasInput.length = 0;
    this.lastWreckLen.length = 0;
    this.ringOrder.fill(0);
    this.lastSeq = -1;
    this.offset = Infinity;
    this.applied.length = 0;
    this.snapHz = 0;
    this.bytesPerSec = 0;
    this.lobbyLeft = null;
    this.finishedFor = 0;
  }

  status(): NetStatus {
    return {
      role: this.role,
      room: this.room,
      tx: this.tx,
      selfId: this.transport?.selfId ?? "",
      car: this.car,
      lobby: this.lobbyLeft == null ? null : Math.max(0, Math.ceil(this.lobbyLeft)),
      peers: this.transport?.peers() ?? [],
      snapHz: this.snapHz,
      bytesPerSec: this.bytesPerSec,
      public: this.publicKind,
    };
  }

  /** Host, each fixed step after the local seat: every remote peer's car takes its latest input (race mode drives them itself). */
  drive(cars: DeformableCar[], dt: number, driven: number): void {
    if (this.role !== "host" || this.game.race()) return;
    for (const car of this.slots.values()) {
      if (car === driven || car >= cars.length || !this.hasInput[car] || !this.game.remoteDrivable(car)) continue;
      applyDrive(cars[car]!, this.inputs[car]!, dt);
    }
  }

  /** Once per rendered frame, after physics (host) or instead of it (client). */
  frame(wallDt: number): void {
    if (!this.transport) return;
    this.statAcc += wallDt;
    if (this.statAcc >= 1) {
      this.snapHz = this.statSnaps / this.statAcc;
      this.bytesPerSec = this.statBytes / this.statAcc;
      this.statAcc = 0;
      this.statSnaps = 0;
      this.statBytes = 0;
    }
    if (this.role === "host") this.hostFrame(wallDt, this.transport);
    else this.clientFrame(wallDt, this.transport);
  }

  private start(role: NetRole, room: string, tx: NetTx): void {
    this.leave();
    const id = crypto.randomUUID().slice(0, 8);
    this.transport = tx === "rtc" ? new RtcTransport(room, id, role === "host" ? "host" : "client") : new BroadcastTransport(room, id);
    this.transport.onMessage = (from, data) => this.receive(from, data);
    this.role = role;
    this.room = room;
    this.tx = tx;
    this.publicKind = null;
    if (typeof window !== "undefined") window.addEventListener("pagehide", this.onPageHide);
  }

  private layoutOf(car: DeformableCar): NetLayout {
    if (!this.layout) {
      const p = car.partNetSizes();
      this.layout = { ...car.deform.netSizes(), parts: p.parts, wheels: p.wheels };
    }
    return this.layout;
  }

  private receive(from: string, data: Uint8Array): void {
    this.r.reset(data);
    const type = data[0];
    if (this.role === "host") {
      if (type === MSG.hello) this.assign(from);
      else if (type === MSG.input) {
        const car = this.slots.get(from);
        if (car === undefined) return;
        const input = (this.inputs[car] ??= idleDrive());
        const respawn = readInput(this.r, input);
        this.hasInput[car] = true;
        const race = this.game.race();
        if (race) {
          race.setRemoteInput(car, input);
          if (respawn) race.requestRespawn(car);
        }
      }
    } else if (type === MSG.assign) {
      this.r.u8();
      const car = this.r.u8();
      if (car === this.car) return;
      this.car = car;
      if (!this.game.race() && !this.game.derbyPhase()) this.game.seat.focus(car);
    } else if (type === MSG.snapshot) {
      this.takeSnapshot(data);
    } else if (type === MSG.race) {
      this.takeRace(data);
    } else if (type === MSG.derby) {
      this.takeDerby();
    }
  }

  /** Netplay host: every peer's car is a `remote` seat from the next race or derby match on. */
  private syncSeats(): void {
    this.game.setSeats([...this.slots.values()]);
  }

  // ── host ──────────────────────────────────────────────────────────────────

  private assign(peer: string): void {
    let car = this.slots.get(peer);
    if (car === undefined) {
      car = 1;
      for (const used = new Set(this.slots.values()); used.has(car); ) car++;
      this.slots.set(peer, car);
      this.hasInput[car] = false;
      // A race or derby seats a new peer at its next start; only Fleet grows the field at once.
      if (car >= this.game.cars().length && !this.game.race() && !this.game.derbyPhase()) this.game.setCarCount(car + 1);
      this.syncSeats();
      this.keyframeDue = true;
    }
    this.w.off = 0;
    this.w.u8(MSG.assign);
    this.w.u8(car);
    this.transport!.send(this.w.done(), peer);
  }

  private hostFrame(wallDt: number, t: NetTransport): void {
    const race = this.game.race();
    if (this.publicKind) this.runPublic(this.publicKind, wallDt);
    this.sendAcc += wallDt;
    if (this.sendAcc < 1 / SEND_HZ) return;
    this.sendAcc = Math.min(this.sendAcc - 1 / SEND_HZ, 1 / SEND_HZ);
    const peers = t.peers();
    let left = false;
    for (const [id, car] of this.slots) {
      if (peers.some((p) => p.id === id)) continue;
      this.slots.delete(id);
      this.hasInput[car] = false;
      race?.setRemoteInput(car, this.idle);
      left = true;
    }
    if (left) this.syncSeats();
    const cars = this.game.cars();
    if (cars.length === 0) return;
    const L = this.layoutOf(cars[0]!);
    const s = this.out;
    s.seq = ++this.seq;
    s.time = performance.now() / 1000;
    s.keyframe = this.keyframeDue || this.seq % KEYFRAME_EVERY === 0;
    this.keyframeDue = false;
    s.count = cars.length;
    s.realism = HANDLING.realism;
    s.phase = PHASES.indexOf(this.game.phase());
    s.timeScale = this.game.timeScale();
    ensureFrames(s, cars.length, L);
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i]!;
      const f = s.cars[i]!;
      const g = car.group;
      f.x = g.position.x;
      f.y = g.position.y;
      f.z = g.position.z;
      f.pitch = g.rotation.x;
      f.yaw = g.rotation.y;
      f.roll = g.rotation.z;
      f.vx = car.velocity.x;
      f.vy = car.velocity.y;
      f.vz = car.velocity.z;
      f.wy = car.angular.y;
      f.crashed = car.crashed;
      f.style = CAR_STYLE_IDS.indexOf(car.style.id);
      f.cls = VEHICLE_CLASS_IDS.indexOf(carClass(car));
      f.wreck = false;
      if (!car.crashed) {
        this.lastWreckLen[i] = 0;
        continue;
      }
      car.deform.readNetState(f.deform);
      car.readPartNetState(f.parts);
      const sc = this.scratch;
      sc.off = 0;
      writeWreck(sc, f, L);
      const prev = (this.lastWreck[i] ??= new Uint8Array(sc.bytes.length));
      let same = this.lastWreckLen[i] === sc.off;
      for (let k = 0; same && k < sc.off; k++) same = prev[k] === sc.bytes[k];
      if (!same) {
        prev.set(sc.done());
        this.lastWreckLen[i] = sc.off;
        this.wreckChangedAt[i] = this.seq;
      }
      f.wreck = s.keyframe || this.seq - this.wreckChangedAt[i]! < REDUNDANT;
    }
    this.w.off = 0;
    writeSnapshot(this.w, s, L);
    t.send(this.w.done());
    this.statSnaps++;
    this.statBytes += this.w.off;
    if (race && (s.keyframe || this.seq % RACE_EVERY === 0)) this.sendRace(race, t);
    const derby = s.keyframe || this.seq % RACE_EVERY === 0 ? this.game.derbyState() : null;
    if (derby) {
      derby.lobby = this.lobbyLeft;
      this.scratch.off = 0;
      writeDerby(this.scratch, derby);
      t.send(this.scratch.done());
      this.statBytes += this.scratch.off;
    }
  }

  /**
   * A public match on the host: the lobby counts down (`LOBBY_S`, sooner once the room is full),
   * then the match starts with every peer seated and the AI in the empty slots; a finished match
   * shows its result for `RESULTS_HOLD` s and the next one starts, seating whoever joined meanwhile.
   */
  private runPublic(kind: PublicKind, wallDt: number): void {
    let stage: MatchStage | null;
    if (kind === "race") {
      const race = this.game.race();
      const phase = race ? race.phase : undefined;
      stage = phase === undefined ? null : phase === null ? "lobby" : phase === "finished" ? "over" : "running";
    } else stage = this.game.derbyPhase();
    if (stage === null || stage === "running") {
      this.lobbyLeft = null;
      this.finishedFor = 0;
      return;
    }
    if (stage === "lobby") {
      this.lobbyLeft = (this.lobbyLeft ?? LOBBY_S) - wallDt;
      if (this.lobbyLeft > 0 && this.slots.size < ROOM_MAX - 1) return;
    } else {
      this.finishedFor += wallDt;
      if (this.finishedFor < RESULTS_HOLD) return;
    }
    this.lobbyLeft = null;
    this.finishedFor = 0;
    this.syncSeats();
    if (kind === "race") this.game.startRace();
    else this.game.startDerby(PUBLIC_DERBY_FIELD);
  }

  /** The rules state (or, between races, the lobby countdown and course) to every client. */
  private sendRace(race: NetRace, t: NetTransport): void {
    const json = JSON.stringify({ lobby: this.lobbyLeft, trackId: race.options.trackId, snap: race.snapshot() });
    const body = new TextEncoder().encode(json);
    const msg = new Uint8Array(body.length + 1);
    msg[0] = MSG.race;
    msg.set(body, 1);
    t.send(msg);
    this.statBytes += msg.length;
  }

  // ── client ────────────────────────────────────────────────────────────────

  /** The host's race state: race mode on, then its session (or its lobby) adopted. Never stepped here. */
  private takeRace(data: Uint8Array): void {
    let parsed: z.infer<typeof RACE_MSG>;
    try {
      parsed = RACE_MSG.parse(JSON.parse(new TextDecoder().decode(data.subarray(1))));
    } catch {
      return;
    }
    this.lobbyLeft = parsed.lobby;
    this.raceAt = performance.now();
    this.game.enterRace();
    const race = this.game.race();
    if (!race) return;
    try {
      // A peer's JSON in the host's RaceSnapshot shape: RaceSession.restore reads it as is, guarded here.
      const snap = parsed.snap as RaceSnapshot | null;
      if (snap) race.applySnapshot(snap, this.car);
      else race.showLobby(parsed.trackId);
    } catch {
      // Malformed race state from the host: keep the last good one.
    }
  }

  /** The host's derby: derby mode on, the board, clock and result shown as is. Never stepped here. */
  private takeDerby(): void {
    let state: DerbyNetState;
    try {
      state = readDerby(this.r);
    } catch {
      // Truncated or malformed: keep the last good state.
      return;
    }
    this.lobbyLeft = state.lobby;
    this.derbyAt = performance.now();
    this.game.applyDerby(state, this.car);
  }

  private takeSnapshot(data: Uint8Array): void {
    const cars = this.game.cars();
    if (cars.length === 0) return;
    const seq = data[2]! | (data[3]! << 8);
    if (this.lastSeq >= 0 && ((seq - this.lastSeq) & 0xffff) >= 0x8000) return;
    if (seq === this.lastSeq) return;
    this.lastSeq = seq;
    let slot = 0;
    for (let k = 1; k < RING; k++) if (this.ringOrder[k]! < this.ringOrder[slot]!) slot = k;
    const s = (this.ring[slot] ??= makeSnapshot());
    readSnapshot(this.r, s, this.layoutOf(cars[0]!));
    this.ringOrder[slot] = ++this.order;
    this.offset = Math.min(performance.now() / 1000 - s.time, this.offset + 0.001);
    this.statSnaps++;
    this.statBytes += data.byteLength;
    this.heardHost = true;
  }

  private clientFrame(wallDt: number, t: NetTransport): void {
    if (this.publicKind && !this.heardHost && performance.now() - this.joinedAt > HOST_WAIT_MS) {
      // The room's host is gone (its relay row outlives it by up to 30 s): start a fresh public room.
      this.hostPublic(this.publicKind);
      return;
    }
    // The host left race or derby mode (its messages stop): so does this client.
    if (this.game.race() && this.heardHost && performance.now() - this.raceAt > RACE_GONE_MS) {
      this.game.exitRace();
      this.lobbyLeft = null;
    }
    if (this.derbyAt > 0 && performance.now() - this.derbyAt > RACE_GONE_MS) {
      this.game.applyDerby(null, this.car);
      this.derbyAt = 0;
      this.lobbyLeft = null;
    }
    if (this.car < 0) {
      this.helloAcc += wallDt;
      if (this.helloAcc >= 0.5) {
        this.helloAcc = 0;
        this.w.off = 0;
        this.w.u8(MSG.hello);
        t.send(this.w.done());
      }
    }
    let newest = -1;
    for (let k = 0; k < RING; k++) if (this.ringOrder[k]! > 0 && (newest < 0 || this.ringOrder[k]! > this.ringOrder[newest]!)) newest = k;
    if (newest < 0) return;
    const count = this.ring[newest]!.count;
    if (count !== this.game.cars().length) {
      this.game.setCarCount(count);
      this.applied.length = 0;
      // In race mode the race director seats this peer (applySnapshot); in Fleet it follows its car.
      if (this.car >= 0 && !this.game.race() && this.derbyAt === 0) this.game.seat.focus(this.car);
    }
    const latest = this.ring[newest]!;
    if (Math.abs(latest.realism - HANDLING.realism) > 0.5 / 255) this.game.setRealism(latest.realism);
    this.game.mirrorClock(PHASES[latest.phase] ?? "approach", latest.timeScale);
    for (let i = 0; i < count; i++) {
      const was = this.game.cars()[i];
      const f = latest.cars[i]!;
      this.game.matchCar(i, CAR_STYLE_IDS[f.style]!, VEHICLE_CLASS_IDS[f.cls]!);
      if (this.game.cars()[i] !== was) this.applied[i] = 0;
    }
    const cars = this.game.cars();

    // Bracket the render time: a = newest at or before it, b = oldest after it (hold at either end).
    const rt = performance.now() / 1000 - this.offset - INTERP_DELAY;
    let a = -1;
    let b = -1;
    for (let k = 0; k < RING; k++) {
      if (this.ringOrder[k] === 0) continue;
      const tk = this.ring[k]!.time;
      if (tk <= rt) {
        if (a < 0 || tk > this.ring[a]!.time) a = k;
      } else if (b < 0 || tk < this.ring[b]!.time) b = k;
    }
    const sa = this.ring[a >= 0 ? a : b]!;
    const orderA = this.ringOrder[a >= 0 ? a : b]!;
    const sb = this.ring[b >= 0 ? b : a]!;
    const u = sa === sb ? 0 : Math.min(1, Math.max(0, (rt - sa.time) / (sb.time - sa.time)));

    for (let i = 0; i < cars.length && i < sa.count; i++) {
      const car = cars[i]!;
      const fa = sa.cars[i]!;
      const fb = i < sb.count ? sb.cars[i]! : fa;
      if (car.crashed && !fa.crashed) {
        car.resetVisual();
        this.applied[i] = orderA;
      }
      let dyaw = fb.yaw - fa.yaw;
      if (dyaw > Math.PI) dyaw -= Math.PI * 2;
      else if (dyaw < -Math.PI) dyaw += Math.PI * 2;
      car.yaw = fa.yaw + dyaw * u;
      car.pitch = fa.pitch + (fb.pitch - fa.pitch) * u;
      car.roll = fa.roll + (fb.roll - fa.roll) * u;
      car.group.position.set(fa.x + (fb.x - fa.x) * u, fa.y + (fb.y - fa.y) * u, fa.z + (fb.z - fa.z) * u);
      car.group.rotation.set(car.pitch, car.yaw, car.roll, "YXZ");
      car.velocity.set(fa.vx + (fb.vx - fa.vx) * u, fa.vy + (fb.vy - fa.vy) * u, fa.vz + (fb.vz - fa.vz) * u);
      car.angular.set(0, fa.wy + (fb.wy - fa.wy) * u, 0);
      car.speed = car.velocity.length();
      car.crashed = fa.crashed;
      car.refreshBasis();

      // The newest wreck section at or before the render time, once.
      let w = -1;
      for (let k = 0; k < RING; k++) {
        const s = this.ring[k];
        if (!s || this.ringOrder[k]! <= (this.applied[i] ?? 0) || s.time > rt || i >= s.count || !s.cars[i]!.wreck) continue;
        if (w < 0 || this.ringOrder[k]! > this.ringOrder[w]!) w = k;
      }
      if (w >= 0) {
        const f = this.ring[w]!.cars[i]!;
        car.writeNetState(f.deform, f.parts);
        this.applied[i] = this.ringOrder[w]!;
      }
      car.netFrame(wallDt);
    }

    if (this.car < 0 || this.car >= cars.length) return;
    const seat = this.game.seat;
    const input = seat.mode === "drive" && seat.carIndex === this.car ? seat.input(cars[this.car]!, wallDt) : this.idle;
    this.sendAcc += wallDt;
    if (this.sendAcc < 1 / SEND_HZ) return;
    this.sendAcc = 0;
    this.w.off = 0;
    writeInput(this.w, input, this.respawnWanted);
    this.respawnWanted = false;
    t.send(this.w.done());
  }
}
