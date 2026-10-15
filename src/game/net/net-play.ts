import type { DeformableCar } from "../vehicle/car.ts";
import { applyDrive, idleDrive, type DriveInput } from "../vehicle/car-drive.ts";
import { HANDLING } from "../vehicle/vehicle-classes.ts";
import type { Ejection } from "../vehicle/ejection.ts";
import {
  ensureFrames,
  makeSnapshot,
  MSG,
  NET_VERSION,
  INPUT_HOLD,
  INPUT_RESPAWN,
  INPUT_RESET,
  readInput,
  writeInput,
  writeRace,
  writeSnapshot,
  writeWreck,
  Writer,
  writeDerby, packEject, type GameKind, type LobbyGate,
} from "./codec.ts";
import { NET_TX, PHASES, type NetGame, type NetRace, type NetRole, type NetStatus, type NetTx, type PublicKind } from "./net-ports.ts";
import { cleanName } from "../match/types.ts";
import { packLook, readLook } from "./look-codec.ts";
import { RtcTransport } from "./rtc-transport.ts";
import { BroadcastTransport, type NetTransport } from "./transport.ts";
import { NetPlayClient } from "./net-play-client.ts";
import { readCarPose } from "./car-pose.ts";
import { packRoster } from "./roster-codec.ts";
import { ROOM_MAX } from "../../lib/multiplayer/rooms.ts";
import { fetchRooms, findMatch, matchStage, publicMeta, publicRoomName, WEAK_AI, WEAK_DERBY_FIELD, type MatchDeps } from "./matchmaking.ts";
import {
  DEFAULT_MIN_PLAYERS,
  HELLO_EVERY, HOLD_EVERY_MS, INPUT_STALE_MS, KEYFRAME_EVERY, LOBBY_S,
  PUBLIC_DERBY_FIELD, RACE_EVERY, REDUNDANT, REFUSED, RESULTS_HOLD, SEND_HZ, SLOT_GRACE_MS,
} from "./net-constants.ts";

/** The name a player who typed none carries (`RaceDirector.playerName`): the roster shows such a player as "Host" or "Player N" instead. */
const DEFAULT_NAME = "You";

/** A roster name as every peer's list shows it: the cleaned name, or `fallback` for a player who typed none. */
function shownName(name: string, fallback: string): string {
  const clean = cleanName(name);
  return clean && clean !== DEFAULT_NAME ? clean : fallback;
}

/** Opens this peer's link to a room: `role` is the roster tag the relay knows it by. */
type Connect = (tx: NetTx, room: string, id: string, role: "host" | "client", meta: () => string) => NetTransport;

const connectDefault: Connect = (tx, room, id, role, meta) => (tx === NET_TX.rtc ? new RtcTransport(room, id, role, meta) : new BroadcastTransport(room, id));

/** Test seams: the link (default WebRTC or BroadcastChannel), the clock (ms, default `performance.now`) and the matchmaker's pauses and dice. */
interface NetPlayOptions {
  connect?: Connect;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/**
 * Host-authoritative netplay. The host simulates and broadcasts snapshots; each client drives one car
 * by sending its seat's shaped `DriveInput` (the client half is `NetPlayClient`).
 */
export class NetPlay extends NetPlayClient {
  role: NetRole = "off";
  private readonly connect: Connect;
  tx: NetTx = NET_TX.bc;
  /** The running public search's token: a newer search, or `leave`, cancels it. */
  private finder = 0;
  private derbyField = PUBLIC_DERBY_FIELD;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly scratch = new Writer(4096);
  private statAcc = 0;
  private snapHz = 0;
  private bytesPerSec = 0;

  // Host
  private seq = 0;
  private keyframeDue = false;
  /** Peer id → car. */
  private readonly slots = new Map<string, number>();
  /** Host: the roster of who drives which car changed and the guests have not been told. */
  private rosterDirty = false;
  /** Peer id → the name its hello carried (cleaned; "" when none). */
  private readonly names = new Map<string, string>();
  /** Peers whose hello carried this build's version: their input may (re)claim a car. */
  private readonly vetted = new Set<string>();
  /** Host: each seated player's `MSG.look` as relayed (its car byte set), by car; a guest joining later gets every one. */
  private readonly looks = new Map<number, Uint8Array<ArrayBuffer>>();
  /** Peer id → `now()` of its last message: a peer off the transport keeps its car until this is `SLOT_GRACE_MS` old. */
  private readonly heardAt = new Map<string, number>();
  private readonly inputs: DriveInput[] = [];
  private readonly hasInput: boolean[] = [];
  /** Per car: `now()` its input last arrived. */
  private readonly inputAt: number[] = [];
  /** `readInput`'s meter out-slot. */
  private readonly inMeter = new Float64Array(1);
  /** Hidden host: the heartbeat timer telling guests it is only paused. */
  private holdTimer: ReturnType<typeof setInterval> | undefined;
  private readonly out = makeSnapshot();
  private readonly lastWreck: Uint8Array[] = [];
  private readonly lastWreckLen: number[] = [];
  private readonly wreckChangedAt: number[] = [];

  /** Host: seconds the finished public race has been showing its results. */
  private finishedFor = 0;
  /** Host: the Havana lobby is up (no game running yet). */
  private lobbyOn = false;
  /** Host: players the Go switch needs (`setMinPlayers`), and the game it starts in a private room (`setLobbyKind`; a public room's is its kind). */
  private minPlayers = DEFAULT_MIN_PLAYERS;
  private lobbyKind: GameKind = "race";
  /** A closed tab never runs the engine's dispose: leave the room so the relay drops us at once. */
  private readonly onPageHide = (): void => this.leave();
  /** A hidden tab draws no frames: a guest idles its car, a host tells its guests it is paused. */
  private readonly onVisibility = (): void => this.setHidden(document.hidden);

  constructor(game: NetGame, opts: NetPlayOptions = {}) {
    super(game, opts.now ?? (() => performance.now()));
    this.connect = opts.connect ?? connectDefault;
    // Executor form: the tsconfig lib predates `Promise.withResolvers`.
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = opts.random ?? Math.random;
  }

  get client(): boolean {
    return this.role === "client";
  }

  /** Car `i`'s boost meter as netplay heard it (`meters`), null when nothing was. */
  heard(i: number): number | null {
    const m = this.meters[i];
    return m === undefined || m < 0 ? null : m;
  }

  /** Host a room: from the first moment everyone waits in the Havana lobby (`openLobby`) until `go`. */
  host(room: string, tx: NetTx = NET_TX.bc): void {
    this.start("host", room, tx);
    this.car = 0;
    this.openLobby();
  }

  join(room: string, tx: NetTx = NET_TX.bc): void {
    this.start("client", room, tx);
    this.silentFor = 0;
    this.raceSilentFor = 0;
    this.heardHost = false;
  }

  /**
   * Play online: join the best open public room of `kind`, else host one
   * (`findMatch` decides, with this device's `hostFit`). Resolves when the search is over; `status().finding`
   * is true until it joins or hosts. A newer search or `leave` cancels this one. The player starts it, so the
   * session's dead rooms are forgotten.
   */
  async publicMatch(kind: PublicKind): Promise<void> {
    this.dead = { rooms: [], unanswered: 0 };
    await this.search(kind);
  }

  /** One `findMatch` that never joins a dead room: the player's search, or the one a dead room sends its guest on. */
  protected async search(kind: PublicKind): Promise<void> {
    const id = ++this.finder;
    // `start` leaves first, which cancels searches: the one deciding takes its token back.
    const claim = (): void => {
      this.finder = id;
      this.finding = false;
    };
    const deps: MatchDeps = {
      list: () => fetchRooms(kind),
      sleep: this.sleep,
      random: this.random,
      now: this.now,
      join: (room) => {
        this.publicJoin(room, kind);
        claim();
      },
      host: (weak) => {
        this.publicHost(kind, weak);
        claim();
        return this.room;
      },
      alone: () => this.slots.size === 0,
      live: () => this.finder === id,
    };
    this.finding = true;
    try {
      await findMatch(kind, this.game.hostFit(), deps, this.dead.rooms);
    } finally {
      if (this.finder === id) this.finding = false;
    }
  }

  /** Join public room `room` of `kind` as a guest (the live-rooms list's Join). */
  publicJoin(room: string, kind: PublicKind): void {
    this.join(room, NET_TX.rtc);
    this.publicKind = kind;
  }

  /** Host a fresh public room: the lobby waits for `minPlayers` and counts `LOBBY_S` down, then the match starts; `weak` runs a smaller field. */
  publicHost(kind: PublicKind, weak = !this.game.hostFit()): void {
    this.host(publicRoomName(kind, Math.random().toString(36).slice(2, 8).toUpperCase()), NET_TX.rtc);
    this.publicKind = kind;
    this.derbyField = weak ? WEAK_DERBY_FIELD : PUBLIC_DERBY_FIELD;
    // The weak device's smaller field is the room's own rules; the player's options stay as they were.
    if (weak && kind === "race") this.game.race()?.command({ type: "program", options: { aiCount: WEAK_AI } });
    this.lobbyLeft = LOBBY_S;
  }

  /** Host: the Havana lobby opens (a new room, or a public match's results are over): every peer free-drives there until the game starts. */
  private openLobby(): void {
    this.lobbyOn = true;
    this.game.enterRace(false, true);
    this.syncSeats();
  }

  /** A public host's heartbeat tag for the relay's room list (`publicMeta`); "" for a guest or a private room. */
  private metaNow(): string {
    const kind = this.publicKind;
    if (this.role !== "host" || !kind) return "";
    const stage = this.lobbyOn ? "lobby" : matchStage(this.game, kind);
    return stage ? publicMeta(stage, kind === "race" ? (this.game.race()?.options.trackId ?? "") : "") : "";
  }

  /** Whether the Go switch works: the host is waiting in the lobby with at least `minPlayers` players. */
  canGo(): boolean {
    return this.role === "host" && this.lobbyOn && this.slots.size + 1 >= this.minPlayers;
  }

  /** Host: the Go switch. Starts the room's game (a race on the race options' course, Survival, or a derby) with everyone seated; false while `canGo` is not. */
  go(): boolean {
    if (!this.canGo()) return false;
    this.startGame();
    return true;
  }

  /** Host, lobby: how many players (host included) the Go switch waits for, 1 to `ROOM_MAX`. */
  setMinPlayers(n: number): void {
    if (this.role === "host" && this.lobbyOn) this.minPlayers = Math.min(ROOM_MAX, Math.max(1, Math.round(n) || 1));
  }

  /** Host, private lobby: the game Go starts. A public room's is the one its name says. */
  setLobbyKind(kind: GameKind): void {
    if (this.role === "host" && this.lobbyOn && !this.publicKind) this.lobbyKind = kind;
  }

  /** Host, lobby: the Survival course the lobby shows and Go's Survival run is on (`RaceDirector`'s `survivalCourse` pick); every guest's lobby follows. */
  setLobbyCourse(id: string): void {
    if (this.role === "host" && this.lobbyOn) this.game.race()?.command({ type: "survivalCourse", id });
  }

  /** Host, lobby: every car back at its spawn and repaired, every prop and piece of debris back (replicated to the guests through `clearGen`). */
  resetScene(): void {
    if (this.role === "host" && this.lobbyOn) this.game.resetLobbyScene();
  }

  /** The lobby ends: every peer is seated and the game starts. */
  private startGame(): void {
    const kind = this.publicKind ?? this.lobbyKind;
    this.lobbyOn = false;
    this.lobbyLeft = null;
    this.finishedFor = 0;
    this.syncSeats();
    if (kind === "race") this.game.startRace();
    else if (kind === "survival") this.game.enterRace(true);
    else this.game.startDerby(this.derbyField);
  }

  /** The lobby's start gate as the panel shows it (null outside the lobby): a client's is the host's, as its last race message said. */
  private currentGate(): (LobbyGate & { players: number }) | null {
    if (this.role === "host") return this.lobbyOn ? { min: this.minPlayers, kind: this.publicKind ?? this.lobbyKind, players: this.slots.size + 1 } : null;
    return this.heardGate && { ...this.heardGate, players: (this.transport?.peers().length ?? 0) + 1 };
  }

  /** The course the director shows and the Survival courses to pick from, as the lobby panel reads them. */
  private currentSurvivalCourse(): NetStatus["survivalCourse"] {
    const race = this.game.race();
    return { id: race?.courseId ?? "", courses: race?.survivalCourses ?? [] };
  }

  /** The player leaves, or the page closes: the session is over, so its dead rooms are forgotten. */
  leave(): void {
    this.dead = { rooms: [], unanswered: 0 };
    this.close();
  }

  private close(): void {
    this.finder++;
    this.finding = false;
    if (typeof window !== "undefined") window.removeEventListener("pagehide", this.onPageHide);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibility);
    if (this.role === "client" && this.game.race()) this.game.exitRace();
    if (this.role === "client" && this.derbySilentFor !== null) this.game.applyDerby(null, this.car);
    if (this.role === "host") {
      // Back to a solo game: no seat stays a network peer's, and no peer's last input keeps driving.
      const race = this.game.race();
      for (const car of this.slots.values()) race?.setRemoteInput(car, this.idle);
      race?.command({ type: "program", options: null });
      this.game.setSeats(new Map());
      if (this.lobbyOn) this.game.exitRace();
    }
    this.setHidden(false);
    this.derbySilentFor = null;
    this.voice.unbind();
    this.rosterDirty = false;
    this.transport?.close();
    this.transport = null;
    this.role = "off";
    this.car = -1;
    this.slots.clear();
    this.meters.fill(-1);
    this.vetted.clear();
    this.looks.clear();
    this.game.dropLooks();
    this.names.clear();
    this.heardAt.clear();
    this.hasInput.length = 0;
    this.lastWreckLen.length = 0;
    this.forgetHost();
    this.hostLost = false;
    this.refused = false;
    this.helloAcc = HELLO_EVERY;
    this.snapHz = 0;
    this.bytesPerSec = 0;
    this.lobbyLeft = null;
    this.finishedFor = 0;
    this.lobbyOn = false;
    this.minPlayers = DEFAULT_MIN_PLAYERS;
    this.lobbyKind = "race";
    this.heardGate = null;
  }

  /**
   * The tab was hidden or shown (`visibilitychange`). A hidden tab draws no frames: a guest sends an
   * idle input at once so its car doesn't hold its last throttle; a host sends a heartbeat every
   * `HOLD_EVERY_MS` so its guests wait instead of giving it up.
   */
  setHidden(hidden: boolean): void {
    clearInterval(this.holdTimer);
    this.holdTimer = undefined;
    const t = this.transport;
    if (!hidden || !t) return;
    if (this.role === "host") {
      const hold = new Uint8Array([MSG.hold]);
      t.send(hold);
      this.holdTimer = setInterval(() => this.transport?.send(hold), HOLD_EVERY_MS);
    } else if (this.car >= 0 && this.hostId !== null) {
      this.w.off = 0;
      writeInput(this.w, this.idle);
      t.send(this.w.done(), this.hostId);
    }
  }

  status(): NetStatus {
    const client = this.role === "client";
    return {
      role: this.role,
      room: this.room,
      tx: this.tx,
      selfId: this.transport?.selfId ?? "",
      car: this.car,
      lobby: this.lobbyLeft == null ? null : Math.max(0, Math.ceil(this.lobbyLeft)),
      gate: this.currentGate(),
      survivalCourse: this.currentSurvivalCourse(),
      peers: this.transport?.peers() ?? [],
      snapHz: this.snapHz,
      bytesPerSec: this.bytesPerSec,
      public: this.publicKind,
      finding: this.finding,
      problem: !client ? null : this.refused ? "version" : this.hostLost ? "host-lost" : this.hostHeld ? "host-paused" : this.noHost() ? "no-host" : null,
      relayError: this.transport?.error ?? null,
    };
  }

  /** Host, each fixed step after the local seat: every remote peer's car takes its latest input (race mode drives them itself). */
  drive(cars: DeformableCar[], dt: number, driven: number): void {
    for (const car of this.slots.values()) if (car < cars.length && this.drives(car, driven)) applyDrive(cars[car]!, this.inputs[car]!, dt);
  }

  /** Host: a peer's input drives car `i` this step (not in a race, not the local seat's car, its input heard and its car drivable). Only a car a peer's slot holds ever has input heard. */
  drives(i: number, driven: number): boolean {
    return this.role === "host" && !this.game.race() && i !== driven && this.hasInput[i] === true && this.game.remoteDrivable(i);
  }

  /** Host: a network peer drives car `i` (its car comes back after it vaporizes, like the host's own). */
  remoteCar(i: number): boolean {
    if (this.role !== "host") return false;
    for (const car of this.slots.values()) if (car === i) return true;
    return false;
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
    this.voice.update(wallDt);
  }

  private start(role: NetRole, room: string, tx: NetTx): void {
    this.close();
    const id = crypto.randomUUID().slice(0, 8);
    this.transport = this.connect(tx, room, id, role === "host" ? "host" : "client", () => this.metaNow());
    this.transport.onMessage = (from, data) => this.receive(from, data);
    if (this.transport instanceof RtcTransport) this.voice.bind(this.transport);
    this.role = role;
    this.room = room;
    this.tx = tx;
    this.publicKind = null;
    if (typeof window !== "undefined") window.addEventListener("pagehide", this.onPageHide);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisibility);
  }

  private receive(from: string, data: Uint8Array): void {
    this.r.reset(data);
    try {
      if (this.role === "host") this.hostReceive(from, data);
      else this.clientReceive(from, data);
    } catch (e) {
      // A truncated or malformed message: drop it (a decoder reads past its end or meets a value no host sends).
      if (!(e instanceof RangeError)) throw e;
    }
  }

  /** Netplay host: every peer's car is a `remote` seat from the next race or derby match on, under its name ("Player N" without one). */
  private syncSeats(): void {
    this.game.setSeats(new Map([...this.slots].map(([peer, car]) => [car, this.names.get(peer) || `Player ${car}`])));
  }

  // ── host ──────────────────────────────────────────────────────────────────

  private hostReceive(from: string, data: Uint8Array): void {
    const type = data[0];
    if (type === MSG.hello) {
      if (data[1] !== NET_VERSION) {
        this.sendAssign(from, REFUSED);
        return;
      }
      // Untrusted: shown on every peer's standings. An older layout without it gets the default name.
      this.r.off = 2;
      this.names.set(from, data.length > 2 ? cleanName(this.r.str()) : "");
      this.vetted.add(from);
      this.heardAt.set(from, this.now());
      this.sendAssign(from, this.assign(from));
      this.syncSeats();
    } else if (type === MSG.input) {
      let car = this.slots.get(from);
      if (car === undefined) {
        // Its car lapsed while the link was down, but the peer never noticed (it still hears us): seat it again now.
        if (!this.vetted.has(from)) return;
        car = this.assign(from);
        this.sendAssign(from, car);
      }
      const now = this.now();
      this.heardAt.set(from, now);
      const input = (this.inputs[car] ??= idleDrive());
      const ask = readInput(this.r, input, this.inMeter);
      this.meters[car] = this.inMeter[0]!;
      this.hasInput[car] = true;
      this.inputAt[car] = now;
      const race = this.game.race();
      if (this.lobbyOn && (ask & INPUT_RESET) !== 0) this.game.resetLobbyCar(car);
      if (race) {
        race.setRemoteInput(car, input);
        if ((ask & INPUT_RESPAWN) !== 0) race.requestRespawn(car);
        if ((ask & INPUT_HOLD) !== 0) race.holdReset(car);
      }
    } else if (type === MSG.look) {
      this.takeGuestLook(from, data);
    }
  }

  /** The peer's car: the one it has, else the lowest free one (Fleet grows the field to fit it). */
  private assign(peer: string): number {
    let car = this.slots.get(peer);
    if (car === undefined) {
      car = 1;
      for (const used = new Set(this.slots.values()); used.has(car); ) car++;
      this.slots.set(peer, car);
      this.hasInput[car] = false;
      // The lobby grows the field for a new peer at once, and puts its car on a spawn; a race or derby seats a new peer at its next start; so does Fleet.
      if (this.lobbyOn) {
        if (car >= this.game.cars().length) this.game.setCarCount(car + 1);
        this.game.resetLobbyCar(car);
      } else if (car >= this.game.cars().length && !this.game.race() && !this.game.derbyPhase()) this.game.setCarCount(car + 1);
      this.syncSeats();
      this.rosterDirty = true;
      this.keyframeDue = true;
    }
    return car;
  }

  private sendAssign(peer: string, car: number): void {
    this.w.off = 0;
    this.w.u8(MSG.assign);
    this.w.u8(car);
    this.w.u8(NET_VERSION);
    this.transport!.send(this.w.done(), peer);
  }

  /** Host: who drives which car goes to this host's own voice and, reliably, to every guest (`MSG.roster`): at once when a seat changes, and with every keyframe, since a guest's reliable channel can open after its seat is assigned. */
  private publishRoster(t: NetTransport): void {
    this.rosterDirty = false;
    const entries = [{ peer: t.selfId, car: 0, name: shownName(this.game.playerName(), "Host") }];
    for (const [peer, car] of this.slots) entries.push({ peer, car, name: shownName(this.names.get(peer) ?? "", `Player ${car}`) });
    this.voice.setRoster(entries);
    t.send(packRoster(entries), undefined, true);
  }

  /** A peer's input older than `INPUT_STALE_MS` (a stalled link, a hidden tab) turns idle: its car coasts instead of holding the last throttle. */
  private expireInputs(race: NetRace | null): void {
    const now = this.now();
    for (const car of this.slots.values()) {
      if (!this.hasInput[car] || now - this.inputAt[car]! <= INPUT_STALE_MS) continue;
      Object.assign(this.inputs[car]!, this.idle);
      race?.setRemoteInput(car, this.inputs[car]!);
    }
  }

  private hostFrame(wallDt: number, t: NetTransport): void {
    const race = this.game.race();
    this.runRoom(wallDt);
    this.expireInputs(race);
    this.sendAcc += wallDt;
    if (this.sendAcc < 1 / SEND_HZ) return;
    this.sendAcc = Math.min(this.sendAcc - 1 / SEND_HZ, 1 / SEND_HZ);
    const peers = t.peers();
    const now = this.now();
    let left = false;
    for (const [id, car] of this.slots) {
      // A connection blip drops a peer off the transport for a moment: its car waits `SLOT_GRACE_MS` for it.
      if (peers.some((p) => p.id === id) || now - (this.heardAt.get(id) ?? 0) < SLOT_GRACE_MS) continue;
      this.slots.delete(id);
      this.looks.delete(car);
      this.game.wearLook(car, null);
      this.names.delete(id);
      this.heardAt.delete(id);
      this.hasInput[car] = false;
      this.meters[car] = -1;
      race?.setRemoteInput(car, this.idle);
      left = true;
    }
    if (left) this.syncSeats();
    if (left || this.rosterDirty || this.seq % KEYFRAME_EVERY === 0) this.publishRoster(t);
    const cars = this.game.cars();
    if (cars.length === 0) return;
    const L = this.layoutOf(cars[0]!);
    const s = this.out;
    s.seq = ++this.seq;
    s.time = this.now() / 1000;
    s.keyframe = this.keyframeDue || this.seq % KEYFRAME_EVERY === 0;
    s.clearGen = this.game.clearGen();
    this.keyframeDue = false;
    s.count = cars.length;
    s.realism = HANDLING.realism;
    s.phase = PHASES.indexOf(this.game.phase());
    s.timeScale = this.game.timeScale();
    ensureFrames(s, cars.length, L);
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i]!;
      const f = s.cars[i]!;
      readCarPose(car, f);
      f.meter = this.game.meterOf(i) ?? -1;
      // A falling fake or a vaporized car shows no wreck: its mesh is frozen (falling) or hidden.
      if (!car.crashed || car.falling || car.vaporized) {
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
   * The host's room cycle. A public match: the lobby waits for `minPlayers` players, then counts down (`LOBBY_S`, sooner once the room is
   * full) and starts the match with every peer seated and the AI in the empty slots; the Go switch starts it early. A private room's lobby
   * waits for Go. A finished game of either shows its result for `RESULTS_HOLD` s, then everyone is back in the lobby.
   */
  private runRoom(wallDt: number): void {
    const kind = this.publicKind;
    if (this.lobbyOn) {
      if (!kind) return;
      // A room short of players holds its countdown at the full `LOBBY_S`.
      this.lobbyLeft = this.slots.size + 1 < this.minPlayers ? LOBBY_S : (this.lobbyLeft ?? LOBBY_S) - wallDt;
      if (this.lobbyLeft <= 0 || this.slots.size >= ROOM_MAX - 1) this.startGame();
      return;
    }
    if (matchStage(this.game, kind ?? (this.lobbyKind === "derby" ? "derby" : "race")) !== "over") {
      this.lobbyLeft = null;
      this.finishedFor = 0;
      return;
    }
    this.finishedFor += wallDt;
    if (this.finishedFor < RESULTS_HOLD) return;
    this.finishedFor = 0;
    this.lobbyLeft = kind ? LOBBY_S : null;
    this.openLobby();
  }

  /** The rules state (or, in the lobby, the course, countdown and start gate) to every client. */
  private sendRace(race: NetRace, t: NetTransport): void {
    const gate = this.lobbyOn ? { min: this.minPlayers, kind: this.publicKind ?? this.lobbyKind } : null;
    const msg = writeRace({ lobby: this.lobbyLeft, trackId: race.courseId, look: race.look, gate, snap: race.snapshot() });
    t.send(msg);
    this.statBytes += msg.length;
  }

  /** Host: one message to every peer on the reliable channel (a `reelParts` frame of the end-of-race highlight reel, an ejection). */
  sendReliable(msg: Uint8Array<ArrayBuffer>): void {
    if (this.role !== "host" || !this.transport) return;
    this.transport.send(msg, undefined, true);
    this.statBytes += msg.length;
  }

  /** Host: a driver was thrown out (`EjectionWatch`): every peer launches his dummy from this event, on the reliable channel. */
  sendEject(e: Ejection): void {
    this.sendReliable(packEject(e, this.now() / 1000));
  }

  /**
   * Host: guest `from`'s look (`MSG.look`) for its seat: worn here and relayed to every guest. Its first one is also when the
   * guest follows this host (it sends it after taking its seat), so it then gets the host's own look and every other player's.
   */
  private takeGuestLook(from: string, data: Uint8Array): void {
    const car = this.slots.get(from);
    const heard = readLook(data);
    if (car === undefined || !heard) return;
    const first = !this.looks.has(car);
    this.game.wearLook(car, heard.look);
    const relayed = data.slice();
    relayed[1] = car;
    this.looks.set(car, relayed);
    this.transport!.send(relayed, undefined, true);
    if (!first) return;
    this.transport!.send(packLook(0, this.game.playerLook()), from, true);
    for (const [other, look] of this.looks) if (other !== car) this.transport!.send(look, from, true);
  }
}
