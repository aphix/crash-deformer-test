import { DRIVE, idleDrive, type DriveInput } from "../car-drive.ts";
import type { AiCar } from "../derby-ai.ts";
import { MAX_CARS } from "../fleet.ts";
import { steerGrip } from "./race-ai.ts";
import { SURFACE_IDS, SURFACES } from "./catalog.ts";
import { blankPoint, blankProjection, pointOn, projectPath, type Track, type TrackPath } from "./track.ts";
import { clamp, wrapPi } from "../scalar.ts";

/** Look this far (m) ahead in the lane for anything in the way. */
const LOOK = 18;
/** Half lane (m): a car this close sideways is in our lane. */
const LANE_HALF = 2.1;
/** Gap (m) traffic keeps to whatever is stopped ahead. */
const STOP_GAP = 7;
/** Seconds stopped behind a blocker before edging round it toward the road centre. */
const WAIT = 2.5;
/** Seconds spent edging round once started (long enough to clear a car at walking pace). */
const EDGE_TIME = 4.5;
/** Grid zone (m) behind and ahead of the line kept clear of loop traffic at the start (16 cars reach back ~66 m). */
const GRID_CLEAR = 80;
/** Observer bubble (m): traffic farther than `DORMANT` from every observer is put away; it comes back between `SPAWN_NEAR` and `SPAWN_FAR`. */
export const DORMANT = 120;
export const SPAWN_NEAR = 55;
export const SPAWN_FAR = 100;
/** A woken car keeps this far (m) from every other car. */
const SPAWN_CLEAR = 14;
/** An open street's car this close (m) to its end is done and put away. */
const END_MARGIN = 6;

type TrafficSpawn = { x: number; y: number; z: number; yaw: number };

/** One traffic car's lane: the path it drives, its lateral offset and direction. */
type TrafficSlot = { path: TrackPath; offset: number; dir: 1 | -1 };

/**
 * NPC world traffic. Cars `firstId…` drive, in order, the course's race-loop lanes
 * (`traffic.count`, lanes round-robin) and then each side street (`traffic.routes`: its `count`
 * cars, its lanes round-robin). Each cruises its lane (offset from the path's centreline, + = left
 * of the path direction; `dir` −1 drives against it), slows for turns, brakes for anything in its
 * lane ahead (racers, wrecks, other traffic) and, after waiting behind a stopped obstacle, edges
 * round it. Cross streets meet the race loop at grade, so racers get cross traffic at junctions.
 * The host keeps traffic in a bubble round the observers (`dormantFar`, `spawnPoint`).
 * Deterministic; no allocation per call.
 */
export class TrafficBrain {
  readonly track: Track;
  readonly firstId: number;
  readonly speed: number;
  readonly slots: TrafficSlot[];
  private readonly out: DriveInput = idleDrive();
  private readonly seg = new Int32Array(MAX_CARS);
  private readonly waited = new Float64Array(MAX_CARS);
  private readonly edge = new Float64Array(MAX_CARS);
  /** Next arc length to try when waking each car (scans on so wakes spread out). */
  private readonly scan = new Float64Array(MAX_CARS);
  private readonly proj = blankProjection();
  private readonly pt = blankPoint();

  constructor(track: Track, firstId: number) {
    const t = track.json.traffic;
    if (!t) throw new Error(`${track.id} has no traffic`);
    this.track = track;
    this.firstId = firstId;
    this.speed = t.speed;
    this.slots = [];
    for (let k = 0; k < t.count; k++) {
      const lane = t.lanes[k % t.lanes.length]!;
      this.slots.push({ path: track.path, offset: lane.offset, dir: lane.dir });
    }
    for (const r of track.routes) {
      for (let k = 0; k < r.count; k++) {
        const lane = r.lanes[k % r.lanes.length]!;
        this.slots.push({ path: r.path, offset: lane.offset, dir: lane.dir });
      }
    }
    this.reset();
  }

  get count(): number {
    return this.slots.length;
  }

  reset(): void {
    this.seg.fill(-1);
    this.waited.fill(0);
    this.edge.fill(0);
    for (let i = 0; i < MAX_CARS; i++) this.scan[i] = ((i * 97.31) % 1) * 1e3;
  }

  slotOf(id: number): TrafficSlot {
    return this.slots[id - this.firstId]!;
  }

  /** Start spots: loop cars spread round the loop clear of the grid, street cars spread along their street. */
  spawns(): TrafficSpawn[] {
    const L = this.track.length;
    const loop = this.slots.filter((s) => s.path === this.track.path).length;
    const perPath = new Map<TrackPath, number>();
    return this.slots.map((slot, k) => {
      const n = slot.path === this.track.path ? loop : this.slots.filter((s) => s.path === slot.path).length;
      const j = perPath.get(slot.path) ?? 0;
      perPath.set(slot.path, j + 1);
      const s = slot.path === this.track.path ? GRID_CLEAR + ((j + 0.5) / n) * (L - 2 * GRID_CLEAR) : ((j + 0.5) / n) * slot.path.length;
      return this.placeAt(this.firstId + k, s);
    });
  }

  /**
   * A wake-up spot for dormant car `id`: on its lane, between SPAWN_NEAR and SPAWN_FAR of the
   * nearest observer, SPAWN_CLEAR from every car, and not where `seen(x, z)` says a player is
   * looking. Null when no such spot turns up this time.
   */
  spawnPoint(id: number, observers: readonly AiCar[], cars: readonly AiCar[], seen: (x: number, z: number) => boolean): TrafficSpawn | null {
    const slot = this.slotOf(id);
    const len = slot.path.length;
    const span = slot.path.closed ? len : len - 2 * END_MARGIN;
    for (let tries = 0; tries < 24; tries++) {
      const s = slot.path.closed ? this.scan[id]! % len : END_MARGIN + (this.scan[id]! % span);
      this.scan[id]! += 37;
      const p = this.placeAt(id, s);
      let near = Infinity;
      for (const o of observers) near = Math.min(near, Math.hypot(o.x - p.x, o.z - p.z));
      if (near < SPAWN_NEAR || near > SPAWN_FAR) continue;
      let clear = true;
      for (const c of cars) {
        if (c.id !== id && Math.hypot(c.x - p.x, c.z - p.z) < SPAWN_CLEAR) {
          clear = false;
          break;
        }
      }
      if (clear && !seen(p.x, p.z)) return p;
    }
    return null;
  }

  /** True when car `id` (at x, z) has driven off the end of an open street. */
  atEnd(id: number, x: number, z: number): boolean {
    const slot = this.slotOf(id);
    if (slot.path.closed) return false;
    const p = projectPath(slot.path, x, z, this.seg[id]!, this.proj);
    return slot.dir > 0 ? p.s > slot.path.length - END_MARGIN : p.s < END_MARGIN;
  }

  /** Forget a car's projection hint and wait (after a teleport). */
  respawned(id: number): void {
    this.seg[id] = -1;
    this.waited[id] = 0;
    this.edge[id] = 0;
  }

  private placeAt(id: number, s: number): TrafficSpawn {
    const slot = this.slotOf(id);
    const p = pointOn(slot.path, s, this.pt);
    const heading = Math.atan2(p.tx, p.tz);
    return {
      x: p.x + p.tz * slot.offset,
      y: p.y,
      z: p.z - p.tx * slot.offset,
      yaw: slot.dir > 0 ? heading : wrapPi(heading + Math.PI),
    };
  }

  think(self: AiCar, others: readonly AiCar[], dt: number): DriveInput {
    const out = this.out;
    out.throttle = 0;
    out.steer = 0;
    out.brake = 0;
    out.ebrake = false;
    out.boost = false;
    const i = self.id;
    if (!self.alive) return out;
    const slot = this.slotOf(i);
    const path = slot.path;
    const proj = projectPath(path, self.x, self.z, this.seg[i]!, this.proj);
    this.seg[i] = proj.k;
    const speed = Math.hypot(self.vx, self.vz);
    const fx = Math.sin(self.yaw);
    const fz = Math.cos(self.yaw);

    // Anything in our lane ahead?
    let gap = Infinity;
    let gapAlong = 0;
    for (const o of others) {
      if (o.id === i) continue;
      const dx = o.x - self.x;
      const dz = o.z - self.z;
      const ahead = dx * fx + dz * fz;
      if (ahead <= 0.5 || ahead > LOOK) continue;
      if (Math.abs(dx * fz - dz * fx) > LANE_HALF) continue;
      if (ahead < gap) {
        gap = ahead;
        gapAlong = o.vx * fx + o.vz * fz;
      }
    }
    const blocked = gap < STOP_GAP + 3 && gapAlong < 1;
    this.waited[i] = blocked && speed < 0.8 ? this.waited[i]! + dt : blocked ? this.waited[i]! : 0;
    if (this.waited[i]! > WAIT) {
      this.waited[i] = 0;
      this.edge[i] = EDGE_TIME;
    }
    // Edging round: shift toward the centreline (and a little past it) at walking pace until clear.
    const edging = this.edge[i]! > 0;
    if (edging) this.edge[i]! -= dt;
    const offset = edging ? slot.offset - Math.sign(slot.offset || 1) * 3.6 : slot.offset;

    const ld = clamp(4 + 0.5 * speed, 6, 14);
    const p = pointOn(path, proj.s + slot.dir * ld, this.pt);
    const tx = p.x + p.tz * offset;
    const tz = p.z - p.tx * offset;
    const alpha = wrapPi(Math.atan2(tx - self.x, tz - self.z) - self.yaw);
    const surf = SURFACES[SURFACE_IDS[path.surface[proj.k]!]!];
    const turnMax = DRIVE.turn * (0.35 + 0.65 * Math.min(1, speed / 8)) * steerGrip(surf.grip);
    out.steer = clamp((2 * Math.max(speed, 3) * Math.sin(alpha)) / ld / Math.max(0.2, turnMax), -1, 1);

    const curv = Math.abs(path.curv[proj.k]!);
    let target = Math.min(this.speed, curv > 1e-4 ? (DRIVE.turn * 0.6) / curv : Infinity);
    // Speed that still stops STOP_GAP short of it at a gentle 4 m/s².
    if (gap < Infinity) target = Math.min(target, Math.max(0, gapAlong) + Math.sqrt(8 * Math.max(0, gap - STOP_GAP)));
    if (edging) target = Math.min(this.speed, 4);
    const along = self.vx * fx + self.vz * fz;
    if (target < 0.3 && !edging) {
      out.brake = 1;
    } else if (along > target + 1) {
      out.brake = clamp((along - target) / 4, 0.2, 1);
    } else {
      out.throttle = clamp(target / DRIVE.maxFwd + (target - along) * 0.15, 0, 1);
    }
    return out;
  }
}
