import type { DeformableCar } from "../vehicle/car.ts";
import { idleDrive } from "../vehicle/car-drive.ts";
import { CAR_STYLE_IDS } from "../vehicle/car-variants.ts";
import { HANDLING, VEHICLE_CLASS_IDS } from "../vehicle/vehicle-classes.ts";
import { EjectQueue } from "./eject-queue.ts";
import {
  makeSnapshot,
  MAX_NET_CARS,
  MSG,
  NET_VERSION,
  INPUT_HOLD,
  INPUT_RESPAWN,
  INPUT_RESET,
  Reader,
  readRace,
  readSnapshot,
  writeInput,
  Writer,
  readDerby,
  type NetLayout,
  type Snapshot,
  type DerbyNetState,
  type LobbyGate,
} from "./codec.ts";
import { PHASES, type NetGame, type PublicKind } from "./net-ports.ts";
import { drawSnapshots } from "./net-view.ts";
import { packLook, readLook } from "./look-codec.ts";
import type { NetTransport } from "./transport.ts";
import { playHostReel } from "./reel-codec.ts";
import { ReelParts } from "./reel-wire.ts";
import { carLayout } from "./car-pose.ts";
import { readRoster } from "./roster-codec.ts";
import { Voice } from "./voice.ts";
import { HELLO_EVERY, HOST_LOST_MS, HOST_WAIT_MS, INTERP_DELAY, MAX_DEAD_ROOMS, RACE_GONE_MS, REFUSED, RING, SEND_HZ } from "./net-constants.ts";

/**
 * The client half of `NetPlay` and the state both halves share: a client draws every car from the host's
 * snapshots (poses interpolated, deform and parts applied as the host last skinned them) and sends its
 * seat's shaped `DriveInput` back. `NetPlay` adds the host and the room around it.
 */
export abstract class NetPlayClient {
  protected readonly game: NetGame;
  /** Opt-in proximity voice over this room's WebRTC mesh. */
  readonly voice: Voice;
  protected transport: NetTransport | null = null;
  protected readonly now: () => number;
  /** The room this peer is in and the link it runs over; meaningful while `role` is not "off" (the page's `#` shows them). */
  room = "";
  protected publicKind: PublicKind | null = null;
  /** Whether the public search still looks. */
  protected finding = false;
  /** Public rooms this session gave up on (no search joins them again) and how many in a row never answered; `leave` and `publicMatch` forget both. */
  protected dead: { rooms: string[]; unanswered: number } = { rooms: [], unanswered: 0 };
  protected car = -1;
  protected layout: NetLayout | null = null;
  protected readonly w = new Writer();
  protected readonly r = new Reader();
  protected sendAcc = 0;
  protected statSnaps = 0;
  protected statBytes = 0;
  /** Per car: its boost meter as netplay heard it (host: a peer's own, from its input; client: the host's, from the newest snapshot); -1 none. */
  protected readonly meters = new Float64Array(MAX_NET_CARS).fill(-1);
  protected readonly idle = idleDrive();
  /** Seconds left in the public-race lobby (host counts down, clients mirror it); null outside one. */
  protected lobbyLeft: number | null = null;
  /** Seconds before the host moves a campaign on from its results (host counts down, clients mirror it); null when it waits for the host's Next or no round just ended. */
  protected nextLeft: number | null = null;

  protected readonly ring: Snapshot[] = [];
  /** Receive order of each ring slot (0 = empty). */
  protected readonly ringOrder = new Array<number>(RING).fill(0);
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
  protected helloAcc = HELLO_EVERY;
  /** Frame time (s, `wallDt` summed, each capped by the engine) since joining or the host's last message. */
  protected silentFor = 0;
  /** Whether this peer has heard any host since it joined. */
  protected heardHost = false;
  /** The host this client follows: the sender of the first assign; every host message from anyone else is dropped. */
  protected hostId: string | null = null;
  /** `now()` of the followed host's last message, and whether that was a hidden tab's heartbeat. */
  private hostAt = 0;
  protected hostHeld = false;
  /** The followed host went silent: this client is asking for a car again. */
  protected hostLost = false;
  /** The host refused this build; no more hellos. */
  protected refused = false;
  /** R was tapped or held (`INPUT_RESPAWN`, `INPUT_HOLD`); rides on the next input packet. */
  private resetWanted = 0;
  /** The host's lobby gate as its last race message said; null while a game runs. */
  protected heardGate: LobbyGate | null = null;
  /**
   * Frame time (s) since the host's last race message, counted only while this client could hear
   * (frames ran, the host not merely paused), so a hidden tab or a throttled host never ends the race.
   */
  protected raceSilentFor = 0;
  /** The same for the host's derby messages; null: not in derby mode. */
  protected derbySilentFor: number | null = null;

  constructor(game: NetGame, now: () => number) {
    this.game = game;
    this.now = now;
    this.voice = new Voice({
      selfId: () => this.transport?.selfId ?? "",
      localCar: () => this.car,
      carPosition: (car) => this.game.cars()[car]?.group.position ?? null,
    });
  }

  /** Implemented by `NetPlay`: a client whose public room died searches for another, or hosts one. */
  protected abstract search(kind: PublicKind): Promise<void>;
  abstract publicHost(kind: PublicKind, weak?: boolean): void;

  protected layoutOf(car: DeformableCar): NetLayout {
    this.layout ??= carLayout(car);
    return this.layout;
  }

  /** Client: ask the host to put this peer's car back on the track (race R / D-pad down), or at a lobby spawn. */
  requestRespawn(): void {
    this.resetWanted |= this.heardGate ? INPUT_RESET : INPUT_RESPAWN;
  }

  /** Client: ask the host to put this peer's car back on the track now with its damage kept (race R held); in the lobby the same as a tap. */
  requestHoldReset(): void {
    this.resetWanted |= this.heardGate ? INPUT_RESET : INPUT_HOLD;
  }

  /** Joined a private room and heard no host in `HOST_WAIT_MS` of frames: a closed room, or a link to nobody. */
  protected noHost(): boolean {
    return !this.heardHost && !this.publicKind && this.silentFor * 1000 > HOST_WAIT_MS;
  }

  protected clientReceive(from: string, data: Uint8Array): void {
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
    else if (type === MSG.look) {
      const heard = readLook(data);
      if (heard && heard.car !== this.car) this.game.wearLook(heard.car, heard.look);
    } else if (type === MSG.roster) {
      const entries = readRoster(data);
      if (entries) this.voice.setRoster(entries);
    }
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
    // Once seated, this player's look goes to the host, which shows it and hands it to everyone else; here the seat drops any
    // other player's look it wore and wears this player's own.
    this.transport?.send(packLook(car, this.game.playerLook()), from, true);
    this.game.wearLook(car, null);
    if (!this.game.race() && !this.game.derbyPhase()) this.game.seat.focus(car);
    else this.game.race()?.seatLobby(car);
  }

  /** Drop the followed host and everything heard from it: the next host starts its own clock and sequence. */
  protected forgetHost(): void {
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
    this.heardGate = s.gate;
    this.nextLeft = s.next;
    this.raceSilentFor = 0;
    this.game.enterRace(s.snap?.survival != null, s.gate !== null);
    const race = this.game.race();
    if (!race) return;
    race.look = s.look;
    try {
      if (s.snap) race.applySnapshot(s.snap, this.car);
      else {
        race.showLobby(s.trackId);
        if (this.car >= 0) race.seatLobby(this.car);
      }
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
    this.heardGate = null;
    this.derbySilentFor = 0;
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
    for (let i = 0; i < s.count; i++) this.meters[i] = s.cars[i]!.meter;
    this.lastSeq = seq;
    this.ringOrder[slot] = ++this.order;
    this.offset = Math.min(this.now() / 1000 - s.time, this.offset + 0.001);
    this.statSnaps++;
    this.statBytes += data.byteLength;
  }

  protected clientFrame(wallDt: number, t: NetTransport): void {
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
    // The host left race or derby mode (its messages stop): so does this client. Only frames this client ran
    // while the host wasn't merely paused count: a hidden tab or a throttled host sends no race messages.
    if (!paused) {
      this.raceSilentFor += wallDt;
      if (this.derbySilentFor !== null) this.derbySilentFor += wallDt;
      this.game.race()?.advanceClock(wallDt);
    }
    if (this.game.race() && this.heardHost && this.raceSilentFor * 1000 > RACE_GONE_MS) {
      this.game.exitRace();
      this.lobbyLeft = null;
      this.heardGate = null;
      this.nextLeft = null;
    }
    if (this.derbySilentFor !== null && this.derbySilentFor * 1000 > RACE_GONE_MS) {
      this.game.applyDerby(null, this.car);
      this.derbySilentFor = null;
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
      if (this.car >= 0 && !this.game.race() && this.derbySilentFor === null) this.game.seat.focus(this.car);
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
    writeInput(this.w, input, this.resetWanted, input === this.idle ? 0 : seat.boost);
    this.resetWanted = 0;
    t.send(this.w.done(), this.hostId);
  }
}
