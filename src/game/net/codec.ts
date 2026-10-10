import { z } from "zod";
import type { DriveInput } from "../vehicle/car-drive.ts";
import { EXIT_PANES, type PartNetState } from "../vehicle/car-core.ts";
import type { DerbyBoardRow, DerbyDecided } from "../match/derby.ts";
import type { RaceSnapshot } from "../match/types.ts";
import type { DeformNetState } from "../deform/streamed-deform.ts";
import type { Ejection } from "../vehicle/ejection.ts";
import { detSin, detCos } from "../kernel/physics-core.js";

/**
 * Binary netplay messages (docs/MULTIPLAYER.md). Little-endian, quantized to i16 steps that keep
 * every mesh and hull point well inside 1 mm of the host's.
 */
/**
 * `race`: the host's race state as UTF-8 JSON after the type byte (`NetPlay.sendRace`); `derby`: `writeDerby`;
 * `hold`: a hidden host's heartbeat (its tab cannot render, so nothing else comes); `hello`: type,
 * `NET_VERSION`, the player's name (`Writer.str`; the host cleans it, `cleanName`); `reel`: the end-of-race
 * highlight reel (`reel-codec.ts`; the message itself is `MSG.reel`, but on the wire it travels as `reelPart` frames,
 * `reel-wire.ts`), sent once, reliably; `eject`: a driver was thrown out (`writeEject`), reliably; `look`: a player's car and
 * driver look with their spray paint (`look-codec.ts`), once per player, reliably; `roster`: the host's peer-to-car table for
 * proximity voice (`roster-codec.ts`), to every guest, reliably, when a seat changes and with every keyframe.
 */
export const MSG = { snapshot: 1, input: 2, hello: 3, assign: 4, race: 5, derby: 6, hold: 7, reel: 8, eject: 9, reelPart: 10, look: 11, roster: 12 } as const;

/**
 * Wire format version, carried by hello and assign: peers on different builds (an auto-deploy mid-session)
 * refuse each other instead of misreading snapshots. Bump on any change to a message layout.
 * 3: hello carries the player's name.
 * 4: 9 part slots per car (the police light bar; was 8), the "police" body style and class indices.
 * 5: `MSG.reel`, the highlight reel.
 * 6: 15 part slots per car (six body panels, quarters and arch flares; was 9).
 `MSG.race` carries the race's driver-look seed (`look`); a reel clip carries it too.
 a snapshot car's flags byte carries `driverOut` (bits 5-6), and `MSG.eject`; a reel clip carries its ejections.
 the keyframe's `simState` carries each face's load crush depth and baked depth (9); a load-crushed car rides the wreck section (`crashed`).
 10: `MSG.reelPart`: the reel travels in frames under the relay's message cap, so no clip drops for size.
 11: a reel clip carries the world's step schedule, each keyframe the course's wall memory and knocked props, and the
 keyframe's `simState` drops two doubles (the wreck's fitted yaw rate).
 12: a reel clip carries per-key car masks and a knocks list (no fine block), and a keyframe's car section carries its
 parts state, cage corners and sensor positions.
 13: a reel clip carries the count of cars its cluster hit (`hit`, a byte after `ejects`).
 14: `MSG.input` flags gain bit 8 (hold reset) and a race snapshot's car record carries its safe reset spot (`safe`).
 15: a reel clip carries `hitKph` and `deform` (f32), a hits list (t f64, x/y/z f32, cars a/b u8) and an `own` byte per
ejection.
16: a snapshot car carries its boost meter (a byte after the body byte: 0-254, 255 for a car with no nitrous), and `MSG.input`
carries the peer's own meter (a sixth byte), so every browser shows any viewed car's bottle as its driver keeps it.
17: a reel keyframe's course memory is 1 double, not 4 (race walls are solid colliders).
18: MSG.look (11) carries a player's car and driver colour picks and their two spray bitmaps, sent once at seating.
19: Stage 1 of the one-motion-path physics: a reel's keyframes and a snapshot's cars carry the trajectories of the one rigid step (derived rest and wreck contact; debris poses on one ground law), so peers on 18 would replay and mirror them differently.
20: Stage 2 of the one-motion-path physics: a loose part's world pose is no longer on the wire (torn parts are rigid bodies each player's own world steps, `stepLoose`), a snapshot's parts are their flags and hinge values alone, so peers on 19 would read a different layout.
21: `MSG.roster` (12): the host's table of which peer drives which car, so voice finds each peer's range; peers on 20 would drop it.
*/
export const NET_VERSION = 21;

/** Most cars a snapshot or derby board may carry (the engine's `MAX_CARS`). */
export const MAX_NET_CARS = 32;

/**
 * Quantization, in steps per unit. Integers on purpose: the writer's array methods take these, and a
 * Smi argument is never boxed (see `Writer.q16s`).
 */
export const Q_PER = {
  /** Body-frame particle positions (m). */
  pos: 2000,
  /** Cluster skin maps (unitless 3×3). */
  xf: 8192,
  /** Euler angles (rad), sensor compression (m), impact entries, hinge values. */
  fine: 10000,
  /** Velocity (m/s). */
  vel: 100,
  /** Yaw rate (rad/s). */
  rate: 1000,
  /** Quaternion components. */
  quat: 32767,
} as const;

/** Quantization steps, `1 / Q_PER` (the same doubles as the literals 1/2000, 1e-4, 0.01 …). */
export const Q = {
  pos: 1 / Q_PER.pos,
  xf: 1 / Q_PER.xf,
  fine: 1 / Q_PER.fine,
  vel: 1 / Q_PER.vel,
  rate: 1 / Q_PER.rate,
  quat: 1 / Q_PER.quat,
} as const;

/** Numbers in a car's deform `impact` block (`DeformNetState.impact`): the hit, the wrinkle, buckle, squash and the roof's imprint. */
const IMPACT = 12;

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
  /** Police sirens flashing (race police chase). */
  sirens: boolean;
  /** `EXIT_PANES` index of the pane the driver was thrown out through, 0 while he is at the wheel (`DeformableCar.driverOut`). */
  driverOut: number;
  /** Index into `CAR_STYLE_IDS` / `VEHICLE_CLASS_IDS`: the body the client must build for this car. */
  style: number;
  cls: number;
  /** Its driver's boost meter (0-1), as the host knows it; -1 for a car with no nitrous (police, traffic, nobody driving). */
  meter: number;
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
  /**
   * How many times the host has cleared its scene (`CrashEngine.clearScene`: a scene change, loop, reset, race start), mod 128.
   * It rides in the keyframe byte's spare bits (an older host sends 0, an older client ignores them), so the layout and
   * `NET_VERSION` stay. A client that draws a snapshot whose count differs from the last one drawn clears its own scene.
   */
  clearGen: number;
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
    sirens: false,
    driverOut: 0,
    style: 0,
    cls: 0,
    meter: -1,
    wreck: false,
    deform: {
      local: new Float32Array(L.masses * 3),
      skinPos: new Float32Array(L.masses * 3),
      skinXf: new Float32Array(L.clusters * 9),
      sensor: new Float32Array(L.sensors),
      impact: new Float32Array(IMPACT),
      popped: 0,
      skinPopped: 0,
      flags: 0,
      engineTravel: 0,
      killTravel: 0,
    },
    parts: {
      flags: new Uint8Array(L.parts),
      hinge: new Float32Array(L.parts * 3),
      lamps: 0,
      glass: 0,
      wheelLoose: 0,
      wheels: new Float32Array(L.wheels * 7),
    },
  };
}

export function makeSnapshot(): Snapshot {
  return { seq: 0, time: 0, keyframe: false, clearGen: 0, count: 0, realism: 0, phase: 0, timeScale: 1, cars: [] };
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
  /** `f32` over `a[from .. from + n)`. */
  f32s(a: ArrayLike<number>, n: number, from = 0): void {
    for (let i = from; i < from + n; i++) {
      this.view.setFloat32(this.off, a[i]!, true);
      this.off += 4;
    }
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
  /**
   * `q16(a[i], 1 / per)` over `a[from .. from + n)`, its arithmetic inlined. The codec hands the writer
   * doubles only this way (and `f32s`): `writeSnapshot` runs cold (2 Hz highlight keyframes) in Maglev,
   * which does not inline these calls, so a double argument (a value, or a `Q` step: a double field) was
   * boxed in a HeapNumber per call, ~1.6 KB per 32-car snapshot with 11 wrecks. `per` is a Smi.
   */
  q16s(a: ArrayLike<number>, n: number, per: number, from = 0): void {
    const step = 1 / per;
    for (let i = from; i < from + n; i++) {
      const v = Math.round(a[i]! / step);
      this.view.setInt16(this.off, v > 32767 ? 32767 : v < -32767 ? -32767 : v || 0, true);
      this.off += 2;
    }
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

/** Most bytes `writeSnapshot` writes for `n` cars: each with a wreck section, every part (a flag byte and 3 hinge values of 2 bytes: 7) and wheel (20) loose. */
export function snapshotMaxBytes(n: number, L: NetLayout): number {
  const wreck = L.masses * 12 + L.clusters * 18 + L.sensors * 2 + IMPACT * 2 + 13 + L.parts * 7 + 4 + L.wheels * 20;
  return 17 + n * (29 + wreck);
}

/** A car's doubles staged for `f32s`/`q16s` (see `Writer.q16s`). */
const STAGE = new Float64Array(10);

/** Deform + parts of one car: what fixes its skin and hulls. */
export function writeWreck(w: Writer, f: CarFrame, L: NetLayout): void {
  const d = f.deform;
  w.q16s(d.local, L.masses * 3, Q_PER.pos);
  w.q16s(d.skinPos, L.masses * 3, Q_PER.pos);
  w.q16s(d.skinXf, L.clusters * 9, Q_PER.xf);
  w.q16s(d.sensor, L.sensors, Q_PER.fine);
  w.q16s(d.impact, IMPACT, Q_PER.fine);
  w.u32(d.popped);
  w.u32(d.skinPopped);
  w.u8(d.flags);
  STAGE[0] = d.engineTravel;
  STAGE[1] = d.killTravel;
  w.q16s(STAGE, 2, Q_PER.pos);
  const p = f.parts;
  for (let i = 0; i < L.parts; i++) {
    const flags = p.flags[i]!;
    w.u8(flags);
    w.q16s(p.hinge, 3, Q_PER.fine, i * 3);
  }
  w.u8(p.lamps);
  w.u16(p.glass);
  w.u8(p.wheelLoose);
  for (let i = 0; i < L.wheels; i++) {
    if (((p.wheelLoose >> i) & 1) === 0) continue;
    const o = i * 7;
    w.f32s(p.wheels, 3, o);
    w.q16s(p.wheels, 4, Q_PER.quat, o + 3);
  }
}

function readWreck(r: Reader, f: CarFrame, L: NetLayout): void {
  const d = f.deform;
  r.q16s(d.local, L.masses * 3, Q.pos);
  r.q16s(d.skinPos, L.masses * 3, Q.pos);
  r.q16s(d.skinXf, L.clusters * 9, Q.xf);
  r.q16s(d.sensor, L.sensors, Q.fine);
  r.q16s(d.impact, IMPACT, Q.fine);
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
  w.u8((s.keyframe ? 1 : 0) | ((s.clearGen & 127) << 1));
  w.u16(s.seq & 0xffff);
  w.f64(s.time);
  w.u8(s.count);
  w.u8(Math.round(Math.max(0, Math.min(1, s.realism)) * 255));
  w.u8(s.phase);
  w.u16(Math.round(Math.max(0, Math.min(6, s.timeScale)) * 10000));
  for (let i = 0; i < s.count; i++) {
    const f = s.cars[i]!;
    w.u8((f.crashed ? 1 : 0) | (f.wreck ? 2 : 0) | (f.vaporized ? 4 : 0) | (f.falling ? 8 : 0) | (f.sirens ? 16 : 0) | ((f.driverOut & 3) << 5));
    w.u8((f.style & 15) | ((f.cls & 15) << 4));
    w.u8(f.meter < 0 ? METER_NONE : Math.round(Math.min(1, f.meter) * METER_FULL));
    const p = STAGE;
    p[0] = f.x;
    p[1] = f.y;
    p[2] = f.z;
    p[3] = Math.atan2(detSin(f.yaw), detCos(f.yaw));
    p[4] = f.pitch;
    p[5] = f.roll;
    p[6] = f.vx;
    p[7] = f.vy;
    p[8] = f.vz;
    p[9] = f.wy;
    w.f32s(p, 3);
    w.q16s(p, 3, Q_PER.fine, 3);
    w.q16s(p, 3, Q_PER.vel, 6);
    w.q16s(p, 1, Q_PER.rate, 9);
    if (f.wreck) writeWreck(w, f, L);
  }
}

/** Reads a whole snapshot message (type byte included) into `s`, growing its frames as needed. */
export function readSnapshot(r: Reader, s: Snapshot, L: NetLayout): void {
  r.u8();
  const head = r.u8();
  s.keyframe = (head & 1) !== 0;
  s.clearGen = head >> 1;
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
    f.sirens = (flags & 16) !== 0;
    f.driverOut = (flags >> 5) & 3;
    const body = r.u8();
    f.style = body & 15;
    f.cls = body >> 4;
    const meter = r.u8();
    f.meter = meter === METER_NONE ? -1 : meter / METER_FULL;
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

/** What a client's input packet asks of the host's race rules besides driving: a tap's respawn, a hold's reset with the damage kept. */
export const INPUT_RESPAWN = 1;
export const INPUT_HOLD = 2;

/** A boost meter on the wire: 0..`METER_FULL` is empty to full, `METER_NONE` a car with no nitrous. */
const METER_FULL = 254;
const METER_NONE = 255;
/** Client → host: this peer's shaped drive input, what it asks of the race rules (`INPUT_RESPAWN` | `INPUT_HOLD`), and its own boost meter (0-1) (6 bytes). */
export function writeInput(w: Writer, input: DriveInput, ask = 0, meter = 0): void {
  w.u8(MSG.input);
  w.u8(Math.round(Math.max(-1, Math.min(1, input.throttle)) * 127) & 0xff);
  w.u8(Math.round(Math.max(-1, Math.min(1, input.steer)) * 127) & 0xff);
  w.u8(Math.round(Math.max(0, Math.min(1, input.brake)) * 255));
  w.u8((input.ebrake ? 1 : 0) | (input.boost ? 2 : 0) | ((ask & INPUT_RESPAWN) !== 0 ? 4 : 0) | ((ask & INPUT_HOLD) !== 0 ? 8 : 0));
  w.u8(Math.round(Math.max(0, Math.min(1, meter)) * METER_FULL));
}

/** A thrown driver as `launch` made him: car, pane and driver, then 22 f32 (position, car-local position, direction, orientation, relative and car velocity, spin). */
export function writeEjection(w: Writer, e: Ejection): void {
  w.u8(e.car);
  w.u8(EXIT_PANES.indexOf(e.exit) | (e.cop ? 4 : 0));
  w.f32s([e.pos.x, e.pos.y, e.pos.z, e.local.x, e.local.y, e.local.z, e.dir.x, e.dir.y, e.dir.z], 9);
  w.f32s([e.quat.x, e.quat.y, e.quat.z, e.quat.w], 4);
  w.f32s([e.rel.x, e.rel.y, e.rel.z, e.carVel.x, e.carVel.y, e.carVel.z, e.spin.x, e.spin.y, e.spin.z], 9);
}

/** Reads `writeEjection`'s bytes into `e`; a car, pane or number no host sends is a RangeError. */
export function readEjection(r: Reader, e: Ejection): void {
  e.car = r.u8();
  const bits = r.u8();
  const exit = EXIT_PANES[bits & 3];
  if (e.car >= MAX_NET_CARS || !exit) throw new RangeError("ejection of no car or pane");
  e.exit = exit;
  e.cop = (bits & 4) !== 0;
  e.pos.set(r.fin32(), r.fin32(), r.fin32());
  e.local.set(r.fin32(), r.fin32(), r.fin32());
  e.dir.set(r.fin32(), r.fin32(), r.fin32());
  e.quat.set(r.fin32(), r.fin32(), r.fin32(), r.fin32());
  e.rel.set(r.fin32(), r.fin32(), r.fin32());
  e.carVel.set(r.fin32(), r.fin32(), r.fin32());
  e.spin.set(r.fin32(), r.fin32(), r.fin32());
}

/** Host → clients: a driver was thrown out at host clock `time` (s), the clock snapshots carry; the clients launch the dummy when their draw time reaches it. */
export function writeEject(w: Writer, e: Ejection, time: number): void {
  w.u8(MSG.eject);
  w.f64(time);
  writeEjection(w, e);
}

/** `writeEject`'s message in a buffer of its own (type, host clock f64, `writeEjection`'s 2 + 22 × 4 bytes): one per throw, a handful a race. */
export function packEject(e: Ejection, time: number): Uint8Array<ArrayBuffer> {
  const w = new Writer(1 + 8 + 2 + 22 * 4);
  writeEject(w, e, time);
  return w.done();
}

/** Reads `writeEject`'s message into `e`; returns its host clock. */
export function readEject(r: Reader, e: Ejection): number {
  r.u8();
  const time = r.f64();
  if (!Number.isFinite(time)) throw new RangeError("non-finite host time");
  readEjection(r, e);
  return time;
}

/** Reads a client's input packet into `out`: returns what it asks (`INPUT_RESPAWN` | `INPUT_HOLD`); its meter goes to `meterOut[0]`. */
export function readInput(r: Reader, out: DriveInput, meterOut: Float64Array): number {
  r.u8();
  out.throttle = ((r.u8() << 24) >> 24) / 127;
  out.steer = ((r.u8() << 24) >> 24) / 127;
  out.brake = r.u8() / 255;
  const bits = r.u8();
  out.ebrake = (bits & 1) !== 0;
  out.boost = (bits & 2) !== 0;
  meterOut[0] = r.u8() / METER_FULL;
  return ((bits & 4) !== 0 ? INPUT_RESPAWN : 0) | ((bits & 8) !== 0 ? INPUT_HOLD : 0);
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

/** `MSG.race`: the host's rules state (null between races), its public lobby countdown and course, and the field's driver-look seed (`driverLook`). */
export interface RaceNetState {
  lobby: number | null;
  trackId: string;
  look: number;
  snap: RaceSnapshot | null;
}

const RACE_MSG = z.object({ lobby: z.number().nullable(), trackId: z.string().max(64), look: z.number().int().min(0).max(0xffffffff), snap: z.unknown() });

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
  if (m.data.snap == null) return { lobby: m.data.lobby, trackId: m.data.trackId, look: m.data.look, snap: null };
  const snap = RACE_SNAP.safeParse(m.data.snap);
  // A peer's JSON in the host's `RaceSnapshot` shape: what sizes the session is checked above, the rest is taken as is.
  return snap.success ? { lobby: m.data.lobby, trackId: m.data.trackId, look: m.data.look, snap: snap.data as RaceSnapshot } : null;
}
