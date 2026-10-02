import { DRIVE, idleDrive, type DriveInput } from "../car-drive.ts";
import type { AiCar } from "../derby-ai.ts";
import { MAX_CARS } from "../fleet.ts";
import { steerGrip } from "./race-ai.ts";
import { SURFACE_IDS, SURFACES } from "./catalog.ts";
import { blankPoint, blankProjection, projectPath, type Track } from "./track.ts";

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
/** Grid zone (m) behind and ahead of the line kept clear at the start. */
const GRID_CLEAR = 60;

export type TrafficSpawn = { x: number; z: number; yaw: number };

function wrapPi(a: number): number {
  return a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2));
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * NPC world traffic on a course's `traffic` lanes: each car cruises its lane (lateral offset from
 * the centreline, + = left of the race direction; `dir` −1 drives against the race), slows for
 * turns, brakes for anything in its lane ahead (cars, wrecks), and after waiting behind a stopped
 * obstacle edges round it. Ids are car indices from `firstId`; lane = (id − firstId) mod lanes.
 * Deterministic; no allocation per call.
 */
export class TrafficBrain {
  readonly track: Track;
  readonly firstId: number;
  readonly lanes: readonly { offset: number; dir: 1 | -1 }[];
  readonly speed: number;
  private readonly out: DriveInput = idleDrive();
  private readonly seg = new Int32Array(MAX_CARS);
  private readonly waited = new Float64Array(MAX_CARS);
  private readonly edge = new Float64Array(MAX_CARS);
  private readonly proj = blankProjection();
  private readonly pt = blankPoint();

  constructor(track: Track, firstId: number) {
    const t = track.json.traffic;
    if (!t) throw new Error(`${track.id} has no traffic lanes`);
    this.track = track;
    this.firstId = firstId;
    this.lanes = t.lanes;
    this.speed = t.speed;
    this.reset();
  }

  reset(): void {
    this.seg.fill(-1);
    this.waited.fill(0);
    this.edge.fill(0);
  }

  laneOf(id: number): { offset: number; dir: 1 | -1 } {
    return this.lanes[(id - this.firstId) % this.lanes.length]!;
  }

  /** Start spots for `n` cars spread round the loop, clear of the start grid. */
  spawns(n: number): TrafficSpawn[] {
    const L = this.track.length;
    const span = L - 2 * GRID_CLEAR;
    return Array.from({ length: n }, (_, k) => this.placeAt(this.firstId + k, GRID_CLEAR + ((k + 0.5) / n) * span));
  }

  /** A respawn spot for car `id` at least `clear` m from every car in `others` (scanning on from a per-id start). */
  respawn(id: number, others: readonly AiCar[], clear: number): TrafficSpawn {
    const L = this.track.length;
    const start = ((id * 97.31) % 1) * L;
    for (let k = 0; k < 64; k++) {
      const spot = this.placeAt(id, start + k * 23);
      if (others.every((o) => o.id === id || Math.hypot(o.x - spot.x, o.z - spot.z) >= clear)) return spot;
    }
    return this.placeAt(id, start);
  }

  private placeAt(id: number, s: number): TrafficSpawn {
    const lane = this.laneOf(id);
    const p = this.track.pointAt(s, this.pt);
    const heading = Math.atan2(p.tx, p.tz);
    return { x: p.x + p.tz * lane.offset, z: p.z - p.tx * lane.offset, yaw: lane.dir > 0 ? heading : wrapPi(heading + Math.PI) };
  }

  /** Forget a car's projection hint and wait (after a respawn teleport). */
  respawned(id: number): void {
    this.seg[id] = -1;
    this.waited[id] = 0;
    this.edge[id] = 0;
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
    const tr = this.track;
    const lane = this.laneOf(i);
    const proj = projectPath(tr.path, self.x, self.z, this.seg[i]!, this.proj);
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
    const offset = edging ? lane.offset - Math.sign(lane.offset || 1) * 3.6 : lane.offset;

    const ld = clamp(4 + 0.5 * speed, 6, 14);
    const p = tr.pointAt(proj.s + lane.dir * ld, this.pt);
    const tx = p.x + p.tz * offset;
    const tz = p.z - p.tx * offset;
    const alpha = wrapPi(Math.atan2(tx - self.x, tz - self.z) - self.yaw);
    const surf = SURFACES[SURFACE_IDS[tr.path.surface[proj.k]!]!];
    const turnMax = DRIVE.turn * (0.35 + 0.65 * Math.min(1, speed / 8)) * steerGrip(surf.grip);
    out.steer = clamp((2 * Math.max(speed, 3) * Math.sin(alpha)) / ld / Math.max(0.2, turnMax), -1, 1);

    const curv = Math.abs(tr.path.curv[proj.k]!);
    let target = Math.min(this.speed, curv > 1e-4 ? (DRIVE.turn * 0.6) / curv : Infinity);
    // Speed that still stops STOP_GAP short of it at a gentle 4 m/s².
    if (gap < Infinity) target = Math.min(target, Math.max(0, gapAlong) + Math.sqrt(8 * Math.max(0, gap - STOP_GAP)));
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
