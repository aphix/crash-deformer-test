import { z } from "zod";
import type { DeformableCar } from "../car.ts";
import type { CrashPhase } from "../hud-store.ts";
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
} from "./codec.ts";
import { RtcTransport } from "./rtc-transport.ts";
import { BroadcastTransport, type NetPeer, type NetTransport } from "./transport.ts";
import { PUBLIC_PREFIX } from "@/lib/multiplayer/rooms";

/** `GET api/rtc?list=public` (signaling.server.ts `listPublic`), fullest room first. */
const PUBLIC_LIST = z.object({
  rooms: z.array(z.object({ room: z.string().startsWith(PUBLIC_PREFIX).max(64), players: z.number().int() })),
});

/** Wire order of the crash phases (`Snapshot.phase`). */
const PHASES: readonly CrashPhase[] = ["approach", "impact", "slowmo", "aftermath"];

export type NetRole = "off" | "host" | "client";
/** `bc`: BroadcastChannel (tabs of one browser); `rtc`: WebRTC via `/api/rtc`. */
export type NetTx = "bc" | "rtc";

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
  readonly seat: DriverSeat;
}

export interface NetStatus {
  role: NetRole;
  /** A public room (`publicRace`): anyone pressing "Public race" may land in it. */
  public: boolean;
  room: string;
  tx: NetTx;
  selfId: string;
  /** This peer's car (host 0); −1 until the host assigns one. */
  car: number;
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
  private isPublic = false;
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
  }

  /**
   * Public race: join the fullest open public room over WebRTC (the relay lists rooms with a live
   * host and a free seat), or host a new one when none is open.
   */
  async publicRace(): Promise<void> {
    let open: string | undefined;
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}api/rtc?list=public`);
      const list = PUBLIC_LIST.safeParse(res.ok ? await res.json() : null);
      if (list.success) open = list.data.rooms[0]?.room;
    } catch {
      // Offline or relay down: host a room of our own, which others can still find later.
    }
    if (open) this.join(open, "rtc");
    else this.host(`${PUBLIC_PREFIX}${Math.random().toString(36).slice(2, 8).toUpperCase()}`, "rtc");
    this.isPublic = true;
  }

  leave(): void {
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
  }

  status(): NetStatus {
    return {
      role: this.role,
      room: this.room,
      tx: this.tx,
      selfId: this.transport?.selfId ?? "",
      car: this.car,
      peers: this.transport?.peers() ?? [],
      snapHz: this.snapHz,
      bytesPerSec: this.bytesPerSec,
      public: this.isPublic,
    };
  }

  /** Host, each fixed step after the local seat: every remote peer's car takes its latest input. */
  drive(cars: DeformableCar[], dt: number, driven: number): void {
    if (this.role !== "host") return;
    for (const car of this.slots.values()) {
      if (car === driven || car >= cars.length || !this.hasInput[car]) continue;
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
    this.isPublic = false;
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
        readInput(this.r, (this.inputs[car] ??= idleDrive()));
        this.hasInput[car] = true;
      }
    } else if (type === MSG.assign) {
      this.r.u8();
      const car = this.r.u8();
      if (car === this.car) return;
      this.car = car;
      this.game.seat.focus(car);
    } else if (type === MSG.snapshot) {
      this.takeSnapshot(data);
    }
  }

  // ── host ──────────────────────────────────────────────────────────────────

  private assign(peer: string): void {
    let car = this.slots.get(peer);
    if (car === undefined) {
      car = 1;
      for (const used = new Set(this.slots.values()); used.has(car); ) car++;
      this.slots.set(peer, car);
      this.hasInput[car] = false;
      if (car >= this.game.cars().length) this.game.setCarCount(car + 1);
      this.keyframeDue = true;
    }
    this.w.off = 0;
    this.w.u8(MSG.assign);
    this.w.u8(car);
    this.transport!.send(this.w.done(), peer);
  }

  private hostFrame(wallDt: number, t: NetTransport): void {
    this.sendAcc += wallDt;
    if (this.sendAcc < 1 / SEND_HZ) return;
    this.sendAcc = Math.min(this.sendAcc - 1 / SEND_HZ, 1 / SEND_HZ);
    const peers = t.peers();
    for (const [id, car] of this.slots) {
      if (peers.some((p) => p.id === id)) continue;
      this.slots.delete(id);
      this.hasInput[car] = false;
    }
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
  }

  // ── client ────────────────────────────────────────────────────────────────

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
  }

  private clientFrame(wallDt: number, t: NetTransport): void {
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
      if (this.car >= 0) this.game.seat.focus(this.car);
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
    writeInput(this.w, input);
    t.send(this.w.done());
  }
}
