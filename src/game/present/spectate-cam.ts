import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import { CAR_HALF, WHEEL_POS } from "../vehicle/car-mesh.ts";
import { NO_FLOOR, type Ground } from "../world/ground.ts";
import { PREFABS } from "../world/catalog.ts";
import type { Placed } from "../world/placements.ts";
import { blankPoint, blankProjection, pointOn, projectPath, type Track, type TrackPath } from "../world/track.ts";
import { GANTRY_BEAM, levelAt, RoadIndex, sampleAt, sections, TUNNEL_GAP, TUNNEL_SIDE } from "./track-mesh.ts";
import { pillarPieces } from "./track-structures.ts";

/**
 * Spectator cams beyond the chase views: the trackside cinematic (a fixed eye ahead of the car that tracks it
 * past, then cuts to the next spot) and the dutch wheel-well mount. Neither uses randomness: a shot follows from
 * the car poses, the scene and the rig's own counters, so two rigs fed the same poses frame the same shots.
 * All the sight-line work runs when a shot is picked, never per frame.
 */

/** A solid the cinematic eye may not stand in or look through: a yawed box (or upright cylinder, r = hx) over [y0, y1]. */
export type Occluder = { x: number; z: number; cos: number; sin: number; hx: number; hz: number; circle: boolean; y0: number; y1: number };

/** Box local x = (cos yaw, −sin yaw), local z = (sin yaw, cos yaw): the props' and the jersey slab's frame. */
export function occluder(x: number, z: number, yaw: number, hx: number, hz: number, circle: boolean, y0: number, y1: number): Occluder {
  return { x, z, cos: Math.cos(yaw), sin: Math.sin(yaw), hx, hz, circle, y0, y1 };
}

/** The scene's solids, as the cinematic eye sees them. */
export type Sight = {
  /** Terrain, roads and bridge decks: below a surface (within its slab) is solid. */
  ground: Ground;
  /** The race loop (walls, tunnels; the eye goes ahead along it), or null off a race (ahead along the car's travel). */
  path: TrackPath | null;
  /** Race wall height (m) above the road. */
  wallTop: number;
  /** Bowl wall radius (m) the eye stays inside (derby); Infinity elsewhere. */
  rim: number;
  occ: readonly Occluder[];
};

export const CINE = {
  /** The eye stands this many seconds of the car's speed ahead, clamped (m): along the course, or along the travel off a race. */
  leadTime: 3,
  lead: [20, 90],
  leadOff: [8, 30],
  /** Lead fractions tried in order when a spot is blocked. */
  leadTry: [1, 0.65, 1.4, 0.4],
  /** Eye heights above the ground (m): about ground level to 3 × the car's height (1.36 m). */
  heights: [0.6, 1.5, 2.8, 4.1],
  /** Off a race: eye this far (m) to the side of the travel line. */
  sideOff: [3.5, 7],
  /** Clearance (m) the eye keeps from every solid, and the sight-line sample step (m). */
  pad: 0.5,
  step: 0.5,
  /** Sight lines stop this short (m) of the car: it may be touching a wall or a cone itself. */
  stop: 1.5,
  /** Aim this high (m) over the car's ground point. */
  aimUp: 0.7,
  /** Cut to the next spot this long (s) after the car passes the eye, after `maxShot` s, or past `lose` m. */
  after: 0.8,
  maxShot: 7,
  lose: 140,
  /** No clear spot: the old shot holds and the pick retries after this many seconds. */
  retry: 0.4,
  /** A search gives up (no clear spot: the old shot holds, or the chase) after this many spots that reached a sight line. */
  tries: 40,
  /** Sight-line samples a search spends per frame before it pauses (a call's first line always runs, ≤ `LINE_SAMPLES`); each candidate spot also costs `SPOT_COST`. */
  perFrame: 400,
  /** Lens (deg): `frame` m across the car at its range, clamped. */
  fov: [18, 60],
  frame: 6,
};

const raceSights = new WeakMap<Track, Sight>();

/** The course's solids at their drawn size (placed props, the start gantry's legs, bridge pillars); cached per track. */
export function raceSight(track: Track, placed: readonly Placed[]): Sight {
  const hit = raceSights.get(track);
  if (hit) return hit;
  const occ = placed.map((p) => {
    const spec = PREFABS[p.prefab];
    const hx = (spec.size[0] * p.sx) / 2;
    const hz = (spec.size[2] * p.sz) / 2;
    // Thin round props (lamps, cones) get their heads and arms: 0.45 m at least.
    if (spec.collider?.kind === "circle") {
      const r = Math.max(hx, hz, 0.45);
      return occluder(p.x, p.z, p.yaw, r, r, true, p.y, p.y + spec.size[1] * p.sy);
    }
    return occluder(p.x, p.z, p.yaw, hx, hz, false, p.y, p.y + spec.size[1] * p.sy);
  });
  // Start gantry legs (art only, `TrackArt`): just past each side's wall line.
  const path = track.path;
  const ground = track.ground();
  const pt = pointOn(path, 0, blankPoint());
  for (const lat of [pt.half + path.runL[0]! + 1.2, -(pt.half + path.runR[0]! + 1.2)]) {
    const x = pt.x + pt.tz * lat;
    const z = pt.z - pt.tx * lat;
    const y = ground.heightAt(x, z, pt.y);
    occ.push(occluder(x, z, 0, 0.6, 0.6, false, y, y + GANTRY_BEAM + 0.5));
  }
  // Bridge pillars and pier caps, as `TrackArt` builds them (their bounding boxes).
  const paths = track.paths();
  const index = new RoadIndex(paths);
  const box = new THREE.Box3();
  for (const p of paths) {
    if (!p.deck.includes(1)) continue;
    for (const [geo] of pillarPieces(p, sections(p, 0), ground, index)) {
      geo.computeBoundingBox();
      box.copy(geo.boundingBox!);
      geo.dispose();
      occ.push(occluder((box.min.x + box.max.x) / 2, (box.min.z + box.max.z) / 2, 0, (box.max.x - box.min.x) / 2, (box.max.z - box.min.z) / 2, false, box.min.y, box.max.y));
    }
  }
  const sight: Sight = { ground, path, wallTop: track.json.road.wallHeight, rim: Infinity, occ };
  raceSights.set(track, sight);
  return sight;
}

const _proj = blankProjection();
const _pt = blankPoint();
const _near: Occluder[] = [];

/** True when (x, y, z) is within `pad` of a solid. `occ`: the occluders to test (`gather`ed near a sight line). `terrain` false skips the hill / road-bed / deck test (a spot's side samples may stand beside a bank). */
export function solid(s: Sight, x: number, y: number, z: number, pad: number, occ: readonly Occluder[] = s.occ, terrain = true): boolean {
  // In a hill or a road's bed, or in a bridge deck's slab (the surface within `STEP_UP` over the point).
  if (terrain && y < s.ground.heightAt(x, z, y + pad) + pad) return true;
  if (x * x + z * z > (s.rim - pad) ** 2) return true;
  const p = s.path;
  if (p) {
    projectPath(p, x, z, _proj.k, _proj);
    const k = _proj.k;
    const lat = _proj.lateral;
    const left = lat > 0;
    const over = Math.abs(lat) - p.half[k]! - (left ? p.runL[k]! : p.runR[k]!);
    const road = levelAt(p, k, lat);
    // A tunnel's rock past its inner face, or its roof.
    if (p.tunnel[k] && over < 30 && (over > TUNNEL_GAP - pad || y > road + TUNNEL_SIDE - pad)) return true;
    // In a wall, or low behind it (so a sight line that leaves the corridor under the wall top is blocked).
    if ((left ? p.wallL[k] : p.wallR[k]) && over > -pad && over < 3 && y < road + s.wallTop + pad) return true;
  }
  for (const o of occ) {
    if (y < o.y0 - pad || y > o.y1 + pad) continue;
    const ex = x - o.x;
    const ez = z - o.z;
    if (o.circle) {
      if (ex * ex + ez * ez < (o.hx + pad) ** 2) return true;
      continue;
    }
    if (Math.abs(ex * o.cos - ez * o.sin) < o.hx + pad && Math.abs(ex * o.sin + ez * o.cos) < o.hz + pad) return true;
  }
  return false;
}

/** `_near` = the occluders whose footprint, grown by `pad`, can reach the flat box around a→b. */
function gather(s: Sight, ax: number, az: number, bx: number, bz: number, pad: number): Occluder[] {
  _near.length = 0;
  const x0 = Math.min(ax, bx);
  const x1 = Math.max(ax, bx);
  const z0 = Math.min(az, bz);
  const z1 = Math.max(az, bz);
  for (const o of s.occ) {
    const r = (o.circle ? o.hx : Math.hypot(o.hx, o.hz)) + pad;
    if (o.x + r > x0 && o.x - r < x1 && o.z + r > z0 && o.z - r < z1) _near.push(o);
  }
  return _near;
}

/** Most sight-line samples a line takes: longer lines sample coarser, with a wider half-step margin. */
const LINE_SAMPLES = 80;
/**
 * Sight from a to b up to `CINE.stop` m short of b: samples every `CINE.step` m (stretched to `len / LINE_SAMPLES` on a
 * line longer than that, so a 90 m line costs 80 tests, not 180), each kept half a step clear of every solid, so the
 * line between two samples can't clip a corner and a solid on the line is always met. Returns the samples taken, negated when one was solid.
 */
export function sightLine(s: Sight, ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.hypot(dx, dy, dz);
  const step = Math.max(CINE.step, len / LINE_SAMPLES);
  const pad = step / 2;
  const occ = gather(s, ax, az, bx, bz, pad);
  let n = 0;
  for (let d = step; d < len - CINE.stop + step; d += step) {
    const f = d / len;
    n++;
    if (solid(s, ax + dx * f, ay + dy * f, az + dz * f, pad, occ)) return -n;
  }
  return n;
}

/** The samples `sightLine` takes along a line of length `len`. */
function lineSamples(len: number): number {
  return Math.max(0, Math.ceil((len - CINE.stop) / Math.max(CINE.step, len / LINE_SAMPLES)));
}

/** Every camera cut passes `clearSpot` and the predicted sight (`aheadPoints`) before it takes the shot. */
export const CLEAR = {
  /** `clearSpot`: samples this far (m) out of the spot, in `FLAT` directions round it, straight up and straight down. */
  radius: 2,
  /** The spot and each sample keep this far (m) from every solid; the spot itself over the ground too. */
  pad: 0.25,
  /** The target is sampled every `every` s over the shot's horizon (at most `most` times), after its place now: a gap this short keeps a crest or a corner from hiding the car between two samples. */
  every: 0.5,
  most: 8,
};
/** Flat sample directions: 30° apart, so a face at least 0.25 m thick within 1.9 m of the spot is always reached. */
const FLAT = 12;
const RING = Array.from({ length: FLAT }, (_, i) => [Math.cos((i * 2 * Math.PI) / FLAT), Math.sin((i * 2 * Math.PI) / FLAT)] as const);
/** What `clearSpot` costs a search budget: its solid tests (about one sight-line sample each). */
export const CLEAR_COST = FLAT + 3;
/** What a candidate spot's cheap checks (ground height, solid) cost a search budget, in sight-line samples: measured at about 20 µs each, a search tries up to 160 of them. */
const SPOT_COST = 20;

/**
 * True when a camera at (x, y, z) has `radius` m (2) of room: the spot is out of every solid and over the ground,
 * and so are the samples `radius` out round it, above it (a deck, a roof of rock) and below it (a roof or prop it
 * hovers over). The side samples skip the terrain test, so a spot beside a bank is fine; walls count, so a spot
 * hugging one (or behind one, low) is not. Cheap: the occluders near the spot are gathered once, ~15 solid tests.
 */
export function clearSpot(s: Sight, x: number, y: number, z: number, radius: number = CLEAR.radius): boolean {
  const pad = CLEAR.pad;
  const occ = gather(s, x - radius, z - radius, x + radius, z + radius, pad);
  if (solid(s, x, y, z, pad, occ)) return false;
  for (const [c, n] of RING) if (solid(s, x + c * radius, y, z + n * radius, pad, occ, false)) return false;
  return !solid(s, x, y + radius, z, pad, occ) && !solid(s, x, y - radius, z, pad, occ, false);
}

type Vec3 = { x: number; y: number; z: number };

/**
 * Where the target (tx, ty, tz) moving at (vx, vz) will be over `horizon` s, sampled every `CLEAR.every` s (into `out`
 * as x, y, z triples; the first is the target now). Straight on its velocity in the open; along the course at the
 * same speed on one (a bend or a street corner would put a straight line through the infield or a building), at the
 * same lateral offset and height over the road. A sample no car could stand at (off the ground, inside a solid) is
 * dropped. Returns the samples kept.
 */
export function aheadPoints(s: Sight, tx: number, ty: number, tz: number, vx: number, vz: number, horizon: number, out: Float64Array, hint = -1): number {
  const speed = Math.hypot(vx, vz);
  const steps = speed * horizon < 1 ? 0 : Math.min(CLEAR.most, Math.max(1, Math.ceil(horizon / CLEAR.every)));
  const path = s.path;
  let s0 = 0;
  let dir = 1;
  let lat = 0;
  let dy = 0;
  if (path && steps > 0) {
    projectPath(path, tx, tz, hint, _proj);
    s0 = _proj.s;
    lat = _proj.lateral;
    if (vx * path.tx[_proj.k]! + vz * path.tz[_proj.k]! < 0) dir = -1;
    dy = ty - pointOn(path, s0, _pt).y;
  }
  const g0 = s.ground.heightAt(tx, tz, ty + 1);
  out[0] = tx;
  out[1] = ty;
  out[2] = tz;
  let n = 1;
  for (let i = 1; i <= steps; i++) {
    const t = (horizon * i) / steps;
    let x = tx + vx * t;
    let z = tz + vz * t;
    let y: number;
    if (path) {
      pointOn(path, s0 + dir * speed * t, _pt);
      x = _pt.x + _pt.tz * lat;
      z = _pt.z - _pt.tx * lat;
      y = _pt.y + dy;
    } else {
      const g = s.ground.heightAt(x, z, ty + 1);
      if (g === NO_FLOOR) continue;
      y = g0 === NO_FLOOR ? ty : g + (ty - g0);
    }
    if (solid(s, x, y, z, 0)) continue;
    out[3 * n] = x;
    out[3 * n + 1] = y;
    out[3 * n + 2] = z;
    n++;
  }
  return n;
}

/**
 * The sight lines from one eye to the places a target will be (`aheadPoints`, into `points`), checked over several calls:
 * `start` (or `begin`), then `run` with a budget of samples until it answers. A line is never cut short, and a call goes
 * past its budget only by the first line it runs (at most `LINE_SAMPLES`). No allocation.
 */
export class SightLines {
  readonly points = new Float64Array(3 * (CLEAR.most + 1));
  readonly eye = new THREE.Vector3();
  /** Samples the last `run` took (the search budgets count them). */
  spent = 0;
  private s: Sight | null = null;
  private n = 0;
  private i = 0;

  /** Lines are being checked: `start` ran and `run` has not answered yet. */
  get active(): boolean {
    return this.n > 0;
  }

  /** Check the lines from (x, y, z) to the first `n` (1 or more) `points`, in `s`. */
  start(s: Sight, x: number, y: number, z: number, n: number): void {
    this.s = s;
    this.eye.set(x, y, z);
    this.n = n;
    this.i = 0;
  }

  /** `camUsable`'s question, begun: false when `eye` has no room (`clearSpot`; costs `CLEAR_COST`), else its lines are started. */
  begin(s: Sight, eye: Vec3, target: Vec3, vel: Vec3, horizon: number): boolean {
    if (!clearSpot(s, eye.x, eye.y, eye.z)) return false;
    this.start(s, eye.x, eye.y, eye.z, aheadPoints(s, target.x, target.y, target.z, vel.x, vel.z, horizon, this.points));
    return true;
  }

  /** Drop the check in progress. */
  cancel(): void {
    this.n = 0;
    this.s = null;
  }

  /**
   * Check lines until one is blocked, all are clear, or the next line would take the call past `budget` samples ("more":
   * call again to go on with it). A call's first line always runs, so a line dearer than the budget still gets done.
   */
  run(budget: number): "clear" | "blocked" | "more" {
    this.spent = 0;
    const e = this.eye;
    while (this.i < this.n) {
      const k = 3 * this.i;
      const x = this.points[k]!;
      const y = this.points[k + 1]!;
      const z = this.points[k + 2]!;
      if (this.spent > 0 && this.spent + lineSamples(Math.hypot(x - e.x, y - e.y, z - e.z)) > budget) return "more";
      this.i++;
      const r = sightLine(this.s!, e.x, e.y, e.z, x, y, z);
      this.spent += Math.abs(r);
      if (r < 0) {
        this.cancel();
        return "blocked";
      }
    }
    this.cancel();
    return "clear";
  }
}

const _lines = new SightLines();

/**
 * The one question a camera cut (and a held shot, re-asked as it plays) answers: is `eye` clear (`clearSpot`) and
 * does it see `target` (the point it aims at) now and every `CLEAR.every` s over the next `horizon` s at its
 * velocity `vel` (`aheadPoints`; `vel.y` is ignored)? Walls, barriers, buildings, props and the other cars in `s` all
 * block. ~15 + (up to 9 sight lines) solid tests. A search that must not hitch asks it in slices (`SightLines`).
 */
export function camUsable(s: Sight, eye: Vec3, target: Vec3, vel: Vec3, horizon: number): boolean {
  return _lines.begin(s, eye, target, vel, horizon) && _lines.run(Infinity) === "clear";
}

/** Candidate spots per lead distance: two sides × two lateral offsets × the heights. */
const PER_LEAD = 4 * CINE.heights.length;
const SPOTS = CINE.leadTry.length * PER_LEAD;

/** What the trackside cam frames: a car, or anything with a ground position, velocity and flat heading (a thrown dummy). */
export type Subject = { group: { position: THREE.Vector3 }; velocity: THREE.Vector3; fwdFlat: THREE.Vector3 };

/**
 * Trackside cinematic: a fixed eye ahead of the car, between ground level and ~3 car heights, out of every solid
 * with `CLEAR.radius` m of room (`clearSpot`) and clear sight to the car now and at its places over the shot
 * (`aheadPoints`). It tracks the car until `CINE.after` s after it passes, then cuts to the next spot ahead. Picks
 * alternate sides and walk the heights, so shots vary. A search tries at most `CINE.tries` spots that got as far as a
 * sight line, and spends about `CINE.perFrame` sight-line samples a frame (the old shot holds meanwhile), so it never
 * hitches a frame.
 */
export class CineCam {
  readonly eye = new THREE.Vector3();
  /** A shot is set up (false until the first clear pick). */
  has = false;
  /** Searches finished so far: the side and height order of the next one follow from it. */
  picks = 0;
  /** The next spot the search in progress tries (0: none in progress), and how many it has sent to a sight line. */
  private next = 0;
  private tried = 0;
  /** Flat travel direction at the pick: the car has passed once it is beyond the eye's plane across it. */
  private tx = 0;
  private tz = 1;
  private car: Subject | null = null;
  private readonly last = new THREE.Vector3();
  private age = 0;
  private past = 0;
  private wait = 0;
  /** Sight-line samples tested so far (the search budget counts them). */
  private spent = 0;
  /** The spot being checked: its sight lines (they go on over several `pick` calls) and the travel direction there. */
  private readonly lines = new SightLines();
  private sx = 0;
  private sz = 1;

  /** Forget the shot; the next `update` picks one. `seed` restarts the pick counter (replays: same seed, same shots). */
  reset(seed = this.picks): void {
    this.has = false;
    this.wait = 0;
    this.next = 0;
    this.tried = 0;
    this.lines.cancel();
    this.picks = seed;
  }

  /** Frame `car` from the eye (searching for the next one when due); false while no clear spot was found yet. */
  update(camera: THREE.PerspectiveCamera, car: Subject, sight: () => Sight, dt: number): boolean {
    const p = car.group.position;
    // A new car or a respawn jump: start over.
    if (this.car !== car || this.last.distanceToSquared(p) > 64) this.reset();
    this.car = car;
    this.last.copy(p);
    this.age += dt;
    this.wait -= dt;
    const ex = p.x - this.eye.x;
    const ez = p.z - this.eye.z;
    if (this.has && ex * this.tx + ez * this.tz > 0) this.past += dt;
    const due = !this.has || this.past > CINE.after || this.age > CINE.maxShot || ex * ex + ez * ez > CINE.lose * CINE.lose;
    if (due && this.wait <= 0) {
      const got = this.pick(sight(), car, CINE.perFrame);
      if (got === "found") {
        this.has = true;
        this.age = 0;
        this.past = 0;
      } else if (got === "none") this.wait = CINE.retry;
    }
    if (!this.has) return false;
    camera.position.copy(this.eye);
    camera.lookAt(p.x, p.y + CINE.aimUp, p.z);
    const fov = THREE.MathUtils.clamp(2 * THREE.MathUtils.radToDeg(Math.atan2(CINE.frame, this.eye.distanceTo(p))), CINE.fov[0]!, CINE.fov[1]!);
    if (Math.abs(fov - camera.fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    return true;
  }

  /**
   * Try the spots ahead of `car` in a fixed order (lead distance, side, lateral offset, height), resuming where the
   * last call stopped, until `budget` sight-line samples are spent (a spot's sight lines go on over the calls, one line
   * at a time): "found" (sets `eye` and the pass plane), "none" when every spot is blocked, "more" when the budget ran
   * out first. No allocation.
   */
  pick(s: Sight, car: Subject, budget = Infinity): "found" | "none" | "more" {
    const stop = this.spent + budget;
    // A spot the last call left half-checked is finished first.
    if (this.lines.active) {
      const r = this.verify(stop);
      if (r !== "blocked") return r;
      this.next++;
    }
    const seq = this.picks;
    const p = car.group.position;
    const v = car.velocity;
    const speed = Math.hypot(v.x, v.z);
    let tx = car.fwdFlat.x;
    let tz = car.fwdFlat.z;
    if (speed > 1.5) {
      tx = v.x / speed;
      tz = v.z / speed;
    }
    const path = s.path;
    let s0 = 0;
    let dir = 1;
    let k0 = -1;
    if (path) {
      projectPath(path, p.x, p.z, -1, _proj);
      s0 = _proj.s;
      // Along the course the way the car travels (forward unless it is rolling backward).
      k0 = _proj.k;
      if (speed > 1.5 && tx * path.tx[k0]! + tz * path.tz[k0]! < 0) dir = -1;
    }
    const [lo, hi] = path ? CINE.lead : CINE.leadOff;
    const lead = THREE.MathUtils.clamp(speed * CINE.leadTime, lo!, hi!);
    const hs = CINE.heights;
    const ay0 = p.y + CINE.aimUp;
    for (; this.next < SPOTS && this.spent < stop; this.next++) {
      const c = this.next;
      this.spent += SPOT_COST;
      const f = CINE.leadTry[Math.floor(c / PER_LEAD)]!;
      const side = (Math.floor(c / (2 * hs.length)) + seq) % 2 === 0 ? 1 : -1;
      const outer = Math.floor(c / hs.length) % 2 === 0;
      const hh = hs[(c + (seq >> 1)) % hs.length]!;
      // The spot's ground frame: the course point and its tangent, or straight down the travel.
      let ax = p.x + tx * lead * f;
      let az = p.z + tz * lead * f;
      let ay = p.y;
      let fx = tx;
      let fz = tz;
      // Left of travel = (fz, −fx). On a course: behind the wall (looking over it) or on the runoff inside it.
      let lat = outer ? CINE.sideOff[1]! : CINE.sideOff[0]!;
      if (path) {
        const at = s0 + dir * lead * f;
        pointOn(path, at, _pt);
        const k = sampleAt(path, at);
        ax = _pt.x;
        az = _pt.z;
        ay = _pt.y;
        fx = _pt.tx * dir;
        fz = _pt.tz * dir;
        const left = side * dir > 0;
        const limit = path.half[k]! + (left ? path.runL[k]! : path.runR[k]!);
        lat = outer ? limit + 1.1 : limit - 0.9;
        if (!outer && lat < path.half[k]! + 0.6) continue;
        // Behind a wall the eye looks over it.
        if (outer && (left ? path.wallL[k] : path.wallR[k]) && hh < s.wallTop + 0.5) continue;
      }
      const x = ax + fz * lat * side;
      const z = az - fx * lat * side;
      const gy = s.ground.heightAt(x, z, ay + 1);
      if (gy === NO_FLOOR) continue;
      const y = gy + hh;
      if (solid(s, x, y, z, CINE.pad)) continue;
      this.spent += CLEAR_COST;
      if (!clearSpot(s, x, y, z)) continue;
      // A search stops after `CINE.tries` spots that got as far as a sight line.
      if (this.tried >= CINE.tries) {
        this.next = SPOTS;
        break;
      }
      this.tried++;
      // The car's places until it has passed the eye a moment (the shot cuts then): every spot sees it at each one.
      this.lines.start(s, x, y, z, aheadPoints(s, p.x, ay0, p.z, v.x, v.z, Math.min(CINE.maxShot, (lead * f) / Math.max(speed, 1) + CINE.after), this.lines.points, k0));
      this.sx = fx;
      this.sz = fz;
      const r = this.verify(stop);
      if (r !== "blocked") return r;
    }
    if (this.next < SPOTS) return "more";
    this.next = 0;
    this.tried = 0;
    this.picks++;
    return "none";
  }

  /** Check the started spot's sight lines with what is left of `stop`; all clear: the spot becomes the shot. */
  private verify(stop: number): "found" | "blocked" | "more" {
    const r = this.lines.run(stop - this.spent);
    this.spent += this.lines.spent;
    if (r !== "clear") return r === "more" ? "more" : "blocked";
    this.eye.copy(this.lines.eye);
    this.tx = this.sx;
    this.tz = this.sz;
    this.next = 0;
    this.tried = 0;
    this.picks++;
    return "found";
  }
}

export const DUTCH = {
  /** Seconds per mount before cutting to another; after `min` s it cuts early (checked every `check` s) to a mount seeing more rivals. */
  every: 3.5,
  min: 1.2,
  check: 0.4,
  /** Roll (rad) off level, leaning away from the body; the eye hangs `out` m outboard of the body, aimed `splay` rad outward. */
  roll: 0.3,
  out: 0.32,
  splay: 0.07,
  fov: 66,
  /** Rivals further than this (m) don't count as in view. */
  range: 90,
};

type Mount = { x: number; y: number; z: number; dz: number; roll: number };

/** Each wheel well, hanging outboard of the body above the tyre, looking forward (dz 1) or back (−1). */
const MOUNTS: readonly Mount[] = WHEEL_POS.flatMap(([x, y, z]) =>
  [1, -1].map((dz) => ({ x: Math.sign(x) * (CAR_HALF.x + DUTCH.out), y: y + 0.34, z, dz, roll: Math.sign(x) * dz * DUTCH.roll })),
);
const _a = new THREE.Vector3();
const _m = new THREE.Matrix4();

/**
 * Dutch-angle cam on a wheel well. About every `DUTCH.every` s it cuts to another of the eight mounts (four wells ×
 * forward / back): the one with the most rivals in its frustum, the first after the current one among ties, as long
 * as it sees as many as this one. Sooner (after `DUTCH.min` s) when another mount sees more.
 */
export class DutchCam {
  mount = 0;
  private age = 0;
  private wait = 0;
  private car: DeformableCar | null = null;
  private readonly probe = new THREE.PerspectiveCamera();
  private readonly frustum = new THREE.Frustum();
  private readonly sphere = new THREE.Sphere(new THREE.Vector3(), 1.6);

  /** Re-choose on the next `update`, starting the search after `mount` (replays: same seed, same cuts). */
  reset(mount = this.mount): void {
    this.mount = mount % MOUNTS.length;
    this.car = null;
  }

  /** `camera` on mount `j` of `car`: aimed along the body, splayed outward and a touch down, then rolled. */
  place(camera: THREE.PerspectiveCamera, car: DeformableCar, j: number): void {
    const m = MOUNTS[j]!;
    car.group.localToWorld(camera.position.set(m.x, m.y, m.z));
    camera.lookAt(car.group.localToWorld(_a.set(m.x + Math.sign(m.x) * 10 * DUTCH.splay, m.y - 0.5, m.z + m.dz * 10)));
    camera.rotateZ(m.roll);
  }

  /** Rivals (not `car`, not vaporized) in mount `j`'s view within `DUTCH.range`; `lens` gives the aspect. */
  seen(car: DeformableCar, rivals: readonly DeformableCar[], j: number, lens: THREE.PerspectiveCamera): number {
    const c = this.probe;
    c.fov = DUTCH.fov;
    c.aspect = lens.aspect;
    c.near = lens.near;
    c.far = DUTCH.range;
    c.updateProjectionMatrix();
    this.place(c, car, j);
    c.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(_m.multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse));
    let n = 0;
    for (const r of rivals) {
      if (r === car || r.vaporized || !r.group.visible) continue;
      this.sphere.center.copy(r.group.position).y += CINE.aimUp;
      if (this.frustum.intersectsSphere(this.sphere)) n++;
    }
    return n;
  }

  /** Cut when due (or for a new car), then put `camera` on the mount. */
  update(camera: THREE.PerspectiveCamera, car: DeformableCar, rivals: () => readonly DeformableCar[], dt: number): void {
    this.age += dt;
    this.wait -= dt;
    if (this.car !== car) {
      this.car = car;
      this.choose(car, rivals(), camera);
    } else if (this.age >= DUTCH.min && this.wait <= 0) {
      this.wait = DUTCH.check;
      const all = rivals();
      // Due: to a mount seeing as many rivals as this one; before that only to one seeing more.
      this.choose(car, all, camera, this.seen(car, all, this.mount, camera) + (this.age >= DUTCH.every ? 0 : 1));
    }
    this.place(camera, car, this.mount);
    if (camera.fov !== DUTCH.fov) {
      camera.fov = DUTCH.fov;
      camera.updateProjectionMatrix();
    }
  }

  /**
   * Cut to the mount (not the current one) with the most rivals in view, the first after the current one among ties,
   * if it sees at least `need` of them.
   */
  choose(car: DeformableCar, rivals: readonly DeformableCar[], lens: THREE.PerspectiveCamera, need = 0): void {
    let best = -1;
    let pick = this.mount;
    for (let d = 1; d < MOUNTS.length; d++) {
      const j = (this.mount + d) % MOUNTS.length;
      const n = this.seen(car, rivals, j, lens);
      if (n > best) {
        best = n;
        pick = j;
      }
    }
    if (best < need) return;
    this.mount = pick;
    this.age = 0;
  }
}
