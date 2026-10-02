import type { DriveInput } from "../car-drive.ts";
import type { PartNetState } from "../car.ts";
import type { DeformNetState } from "../streamed-deform.ts";

/**
 * Binary netplay messages (docs/MULTIPLAYER.md). Little-endian, quantized to i16 steps that keep
 * every mesh and hull point well inside 1 mm of the host's.
 */
export const MSG = { snapshot: 1, input: 2, hello: 3, assign: 4 } as const;

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
    parts: { flags: new Uint8Array(L.parts), hinge: new Float32Array(L.parts * 3), pose: new Float32Array(L.parts * 7), lamps: 0, glass: 0 },
  };
}

export function makeSnapshot(): Snapshot {
  return { seq: 0, time: 0, keyframe: false, count: 0, realism: 0, cars: [] };
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
    p.pose[o] = r.f32();
    p.pose[o + 1] = r.f32();
    p.pose[o + 2] = r.f32();
    for (let k = 3; k < 7; k++) p.pose[o + k] = r.q16(Q.quat);
  }
  p.lamps = r.u8();
  p.glass = r.u16();
}

export function writeSnapshot(w: Writer, s: Snapshot, L: NetLayout): void {
  w.u8(MSG.snapshot);
  w.u8(s.keyframe ? 1 : 0);
  w.u16(s.seq & 0xffff);
  w.f64(s.time);
  w.u8(s.count);
  w.u8(Math.round(Math.max(0, Math.min(1, s.realism)) * 255));
  for (let i = 0; i < s.count; i++) {
    const f = s.cars[i]!;
    w.u8((f.crashed ? 1 : 0) | (f.wreck ? 2 : 0));
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
  s.realism = r.u8() / 255;
  ensureFrames(s, s.count, L);
  for (let i = 0; i < s.count; i++) {
    const f = s.cars[i]!;
    const flags = r.u8();
    f.crashed = (flags & 1) !== 0;
    f.wreck = (flags & 2) !== 0;
    const body = r.u8();
    f.style = body & 15;
    f.cls = body >> 4;
    f.x = r.f32();
    f.y = r.f32();
    f.z = r.f32();
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

/** Client → host: this peer's shaped drive input (5 bytes). */
export function writeInput(w: Writer, input: DriveInput): void {
  w.u8(MSG.input);
  w.u8(Math.round(Math.max(-1, Math.min(1, input.throttle)) * 127) & 0xff);
  w.u8(Math.round(Math.max(-1, Math.min(1, input.steer)) * 127) & 0xff);
  w.u8(Math.round(Math.max(0, Math.min(1, input.brake)) * 255));
  w.u8((input.ebrake ? 1 : 0) | (input.boost ? 2 : 0));
}

export function readInput(r: Reader, out: DriveInput): void {
  r.u8();
  out.throttle = ((r.u8() << 24) >> 24) / 127;
  out.steer = ((r.u8() << 24) >> 24) / 127;
  out.brake = r.u8() / 255;
  const bits = r.u8();
  out.ebrake = (bits & 1) !== 0;
  out.boost = (bits & 2) !== 0;
}
