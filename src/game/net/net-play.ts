import type { DeformableCar } from "../vehicle/car.ts";
import { applyDrive, idleDrive, type DriveInput } from "../vehicle/car-drive.ts";
import { CAR_STYLE_IDS } from "../vehicle/car-variants.ts";
import { HANDLING, VEHICLE_CLASS_IDS } from "../vehicle/vehicle-classes.ts";
import type { Ejection } from "../vehicle/ejection.ts";
import { EjectQueue } from "./eject-queue.ts";
import {
  ensureFrames,
  makeSnapshot,
  MSG,
  NET_VERSION,
  INPUT_HOLD,
  INPUT_RESPAWN,
  readInput,
  Reader,
  readRace,
  readSnapshot,
  writeInput,
  writeRace,
  writeSnapshot,
  writeWreck,
  Writer,
  type NetLayout,
  type Snapshot,
  type DerbyNetState, readDerby, writeDerby, packEject,
} from "./codec.ts";
import { PHASES, type NetGame, type NetRace, type NetRole, type NetStatus, type NetTx, type PublicKind } from "./net-ports.ts";
import { cleanName } from "../match/types.ts";
import { drawSnapshots } from "./net-view.ts";
import { RtcTransport } from "./rtc-transport.ts";
import { BroadcastTransport, type NetTransport } from "./transport.ts";
import { playHostReel } from "./reel-codec.ts";
import { ReelParts } from "./reel-wire.ts";
import { carLayout, readCarPose } from "./car-pose.ts";
import { ROOM_MAX } from "../../lib/multiplayer/rooms.ts";
import { fetchRooms, findMatch, matchStage, publicMeta, publicRoomName, WEAK_AI, WEAK_DERBY_FIELD, type MatchDeps } from "./matchmaking.ts";
import {
  HELLO_EVERY, HOLD_EVERY_MS, HOST_LOST_MS, HOST_WAIT_MS, INPUT_STALE_MS, INTERP_DELAY, KEYFRAME_EVERY, LOBBY_S, MAX_DEAD_ROOMS,
  PUBLIC_DERBY_FIELD, RACE_EVERY, RACE_GONE_MS, REDUNDANT, REFUSED, RESULTS_HOLD, RING, SEND_HZ, SLOT_GRACE_MS,
} from "./net-constants.ts";

/** Opens this peer's link to a room: `role` is the roster tag the relay knows it by. */
type Connect = (tx: NetTx, room: string, id: string, role: "host" | "client", meta: () => string) => NetTransport;

const connectDefault: Connect = (tx, room, id, role, meta) => (tx === "rtc" ? new RtcTransport(room, id, role, meta) : new BroadcastTransport(room, id));

/** Test seams: the link (default WebRTC or BroadcastChannel), the clock (ms, default `performance.now`) and the matchmaker's pauses and dice. */
interface NetPlayOptions {
  connect?: Connect;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/**
 * Host-authoritative netplay (docs/MULTIPLAYER.md). The host simulates and broadcasts snapshots; each
 * client drives one car by sending its seat's shaped `DriveInput`, and draws every car from the
 * snapshots: poses interpolated, deform and parts applied as the host last skinned them.
 */
export class NetPlay {
  role: NetRole = "off";
  private readonly game: NetGame;
  private transport: NetTransport | null = null;
  private readonly connect: Connect;
  private readonly now: () => number;
  /** The room this peer is in and the link it runs over; meaningful while `role` is not "off" (the page's `#` shows them). */
  room = "";
  tx: NetTx = "bc";
  private publicKind: PublicKind | null = null;
  /** The running public search's token (a newer search, or `leave`, cancels it) and whether it still looks. */
  private finder = 0;
  private finding = false;
  /** Public rooms this session gave up on (no search joins them again) and how many in a row never answered; `leave` and `publicMatch` forget both. */
  private dead: { rooms: string[]; unanswered: number } = { rooms: [], unanswered: 0 };
  private derbyField = PUBLIC_DERBY_FIELD;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
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
  /** Peer id → the name its hello carried (cleaned; "" when none). */
  private readonly names = new Map<string, string>();
  /** Peers whose hello carried this build's version: their input may (re)claim a car. */
  private readonly vetted = new Set<string>();
  /** Peer id → `now()` of its last message: a peer off the transport keeps its car until this is `SLOT_GRACE_MS` old. */
  private readonly heardAt = new Map<string, number>();
  private readonly inputs: DriveInput[] = [];
  private readonly hasInput: boolean[] = [];
  /** Per car: `now()` its input last arrived. */
  private readonly inputAt: number[] = [];
  /** Hidden host: the heartbeat timer telling guests it is only paused. */
  private holdTimer: ReturnType<typeof setInterval> | undefined;
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
  private readonly ejects = new EjectQueue();
  private readonly reelIn = new ReelParts();
  /** Smallest seen (local clock − host clock), s: the host time "now" is local − offset. */
  private offset = Infinity;
  /** Per car: receive order of the wreck section last applied. */
  private readonly applied: number[] = [];
  /** `clearGen` of the snapshot drawn last (-1: none since joining this host); a change clears this scene (`drawSnapshots`). */
  private drawnGen = -1;
  private readonly idle = idleDrive();
  private helloAcc = HELLO_EVERY;
  /** Client: frame time (s, `wallDt` summed, each capped by the engine) since joining or the host's last message. */
  private silentFor = 0;
  /** Whether this peer has heard any host since it joined. */
  private heardHost = false;
  /** The host this client follows: the sender of the first assign; every host message from anyone else is dropped. */
  private hostId: string | null = null;
  /** `now()` of the followed host's last message, and whether that was a hidden tab's heartbeat. */
  private hostAt = 0;
  private hostHeld = false;
  /** The followed host went silent: this client is asking for a car again. */
  private hostLost = false;
  /** The host refused this build; no more hellos. */
  private refused = false;
  /** Seconds left in the public-race lobby (host counts down, clients mirror it); null outside one. */
  private lobbyLeft: number | null = null;
  /** Host: seconds the finished public race has been showing its results. */
  private finishedFor = 0;
  /** Client: R was tapped or held (`INPUT_RESPAWN`, `INPUT_HOLD`); rides on the next input packet. */
  private resetWanted = 0;
  /** Client: `performance.now()` of the host's last race message (race mode follows the host's). */
  private raceAt = 0;
  /** Client: `performance.now()` of the host's last derby message (0: not in derby mode). */
  private derbyAt = 0;
  /** A closed tab never runs the engine's dispose: leave the room so the relay drops us at once. */
  private readonly onPageHide = (): void => this.leave();
  /** A hidden tab draws no frames: a guest idles its car, a host tells its guests it is paused. */
  private readonly onVisibility = (): void => this.setHidden(document.hidden);

  constructor(game: NetGame, opts: NetPlayOptions = {}) {
    this.game = game;
    this.connect = opts.connect ?? connectDefault;
    this.now = opts.now ?? (() => performance.now());
    // Executor form: the tsconfig lib predates `Promise.withResolvers`.
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = opts.random ?? Math.random;
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
    this.silentFor = 0;
    this.heardHost = false;
  }

  /**
   * Play online (docs/MULTIPLAYER.md "Matchmaking"): join the best open public room of `kind`, else host one
   * (`findMatch` decides, with this device's `hostFit`). Resolves when the search is over; `status().finding`
   * is true until it joins or hosts. A newer search or `leave` cancels this one. The player starts it, so the
   * session's dead rooms are forgotten.
   */
  async publicMatch(kind: PublicKind): Promise<void> {
    this.dead = { rooms: [], unanswered: 0 };
    await this.search(kind);
  }

  /** One `findMatch` that never joins a dead room: the player's search, or the one a dead room sends its guest on. */
  private async search(kind: PublicKind): Promise<void> {
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
    this.join(room, "rtc");
    this.publicKind = kind;
  }

  /** Host a fresh public room: the lobby counts `LOBBY_S` down on the course or in the bowl, then the match starts; `weak` runs a smaller field. */
  publicHost(kind: PublicKind, weak = !this.game.hostFit()): void {
    this.host(publicRoomName(kind, Math.random().toString(36).slice(2, 8).toUpperCase()), "rtc");
    this.publicKind = kind;
    this.derbyField = weak ? WEAK_DERBY_FIELD : PUBLIC_DERBY_FIELD;
    if (kind === "race") {
      this.game.enterRace();
      const race = this.game.race();
      // The weak device's smaller field is the room's own rules; the player's options stay as they were.
      if (weak && race) race.command({ type: "program", options: { aiCount: WEAK_AI } });
      // No setup menu: the lobby picks nothing; the race starts on its own when the countdown ends.
      race?.showLobby(race.options.trackId);
    } else this.game.derbyLobby(this.derbyField);
    this.lobbyLeft = LOBBY_S;
    this.syncSeats();
  }

  /** A public host's heartbeat tag for the relay's room list (`publicMeta`); "" for a guest or a private room. */
  private metaNow(): string {
    const kind = this.publicKind;
    const stage = this.role === "host" && kind ? matchStage(this.game, kind) : null;
    return stage ? publicMeta(stage, kind === "race" ? (this.game.race()?.options.trackId ?? "") : "") : "";
  }

  /** Client: ask the host to put this peer's car back on the track (race R / D-pad down). */
  requestRespawn(): void {
    this.resetWanted |= INPUT_RESPAWN;
  }

  /** Client: ask the host to put this peer's car back on the track now with its damage kept (race R held). */
  requestHoldReset(): void {
    this.resetWanted |= INPUT_HOLD;
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
    if (this.role === "client" && this.derbyAt > 0) this.game.applyDerby(null, this.car);
    if (this.role === "host") {
      // Back to a solo game: no seat stays a network peer's, and no peer's last input keeps driving.
      const race = this.game.race();
      for (const car of this.slots.values()) race?.setRemoteInput(car, this.idle);
      race?.command({ type: "program", options: null });
      this.game.setSeats(new Map());
    }
    this.setHidden(false);
    this.derbyAt = 0;
    this.transport?.close();
    this.transport = null;
    this.role = "off";
    this.car = -1;
    this.slots.clear();
    this.vetted.clear();
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
      peers: this.transport?.peers() ?? [],
      snapHz: this.snapHz,
      bytesPerSec: this.bytesPerSec,
      public: this.publicKind,
      finding: this.finding,
      problem: !client ? null : this.refused ? "version" : this.hostLost ? "host-lost" : this.hostHeld ? "host-paused" : this.noHost() ? "no-host" : null,
      relayError: this.transport?.error ?? null,
    };
  }

  /** Joined a private room and heard no host in `HOST_WAIT_MS` of frames: a closed room, or a link to nobody. */
  private noHost(): boolean {
    return !this.heardHost && !this.publicKind && this.silentFor * 1000 > HOST_WAIT_MS;
  }

  /** Host, each fixed step after the local seat: every remote peer's car takes its latest input (race mode drives them itself). */
  drive(cars: DeformableCar[], dt: number, driven: number): void {
    if (this.role !== "host" || this.game.race()) return;
    for (const car of this.slots.values()) {
      if (car === driven || car >= cars.length || !this.hasInput[car] || !this.game.remoteDrivable(car)) continue;
      applyDrive(cars[car]!, this.inputs[car]!, dt);
    }
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
  }

  private start(role: NetRole, room: string, tx: NetTx): void {
    this.close();
    const id = crypto.randomUUID().slice(0, 8);
    this.transport = this.connect(tx, room, id, role === "host" ? "host" : "client", () => this.metaNow());
    this.transport.onMessage = (from, data) => this.receive(from, data);
    this.role = role;
    this.room = room;
    this.tx = tx;
    this.publicKind = null;
    if (typeof window !== "undefined") window.addEventListener("pagehide", this.onPageHide);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisibility);
  }

  private layoutOf(car: DeformableCar): NetLayout {
    this.layout ??= carLayout(car);
    return this.layout;
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
      const ask = readInput(this.r, input);
      this.hasInput[car] = true;
      this.inputAt[car] = now;
      const race = this.game.race();
      if (race) {
        race.setRemoteInput(car, input);
        if ((ask & INPUT_RESPAWN) !== 0) race.requestRespawn(car);
        if ((ask & INPUT_HOLD) !== 0) race.holdReset(car);
      }
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
      // A race or derby seats a new peer at its next start; only Fleet grows the field at once.
      if (car >= this.game.cars().length && !this.game.race() && !this.game.derbyPhase()) this.game.setCarCount(car + 1);
      this.syncSeats();
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
    if (this.publicKind) this.runPublic(this.publicKind, wallDt);
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
      this.names.delete(id);
      this.heardAt.delete(id);
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
   * A public match on the host: the lobby counts down (`LOBBY_S`, sooner once the room is full),
   * then the match starts with every peer seated and the AI in the empty slots; a finished match
   * shows its result for `RESULTS_HOLD` s and the next one starts, seating whoever joined meanwhile.
   */
  private runPublic(kind: PublicKind, wallDt: number): void {
    const stage = matchStage(this.game, kind);
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
    else this.game.startDerby(this.derbyField);
  }

  /** The rules state (or, between races, the lobby countdown and course) to every client. */
  private sendRace(race: NetRace, t: NetTransport): void {
    const msg = writeRace({ lobby: this.lobbyLeft, trackId: race.options.trackId, look: race.look, snap: race.snapshot() });
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
  // ── client ────────────────────────────────────────────────────────────────
  private clientReceive(from: string, data: Uint8Array): void {
    const type = data[0];
    if (type === MSG.assign) {
      this.takeAssign(from, data);
      return;
    }
    // Only the host this client follows speaks for the room.
    if (from !== this.hostId) return;
    this.hostAt = this.now();
    this.silentFor = 0;
    this.hostHeld = type === MSG.hold;
    if (type === MSG.snapshot) this.takeSnapshot(data);
    else if (type === MSG.race) this.takeRace(data);
    else if (type === MSG.derby) this.takeDerby();
    else if (type === MSG.reelPart) this.takeReel(this.reelIn.take(data));
    else if (type === MSG.eject) this.ejects.take(this.r);
  }

  /** The host's highlight reel (`playHostReel`) once its last part is in, its start moved onto this browser's clock by the snapshot offset. */
  private takeReel(data: Uint8Array | null): void {
    const car = this.game.cars()[0];
    const t = this.transport;
    if (data && car && Number.isFinite(this.offset)) playHostReel(data, this.layoutOf(car), this.offset, (reel, at) => this.game.playReel(reel, at), () => this.transport === t);
  }

  /**
   * The host's answer to a hello: this peer's car, or a refusal (another build). The first assign
   * pins its sender as the host; with a relay roster that sender must be the peer it lists as host.
   */
  private takeAssign(from: string, data: Uint8Array): void {
    if (this.hostId !== null ? from !== this.hostId : this.transport?.peers().find((p) => p.id === from)?.host === false) return;
    if (data.length < 3 || data[2] !== NET_VERSION || data[1] === REFUSED) {
      this.refused = true;
      return;
    }
    const car = data[1]!;
    this.hostId = from;
    this.hostAt = this.now();
    this.silentFor = 0;
    this.heardHost = true;
    this.hostLost = false;
    if (car === this.car) return;
    this.car = car;
    if (!this.game.race() && !this.game.derbyPhase()) this.game.seat.focus(car);
  }

  /** Drop the followed host and everything heard from it: the next host starts its own clock and sequence. */
  private forgetHost(): void {
    this.hostId = null;
    this.hostHeld = false;
    this.ringOrder.fill(0);
    this.lastSeq = -1;
    this.offset = Infinity;
    this.applied.length = 0;
    this.drawnGen = -1;
    this.ejects.clear();
  }

  /** The host's race state: race mode on, then its session (or its lobby) adopted. Never stepped here. */
  private takeRace(data: Uint8Array): void {
    const s = readRace(data);
    if (!s) return;
    this.lobbyLeft = s.lobby;
    this.raceAt = this.now();
    this.game.enterRace();
    const race = this.game.race();
    if (!race) return;
    race.look = s.look;
    try {
      if (s.snap) race.applySnapshot(s.snap, this.car);
      else race.showLobby(s.trackId);
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
    this.derbyAt = this.now();
    this.game.applyDerby(state, this.car);
  }

  private takeSnapshot(data: Uint8Array): void {
    const cars = this.game.cars();
    if (cars.length === 0) return;
    const seq = data[2]! | (data[3]! << 8);
    if (this.lastSeq >= 0 && ((seq - this.lastSeq) & 0xffff) >= 0x8000) return;
    if (seq === this.lastSeq) return;
    let slot = 0;
    for (let k = 1; k < RING; k++) if (this.ringOrder[k]! < this.ringOrder[slot]!) slot = k;
    const s = (this.ring[slot] ??= makeSnapshot());
    // Decode into a slot marked empty: one that fails (throws, or names a body this build lacks) leaves no half-written frame and `lastSeq` as it was.
    this.ringOrder[slot] = 0;
    readSnapshot(this.r, s, this.layoutOf(cars[0]!));
    for (let i = 0; i < s.count; i++) if (s.cars[i]!.style >= CAR_STYLE_IDS.length || s.cars[i]!.cls >= VEHICLE_CLASS_IDS.length) return;
    this.lastSeq = seq;
    this.ringOrder[slot] = ++this.order;
    this.offset = Math.min(this.now() / 1000 - s.time, this.offset + 0.001);
    this.statSnaps++;
    this.statBytes += data.byteLength;
  }

  private clientFrame(wallDt: number, t: NetTransport): void {
    // The host went quiet. A hidden host still on the link only paused; otherwise it is gone (closed, lost, restarted).
    this.silentFor += wallDt;
    const quiet = this.now() - this.hostAt;
    const paused = this.hostHeld && t.peers().some((p) => p.id === this.hostId);
    if (this.publicKind && !paused && !this.finding && this.silentFor * 1000 > HOST_WAIT_MS) {
      // A dead public room (its relay row outlives the host by up to 30 s) is no use to anyone: look for another, else host one.
      // A room that answered before and then went quiet (its host left) is a normal end, not a streak of dead ones.
      this.dead = { rooms: [...this.dead.rooms, this.room], unanswered: this.heardHost ? 0 : this.dead.unanswered + 1 };
      if (this.dead.unanswered < MAX_DEAD_ROOMS) void this.search(this.publicKind);
      else this.publicHost(this.publicKind);
      return;
    }
    if (this.hostId !== null && !paused && quiet > HOST_LOST_MS) {
      // Ask for a car again, keeping this one meanwhile (camera, and a pedal held through the outage, stay
      // on it): the same host, back after a blip, seats this peer where it was; a new host may move it.
      this.forgetHost();
      this.hostLost = true;
    }
    // The host left race or derby mode (its messages stop): so does this client.
    if (this.game.race() && this.heardHost && this.now() - this.raceAt > RACE_GONE_MS) {
      this.game.exitRace();
      this.lobbyLeft = null;
    }
    if (this.derbyAt > 0 && this.now() - this.derbyAt > RACE_GONE_MS) {
      this.game.applyDerby(null, this.car);
      this.derbyAt = 0;
      this.lobbyLeft = null;
    }
    if (this.hostId === null && !this.refused) {
      this.helloAcc += wallDt;
      if (this.helloAcc >= HELLO_EVERY) {
        this.helloAcc = 0;
        this.w.off = 0;
        this.w.u8(MSG.hello);
        this.w.u8(NET_VERSION);
        this.w.str(this.game.playerName());
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
    // A playing reel owns the cars; snapshots keep arriving for when it ends.
    // The host's world `INTERP_DELAY` behind this client's estimate of the host clock.
    const rt = this.now() / 1000 - this.offset - INTERP_DELAY;
    if (!this.game.reelPlaying()) this.drawnGen = drawSnapshots(this.ring, this.ringOrder, this.applied, cars, rt, wallDt, this.game, this.drawnGen);
    this.ejects.due(rt, this.game);

    if (this.car < 0 || this.car >= cars.length || this.hostId === null) return;
    const seat = this.game.seat;
    const input = seat.mode === "drive" && seat.carIndex === this.car ? seat.input(cars[this.car]!, wallDt) : this.idle;
    this.sendAcc += wallDt;
    if (this.sendAcc < 1 / SEND_HZ) return;
    this.sendAcc = 0;
    this.w.off = 0;
    writeInput(this.w, input, this.resetWanted);
    this.resetWanted = 0;
    t.send(this.w.done(), this.hostId);
  }
}
