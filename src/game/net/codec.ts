import { z } from "zod";
import type { DriveInput } from "../car-drive.ts";
import type { PartNetState } from "../car-core.ts";
import type { DerbyBoardRow, DerbyDecided } from "../derby.ts";
import type { RaceSnapshot } from "../race/types.ts";
import type { DeformNetState } from "../streamed-deform.ts";

/**
 * Binary netplay messages (docs/MULTIPLAYER.md). Little-endian, quantized to i16 steps that keep
 * every mesh and hull point well inside 1 mm of the host's.
 */
/**
 * `race`: the host's race state as UTF-8 JSON after the type byte (`NetPlay.sendRace`); `derby`: `writeDerby`;
 * `hold`: a hidden host's heartbeat (its tab cannot render, so nothing else comes); `hello`: type,
 * `NET_VERSION`, the player's name (`Writer.str`; the host cleans it, `cleanName`).
 */
export const MSG = { snapshot: 1, input: 2, hello: 3, assign: 4, race: 5, derby: 6, hold: 7 } as const;

/**
 * Wire format version, carried by hello and assign: peers on different builds (an auto-deploy mid-session)
 * refuse each other instead of misreading snapshots. Bump on any change to a message layout.
 * 3: hello carries the player's name.
 */
export const NET_VERSION = 3;

/** Most cars a snapshot or derby board may carry (the engine's `MAX_CARS`). */
export const MAX_NET_CARS = 32;

/** Quantization steps. */
export const Q = {
  /** Body-frame particle positions (m). */
  pos: 1 / 2000,
  /** Cluster skin maps (unitless 3×3). */
  xf: 1 / 8192,
  /** Euler angles (rad), sensor compression (m), impact entries, hinge values. */
  fine: 1e-4,
  /** Velocity (m/s). */
  vel: 0.01,
  /** Yaw rate (rad/s). */
  rate: 1e-3,
  /** Quaternion components. */
  quat: 1 / 32767,
} as const;

/** Per-car array sizes, from `StreamedDeformation.netSizes()` and `DeformableCar.partNetSizes()`. */
export interface NetLayout {
  masses: number;
  clusters: number;
  sensors: number;
  parts: number;
  wheels: number;
}

export interface CarFrame {
  x: number;
  y: number;
  z: number;
  /** Group Euler angles, YXZ order (yaw in (−π, π]). */
  yaw: number;
  pitch: number;
  roll: number;
  vx: number;
  vy: number;
  vz: number;
  /** Yaw rate (rad/s). */
  wy: number;
  crashed: boolean;
  /** Fleet disc edge (EdgeFall): gone in smoke (`setVaporized`), or a falling fake past the rim (no mesh updates). */
  vaporized: boolean;
  falling: boolean;
  /** Index into `CAR_STYLE_IDS` / `VEHICLE_CLASS_IDS`: the body the client must build for this car. */
  style: number;
  cls: number;
  /** The wreck section (deform + parts) rides with this frame. */
  wreck: boolean;
  readonly deform: DeformNetState;
  readonly parts: PartNetState;
}

export interface Snapshot {
  seq: number;
  /** Host clock (s). */
  time: number;
  keyframe: boolean;
  count: number;
  /** The host's arcade (0) ↔ realistic (1) slider, `HANDLING.realism` (1/255 steps). */
  realism: number;
  /** Index into `PHASES`, and the host's time scale (slow-mo), so the client HUD and FX follow it. */
  phase: number;
  timeScale: number;
  /** Grows to `count` (`ensureFrames`); entries past `count` are stale. */
  readonly cars: CarFrame[];
}

export function makeCarFrame(L: NetLayout): CarFrame {
  return {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    roll: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    wy: 0,
    crashed: false,
    vaporized: false,
    falling: false,
    style: 0,
    cls: 0,
    wreck: false,
    deform: {
      local: new Float32Array(L.masses * 3),
      skinPos: new Float32Array(L.masses * 3),
      skinXf: new Float32Array(L.clusters * 9),
      sensor: new Float32Array(L.sensors),
      impact: new Float32Array(9),
      popped: 0,
      skinPopped: 0,
      flags: 0,
      engineTravel: 0,
      killTravel: 0,
    },
    parts: {
      flags: new Uint8Array(L.parts),
      hinge: new Float32Array(L.parts * 3),
      pose: new Float32Array(L.parts * 7),
      lamps: 0,
      glass: 0,
      wheelLoose: 0,
      wheels: new Float32Array(L.wheels * 7),
    },
  };
}

export function makeSnapshot(): Snapshot {
  return { seq: 0, time: 0, keyframe: false, count: 0, realism: 0, phase: 0, timeScale: 1, cars: [] };
}

export function ensureFrames(s: Snapshot, n: number, L: NetLayout): void {
  while (s.cars.length < n) s.cars.push(makeCarFrame(L));
}

export class Writer {
  readonly bytes: Uint8Array<ArrayBuffer>;
  private readonly view: DataView;
  off = 0;

  constructor(size = 1 << 16) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
  }

  u8(v: number): void {
    this.view.setUint8(this.off, v);
    this.off += 1;
  }
  u16(v: number): void {
    this.view.setUint16(this.off, v, true);
    this.off += 2;
  }
  u32(v: number): void {
    this.view.setUint32(this.off, v >>> 0, true);
    this.off += 4;
  }
  f32(v: number): void {
    this.view.setFloat32(this.off, v, true);
    this.off += 4;
  }
  f64(v: number): void {
    this.view.setFloat64(this.off, v, true);
    this.off += 8;
  }
  /** `v` in steps of `step`, clamped to ±32767 steps. */
  q16(v: number, step: number): void {
    const n = Math.round(v / step);
    this.view.setInt16(this.off, n > 32767 ? 32767 : n < -32767 ? -32767 : n || 0, true);
    this.off += 2;
  }
  q16s(a: ArrayLike<number>, n: number, step: number): void {
    for (let i = 0; i < n; i++) this.q16(a[i]!, step);
  }
  /** The bytes written so far (a view: send or copy it before the next write). */
  done(): Uint8Array<ArrayBuffer> {
    return this.bytes.subarray(0, this.off);
  }
  /** UTF-8, at most 255 bytes (longer is cut), length first. */
  str(s: string): void {
    const b = new TextEncoder().encode(s).subarray(0, 255);
    this.u8(b.length);
    this.bytes.set(b, this.off);
    this.off += b.length;
  }
}

export class Reader {
  private view: DataView = new DataView(new ArrayBuffer(0));
  off = 0;

  reset(data: Uint8Array): this {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.off = 0;
    return this;
  }
  get length(): number {
    return this.view.byteLength;
  }
  u8(): number {
    return this.view.getUint8(this.off++);
  }
  u16(): number {
    const v = this.view.getUint16(this.off, true);
    this.off += 2;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.off, true);
    this.off += 4;
    return v;
  }
  f32(): number {
    const v = this.view.getFloat32(this.off, true);
    this.off += 4;
    return v;
  }
  /** An f32 that must be finite (positions, clocks): a host never sends NaN or ±Infinity. */
  fin32(): number {
    const v = this.f32();
    if (!Number.isFinite(v)) throw new RangeError("non-finite value");
    return v;
  }
  f64(): number {
    const v = this.view.getFloat64(this.off, true);
    this.off += 8;
    return v;
  }
  q16(step: number): number {
    const v = this.view.getInt16(this.off, true) * step;
    this.off += 2;
    return v;
  }
  q16s(out: Float32Array, n: number, step: number): void {
    for (let i = 0; i < n; i++) out[i] = this.q16(step);
  }
  str(): string {
    const n = this.u8();
    const s = new TextDecoder().decode(new Uint8Array(this.view.buffer, this.view.byteOffset + this.off, n));
    this.off += n;
    return s;
  }
}

/** Deform + parts of one car: what fixes its skin and hulls. */
export function writeWreck(w: Writer, f: CarFrame, L: NetLayout): void {
  const d = f.deform;
  w.q16s(d.local, L.masses * 3, Q.pos);
  w.q16s(d.skinPos, L.masses * 3, Q.pos);
  w.q16s(d.skinXf, L.clusters * 9, Q.xf);
  w.q16s(d.sensor, L.sensors, Q.fine);
  w.q16s(d.impact, 9, Q.fine);
  w.u32(d.popped);
  w.u32(d.skinPopped);
  w.u8(d.flags);
  w.q16(d.engineTravel, Q.pos);
  w.q16(d.killTravel, Q.pos);
  const p = f.parts;
  for (let i = 0; i < L.parts; i++) {
    const flags = p.flags[i]!;
    w.u8(flags);
    w.q16(p.hinge[i * 3]!, Q.fine);
    w.q16(p.hinge[i * 3 + 1]!, Q.fine);
    w.q16(p.hinge[i * 3 + 2]!, Q.fine);
    if ((flags & 1) === 0) continue;
    const o = i * 7;
    w.f32(p.pose[o]!);
    w.f32(p.pose[o + 1]!);
    w.f32(p.pose[o + 2]!);
    for (let k = 3; k < 7; k++) w.q16(p.pose[o + k]!, Q.quat);
  }
  w.u8(p.lamps);
  w.u16(p.glass);
  w.u8(p.wheelLoose);
  for (let i = 0; i < L.wheels; i++) {
    if (((p.wheelLoose >> i) & 1) === 0) continue;
    const o = i * 7;
    w.f32(p.wheels[o]!);
    w.f32(p.wheels[o + 1]!);
    w.f32(p.wheels[o + 2]!);
    for (let k = 3; k < 7; k++) w.q16(p.wheels[o + k]!, Q.quat);
  }
}

function readWreck(r: Reader, f: CarFrame, L: NetLayout): void {
  const d = f.deform;
  r.q16s(d.local, L.masses * 3, Q.pos);
  r.q16s(d.skinPos, L.masses * 3, Q.pos);
  r.q16s(d.skinXf, L.clusters * 9, Q.xf);
  r.q16s(d.sensor, L.sensors, Q.fine);
  r.q16s(d.impact, 9, Q.fine);
  d.popped = r.u32();
  d.skinPopped = r.u32();
  d.flags = r.u8();
  d.engineTravel = r.q16(Q.pos);
  d.killTravel = r.q16(Q.pos);
  const p = f.parts;
  for (let i = 0; i < L.parts; i++) {
    const flags = r.u8();
    p.flags[i] = flags;
    p.hinge[i * 3] = r.q16(Q.fine);
    p.hinge[i * 3 + 1] = r.q16(Q.fine);
    p.hinge[i * 3 + 2] = r.q16(Q.fine);
    if ((flags & 1) === 0) continue;
    const o = i * 7;
    p.pose[o] = r.fin32();
    p.pose[o + 1] = r.fin32();
    p.pose[o + 2] = r.fin32();
    for (let k = 3; k < 7; k++) p.pose[o + k] = r.q16(Q.quat);
  }
  p.lamps = r.u8();
  p.glass = r.u16();
  p.wheelLoose = r.u8();
  for (let i = 0; i < L.wheels; i++) {
    if (((p.wheelLoose >> i) & 1) === 0) continue;
    const o = i * 7;
    p.wheels[o] = r.fin32();
    p.wheels[o + 1] = r.fin32();
    p.wheels[o + 2] = r.fin32();
    for (let k = 3; k < 7; k++) p.wheels[o + k] = r.q16(Q.quat);
  }
}

export function writeSnapshot(w: Writer, s: Snapshot, L: NetLayout): void {
  w.u8(MSG.snapshot);
  w.u8(s.keyframe ? 1 : 0);
  w.u16(s.seq & 0xffff);
  w.f64(s.time);
  w.u8(s.count);
  w.u8(Math.round(Math.max(0, Math.min(1, s.realism)) * 255));
  w.u8(s.phase);
  w.u16(Math.round(Math.max(0, Math.min(6, s.timeScale)) * 10000));
  for (let i = 0; i < s.count; i++) {
    const f = s.cars[i]!;
    w.u8((f.crashed ? 1 : 0) | (f.wreck ? 2 : 0) | (f.vaporized ? 4 : 0) | (f.falling ? 8 : 0));
    w.u8((f.style & 15) | ((f.cls & 15) << 4));
    w.f32(f.x);
    w.f32(f.y);
    w.f32(f.z);
    w.q16(Math.atan2(Math.sin(f.yaw), Math.cos(f.yaw)), Q.fine);
    w.q16(f.pitch, Q.fine);
    w.q16(f.roll, Q.fine);
    w.q16(f.vx, Q.vel);
    w.q16(f.vy, Q.vel);
    w.q16(f.vz, Q.vel);
    w.q16(f.wy, Q.rate);
    if (f.wreck) writeWreck(w, f, L);
  }
}

/** Reads a whole snapshot message (type byte included) into `s`, growing its frames as needed. */
export function readSnapshot(r: Reader, s: Snapshot, L: NetLayout): void {
  r.u8();
  s.keyframe = (r.u8() & 1) !== 0;
  s.seq = r.u16();
  s.time = r.f64();
  s.count = r.u8();
  if (!Number.isFinite(s.time)) throw new RangeError("non-finite host time");
  if (s.count < 1 || s.count > MAX_NET_CARS) throw new RangeError(`snapshot of ${s.count} cars`);
  s.realism = r.u8() / 255;
  s.phase = r.u8();
  s.timeScale = r.u16() / 10000;
  ensureFrames(s, s.count, L);
  for (let i = 0; i < s.count; i++) {
    const f = s.cars[i]!;
    const flags = r.u8();
    f.crashed = (flags & 1) !== 0;
    f.wreck = (flags & 2) !== 0;
    f.vaporized = (flags & 4) !== 0;
    f.falling = (flags & 8) !== 0;
    const body = r.u8();
    f.style = body & 15;
    f.cls = body >> 4;
    f.x = r.fin32();
    f.y = r.fin32();
    f.z = r.fin32();
    f.yaw = r.q16(Q.fine);
    f.pitch = r.q16(Q.fine);
    f.roll = r.q16(Q.fine);
    f.vx = r.q16(Q.vel);
    f.vy = r.q16(Q.vel);
    f.vz = r.q16(Q.vel);
    f.wy = r.q16(Q.rate);
    if (f.wreck) readWreck(r, f, L);
  }
}

/** Client → host: this peer's shaped drive input, and whether it asks for a race respawn (5 bytes). */
export function writeInput(w: Writer, input: DriveInput, respawn = false): void {
  w.u8(MSG.input);
  w.u8(Math.round(Math.max(-1, Math.min(1, input.throttle)) * 127) & 0xff);
  w.u8(Math.round(Math.max(-1, Math.min(1, input.steer)) * 127) & 0xff);
  w.u8(Math.round(Math.max(0, Math.min(1, input.brake)) * 255));
  w.u8((input.ebrake ? 1 : 0) | (input.boost ? 2 : 0) | (respawn ? 4 : 0));
}

/** Reads a client's input into `out`; returns its respawn request. */
export function readInput(r: Reader, out: DriveInput): boolean {
  r.u8();
  out.throttle = ((r.u8() << 24) >> 24) / 127;
  out.steer = ((r.u8() << 24) >> 24) / 127;
  out.brake = r.u8() / 255;
  const bits = r.u8();
  out.ebrake = (bits & 1) !== 0;
  out.boost = (bits & 2) !== 0;
  return (bits & 4) !== 0;
}

/**
 * A derby match as clients render it (`DerbyMatch`'s public state, from the host): the board, the
 * clock and the result, plus which cars network peers drive in this match and the bowl radius.
 */
export interface DerbyNetState {
  /** Bumped per match the host begins; a new round re-seats a client (or makes it spectate). */
  round: number;
  /** A match is running or decided; false in a public lobby (cars parked, no rules). */
  active: boolean;
  /** Match time and winner hold (s). */
  time: number;
  hold: number;
  /** Bowl radius (m), `derbyRadius` of the match's field. */
  radius: number;
  winnerId: number | null;
  winnerName: string | null;
  decided: DerbyDecided | null;
  /** Seconds until a public derby starts, null outside a lobby. */
  lobby: number | null;
  /** Bit i: car i is a network peer's in this match. */
  seats: number;
  board: DerbyBoardRow[];
}

const DECIDED: readonly (DerbyDecided | null)[] = [null, "wreck", "countout", "time"];

export function writeDerby(w: Writer, s: DerbyNetState): void {
  w.u8(MSG.derby);
  w.u8((s.active ? 1 : 0) | (s.winnerId != null ? 2 : 0) | (s.lobby != null ? 4 : 0));
  w.u16(s.round & 0xffff);
  w.f32(s.time);
  w.f32(s.hold);
  w.f32(s.radius);
  w.u32(s.seats);
  w.u8(DECIDED.indexOf(s.decided));
  if (s.winnerId != null) {
    w.u8(s.winnerId);
    w.str(s.winnerName ?? "");
  }
  if (s.lobby != null) w.f32(s.lobby);
  w.u8(s.board.length);
  for (const r of s.board) {
    w.u8(r.id);
    w.str(r.name);
    w.u16(Math.max(0, Math.min(0xffff, r.score)));
    w.u8(Math.min(255, r.hits));
    w.u8(Math.min(255, r.disables));
    w.u8((r.alive ? 1 : 0) | (r.out ? 2 : 0));
    w.u16(Math.round(Math.max(0, Math.min(6553.5, r.clock)) * 10));
  }
}

/** Reads a whole derby message (type byte included). */
export function readDerby(r: Reader): DerbyNetState {
  r.u8();
  const flags = r.u8();
  const round = r.u16();
  const time = r.fin32();
  const hold = r.fin32();
  const radius = r.fin32();
  const seats = r.u32();
  const decided = DECIDED[r.u8()] ?? null;
  let winnerId: number | null = null;
  let winnerName: string | null = null;
  if (flags & 2) {
    winnerId = r.u8();
    if (winnerId >= MAX_NET_CARS) throw new RangeError(`derby winner ${winnerId}`);
    winnerName = r.str();
  }
  const lobby = flags & 4 ? r.fin32() : null;
  const board: DerbyBoardRow[] = [];
  const n = r.u8();
  if (n > MAX_NET_CARS) throw new RangeError(`derby board of ${n}`);
  for (let k = 0; k < n; k++) {
    const id = r.u8();
    const name = r.str();
    const score = r.u16();
    const hits = r.u8();
    const disables = r.u8();
    const bits = r.u8();
    board.push({ id, name, score, hits, disables, alive: (bits & 1) !== 0, out: (bits & 2) !== 0, clock: r.u16() / 10 });
  }
  return { round, active: (flags & 1) !== 0, time, hold, radius, winnerId, winnerName, decided, lobby, seats, board };
}

/** `MSG.race`: the host's rules state (null between races), its public lobby countdown and course. */
export interface RaceNetState {
  lobby: number | null;
  trackId: string;
  snap: RaceSnapshot | null;
}

const RACE_MSG = z.object({ lobby: z.number().nullable(), trackId: z.string().max(64), snap: z.unknown() });

/**
 * The parts of a `RaceSnapshot` that size what `RaceSession.restore` builds: a lap count far above any
 * race the host can set up (engine-race clamps to 9) and at most a full field. The rest is applied as is.
 */
const RACE_SNAP = z.looseObject({
  laps: z.number().int().min(1).max(99),
  time: z.number().finite(),
  cars: z.array(z.looseObject({ id: z.number().int().min(0).max(MAX_NET_CARS - 1) })).max(MAX_NET_CARS),
  order: z.array(z.number().int()).max(MAX_NET_CARS),
  firstAt: z.array(z.number().nullable()).max(100 * 256),
});

/** A whole race message: the type byte, then the state as UTF-8 JSON. */
export function writeRace(s: RaceNetState): Uint8Array<ArrayBuffer> {
  const body = new TextEncoder().encode(JSON.stringify(s));
  const msg = new Uint8Array(body.length + 1);
  msg[0] = MSG.race;
  msg.set(body, 1);
  return msg;
}

/** Reads a whole race message; null when it is not JSON in that shape or its race is out of bounds. */
export function readRace(data: Uint8Array): RaceNetState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(data.subarray(1)));
  } catch {
    return null;
  }
  const m = RACE_MSG.safeParse(raw);
  if (!m.success) return null;
  if (m.data.snap == null) return { lobby: m.data.lobby, trackId: m.data.trackId, snap: null };
  const snap = RACE_SNAP.safeParse(m.data.snap);
  // A peer's JSON in the host's `RaceSnapshot` shape: what sizes the session is checked above, the rest is taken as is.
  return snap.success ? { lobby: m.data.lobby, trackId: m.data.trackId, snap: snap.data as RaceSnapshot } : null;
}
