import { blankPoint, blankProjection, pointOn, type Track, type TrackPath } from "../world/track.ts";
import type { RaceSession } from "./session.ts";
import type { CarPose, Entrant, RaceEvent } from "./types.ts";

/** The rules' step in these tests (s). */
export const DT = 1 / 60;

export function field(n: number): Entrant[] {
  return Array.from({ length: n }, (_, i) => ({ id: i, name: `Car ${i}`, kind: i === 0 ? "player" : "ai", aggression: 0 }));
}

export type Pt = { x: number; z: number };
export type Pose = Pt & { vx: number; vz: number; alive?: boolean };
/** Where a car is at race time `t` (end of the step). */
export type Driver = (t: number) => Pose;

const _pt = blankPoint();

/** Along the centreline (offset `lat`, + = left) from arc length `s0` at `v` m/s once the lights are green. */
export function along(track: Track, s0: number, v: number, lat = 0): Driver {
  return (t) => {
    const p = track.pointAt(s0 + v * Math.max(0, t), _pt);
    return { x: p.x + p.tz * lat, z: p.z - p.tx * lat, vx: p.tx * v, vz: p.tz * v };
  };
}

/** Start from grid slot `i` (behind the line). */
export function fromGrid(track: Track, i: number, v: number): Driver {
  const slot = track.gridSlot(i);
  const p = blankProjection();
  track.project(slot.x, slot.z, -1, p);
  return along(track, p.s, v, p.lateral);
}

/** Constant speed along a polyline from green; parked at its end. */
export function polyline(pts: Pt[], v: number): Driver {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.z - pts[i - 1]!.z));
  return (t) => {
    const d = Math.min(cum[cum.length - 1]!, v * Math.max(0, t));
    let k = 1;
    while (k < cum.length - 1 && cum[k]! < d) k++;
    const a = pts[k - 1]!;
    const b = pts[k]!;
    const seg = cum[k]! - cum[k - 1]! || 1;
    const f = (d - cum[k - 1]!) / seg;
    return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, vx: ((b.x - a.x) / seg) * v, vz: ((b.z - a.z) / seg) * v };
  };
}

/** The points `at(s)` returns for `s` from `from` to `to` every `step`. */
export function samples(at: (s: number) => Pt, from: number, to: number, step = 2): Pt[] {
  const out: Pt[] = [];
  for (let s = from; s <= to; s += step) out.push(at(s));
  return out;
}

/** The main road's centreline from arc length `from` to `to` every `step` m, as points. */
export function centreline(track: Track, from: number, to: number, step = 2): Pt[] {
  return samples((s) => {
    const p = track.pointAt(s, _pt);
    return { x: p.x, z: p.z };
  }, from, to, step);
}

/** A shortcut's centreline from path arc length `from` to `to` every `step` m, as points. */
export function shortcutLine(path: TrackPath, from: number, to: number, step = 2): Pt[] {
  return samples((s) => {
    const p = pointOn(path, s, _pt);
    return { x: p.x, z: p.z };
  }, from, to, step);
}

/** Step until race time `to` (or the race ends / `until` holds); returns every event. */
export function runTo(s: RaceSession, drivers: Driver[], to: number, until?: (s: RaceSession) => boolean): RaceEvent[] {
  const poses: CarPose[] = drivers.map(() => ({ x: 0, z: 0, yaw: 0, vx: 0, vz: 0, alive: true }));
  const events: RaceEvent[] = [];
  while (s.time < to - 1e-9 && s.phase !== "finished") {
    const t = s.time + DT;
    drivers.forEach((d, i) => {
      const p = d(t);
      const pose = poses[i]!;
      pose.x = p.x;
      pose.z = p.z;
      pose.vx = p.vx;
      pose.vz = p.vz;
      pose.yaw = Math.atan2(p.vx, p.vz);
      pose.alive = p.alive ?? true;
    });
    s.step(DT, poses);
    events.push(...s.events());
    if (until?.(s)) break;
  }
  return events;
}

/** Where `(x, z)` projects on the main road: arc length and signed lateral offset. */
export function onRoad(track: Track, x: number, z: number): { s: number; lateral: number } {
  const p = track.project(x, z, -1, blankProjection());
  return { s: p.s, lateral: p.lateral };
}
