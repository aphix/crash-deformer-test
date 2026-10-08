import { hypot2, hypot3 } from "../kernel/physics-core.js";
import { SURFACE_IDS, SURFACES } from "./catalog.ts";

/**
 * The one store of solid surfaces (docs/UNIFIED_CONTACT.md, Stage 1): everything a body can stand on answers one question,
 * "at this point, where is the surface, which way does it face, how grippy is it, and whose is it".
 *
 * A `Surface` is the base class every surface extends. It holds no query: a subclass supplies plain data, patches in typed
 * arrays, and a scene activates it (`setGround`). A patch is a bilinear node grid in its own frame (a plane is one cell; the
 * track's field, a ramp face, the corkscrew's floor and a car's roof plate are the same thing; a roof's frame is the car's)
 * or a bridge deck segment in the road's crease form. The static part is registered once per scene with its spatial index;
 * the dynamic part (`CarSurfaces`) is a fixed set of slots whose frame and world box are rewritten in place every slice.
 *
 * `pointContact` and `wheelContact` are the two queries: pure functions over the typed arrays, no `this`, no allocation.
 */

/** `pointContact` / `wheelContact` output slots. */
export const C_H = 0;
export const C_NX = 1;
export const C_NY = 2;
export const C_NZ = 3;
export const C_GRIP = 4;
export const C_SURF = 5;
export const C_OWNER = 6;
const C_ARG = 7;
/** A roof's follow factor (0..1) at the point, 1 for a patch without `aux`. */
export const C_AUX = 8;
/** `wheelContact` only: the world position of the footprint point that sets `rise`. */
export const C_PX = 9;
export const C_PY = 10;
export const C_PZ = 11;
/** `wheelContact` only: the greatest lift any of the tread (the footprint and both shoulders) needs: a tyre pressed to a wall is down on it. */
export const C_TOUCH = 12;
export const HIT_SIZE = 13;

/** Friction of a tyre across what it stands on and climbs. */
export const MU_TYRE = 0.9;
/**
 * The step a tyre mounts by grip alone, as a share of its radius: a step of height s puts the contact normal at the tyre's edge
 * asin(1 - s/r) over the horizontal, and the tyre climbs while that is steeper than the friction angle atan(1/mu): s <= r (1 - 1/sqrt(1 + mu^2)),
 * 0.26 r (a sedan's 0.32 m tyre mounts 8 cm, a monster's 0.54 m tyre 14 cm).
 */
export const MOUNT = 1 - 1 / Math.sqrt(1 + MU_TYRE ** 2);

/** No surface under the point: `pointContact` answers this height. */
const NONE = -Infinity;

/** A patch's kind. */
export const GRID = 0;
const DECK = 1;

/** Patch parameters, `P_STRIDE` numbers each. A grid reads its frame, a deck its road segment. */
export const P_STRIDE = 25;
export const P_OX = 0;
export const P_OY = 1;
export const P_OZ = 2;
/** The frame's axes in world (local x, local y = up, local z: three numbers each). */
export const P_AX = 3;
export const P_BX = 6;
export const P_CX = 9;
/** Grid origin in the frame (u along x, v along z) and the cell size along each (m). */
export const P_U0 = 12;
export const P_V0 = 13;
export const P_STEP = 14;
export const P_STEPV = 23;
/** The surface counts as under a point only when it is at most this far (m) above it. */
const P_REACH = 15;
/** Lowered by this (m) times the point's `aux`, along the frame's up (a roof's crush). */
const P_DROP = 16;
/** Grip multiplier of the patch. */
const P_GRIP = 17;
/** > 0: the patch is the disc of this radius² around its origin in plan. */
export const P_RAD2 = 18;
/** The patch's world box (plan). Rewritten with a moving patch; an empty box (min > max) disables it. */
const P_MINX = 19;
const P_MAXX = 20;
const P_MINZ = 21;
const P_MAXZ = 22;
/** Bound on a grid's |node height| (frame y, m): how far a tilted frame's plan box grows. */
const P_HMAX = 24;
/** Deck: segment start (x, y, z), its plan vector (ex, ez), rise to the end, |e|², |e|, half width, run each side, tan(bank). */
const D_EX = 3;
const D_EZ = 5;
const D_DY = 6;
const D_LEN2 = 7;
const D_LEN = 8;
const D_HALF = 9;
const D_RUNL = 10;
const D_RUNR = 11;
const D_TAN = 12;

/** Patch integers, `Q_STRIDE` each. */
export const Q_STRIDE = 9;
export const Q_KIND = 0;
export const Q_NU = 1;
export const Q_NV = 2;
/** Surface index (`SURFACE_IDS`) of the patch; −1: per node (`surfs`). A deck's road surface. */
const Q_SURF = 3;
/** A deck's run-off surface; a grid's surface past its nodes (the hills of a track's field); −1: it answers nothing past its nodes. */
const Q_SURF2 = 4;
/** −1 the world's; else the slot (car index) that owns the patch. */
const Q_OWNER = 5;
/** 1: the patch answers over the whole plan, not only over its box. */
const Q_UNB = 6;
/** 1: a body that collides by shape (the ragdoll's world) meets this patch; 0: height queries only (a moving slab, a floor baked into a mesh). */
export const Q_SOLID = 7;
/** 1: the patch changed after its surface was sealed (its frame, drop, node data, owner or box): no cell reads it as plain (`Surface.plain`) from then on. */
const Q_DYN = 8;

/** A patch's slots grow by this many at a time. */
const GROW = 8;
/** Static patches past this many get a cell index; fewer are all tested every query. */
const INDEX_FROM = 8;
/** Cell (m) of the static index. */
const CELL = 8;
/** A patch wider than this many cells is tested by every query instead of listed per cell. */
const WIDE = 64;
/** Half the plan (m) an unbounded patch's box spans. */
const WORLD = 1e9;

const EMPTY32 = new Float32Array(0);
const EMPTY64 = new Float64Array(0);
/** A patch's plan box scratch (`Surface.nodeBox`): min x, max x, min z, max z. */
const _box = new Float64Array(4);
const EMPTY8 = new Uint8Array(0);

const GRIPS = new Float64Array(SURFACE_IDS.length);
for (let i = 0; i < SURFACE_IDS.length; i++) GRIPS[i] = SURFACES[SURFACE_IDS[i]!].grip;

/** The surface index of asphalt. */
const ASPHALT = 0;

/** A grid patch's data. `heights` are the nodes' frame y (row-major, `nu` wide); the frame's origin is at world (ox, oy, oz). */
type GridSpec = {
  nu: number;
  nv: number;
  /** Node spacing along the frame's x (`step`) and z (`stepV`). */
  step: number;
  stepV: number;
  /** The first node's frame x and z. */
  u0: number;
  v0: number;
  heights: Float32Array;
  ox: number;
  oy: number;
  oz: number;
  /** The frame's x, y and z axes in world, three numbers each (a plan-aligned frame when omitted). */
  axes?: ArrayLike<number>;
  /** The surface counts as under a point at most this far (m) above it. */
  reach: number;
  /** Surface index of the whole patch, or −1 with per-node ids in `surfs`. */
  surface?: number;
  surfs?: Uint8Array;
  /** The road's crease (`centre`, lateral over half width, half width × tan(bank)): the height where all four corners have a lateral. */
  crease?: readonly [Float32Array, Float32Array, Float32Array];
  /** Past the grid: the surface index there and the gaussian hills (x, z, height, radius each) of the base terrain. */
  outside?: { surface: number; hills: Float64Array };
  /** Grip multiplier (1). */
  grip?: number;
  /** > 0: only the disc of this radius about the frame origin. */
  radius?: number;
  /** Lowered by this (m) times the point's `aux`: a roof's crush. */
  drop?: number;
  /** Per-node factor in [0, 1] of the drop (a roof's follow of its crush), laid out as `heights` (1 everywhere when omitted). */
  aux?: Float32Array;
  /** Bound on |height| for a patch whose heights are rewritten in place (read once from `heights` when omitted). */
  hmax?: number;
  /** Answers over the whole plan (the track's terrain: hills past its baked grid), not only over its grid's box. */
  unbounded?: boolean;
};

export class Surface {
  /** True where this surface's sides and ends are walls its scene's own contact parts a body from (the fleet ramps). */
  walls = false;
  count = 0;
  p = new Float64Array(0);
  q = new Int32Array(0);
  /** Per patch: node heights, crease arrays, per-node surface ids, hills past the grid. */
  nodes: Float32Array[] = [];
  centre: Float32Array[] = [];
  lat: Float32Array[] = [];
  drop: Float32Array[] = [];
  surfs: Uint8Array[] = [];
  /** Per patch: per-node factors in [0, 1] (a roof's follow of its crush); empty: 1 everywhere. */
  auxs: Float32Array[] = [];
  hills: Float64Array[] = [];
  /** Per patch whose heights never change (a grid added without `hmax`): the highest its surface stands in each cell (`cellTopsOf`); empty otherwise. */
  cellTops: Float64Array[] = [];
  /** The cell index (built by `seal`, read by the query): per cell the patches listed, and the patches every query tests (`always[0 .. nAlways)`). */
  cellStart = new Int32Array(0);
  cellList = new Int32Array(0);
  always = new Int32Array(0);
  nAlways = 0;
  cx0 = 0;
  cz0 = 0;
  cnx = 0;
  cnz = 0;
  sealed = false;
  /**
   * The plain cells (built by `seal`, read by `find`): where a point's one candidate is a plain grid (`plain`), that patch, else −1
   * (`find` tests every candidate). `plainOne` is it for every point of a surface with no cell index, else `PLAIN_BY_CELL`: per index
   * cell `plainCells`, past the index `plainOutside`.
   */
  plainOne = -1;
  plainOutside = -1;
  plainCells = new Int32Array(0);
  /** The plan raster `staticTop` reads (built on first use): per `RASTER` m square from (`rasterX0`, `rasterZ0`), `rasterNx` wide, the highest any patch but the moving ones stands over it. */
  raster = EMPTY64;
  rasterX0 = 0;
  rasterZ0 = 0;
  rasterNx = 0;
  rasterNz = 0;
  rasterBuilt = false;
  /** Patches whose box or drop changed after the raster was built (a slab top riding its car): read one by one, never rastered. */
  readonly moving: number[] = [];
  /** Static triangle-mesh solids the scene has that are not height fields (the corkscrew's channel walls): world-space vertices and indices. */
  readonly meshes: { vertices: Float32Array; indices: Uint32Array }[] = [];

  /** A new patch of `kind`; returns its index. */
  private addPatch(kind: number): number {
    const i = this.count++;
    if ((i + 1) * P_STRIDE > this.p.length) {
      const cap = i + GROW;
      const p = new Float64Array(cap * P_STRIDE);
      p.set(this.p);
      this.p = p;
      const q = new Int32Array(cap * Q_STRIDE);
      q.set(this.q);
      this.q = q;
    }
    const o = i * P_STRIDE;
    const qo = i * Q_STRIDE;
    this.p.fill(0, o, o + P_STRIDE);
    this.q[qo + Q_KIND] = kind;
    this.q[qo + Q_SURF] = ASPHALT;
    this.q[qo + Q_SURF2] = -1;
    this.q[qo + Q_OWNER] = -1;
    this.q[qo + Q_SOLID] = 1;
    this.p[o + P_REACH] = Infinity;
    this.p[o + P_GRIP] = 1;
    this.nodes[i] = EMPTY32;
    this.centre[i] = EMPTY32;
    this.lat[i] = EMPTY32;
    this.drop[i] = EMPTY32;
    this.surfs[i] = EMPTY8;
    this.auxs[i] = EMPTY32;
    this.hills[i] = EMPTY64;
    this.cellTops[i] = EMPTY64;
    this.sealed = false;
    this.rasterBuilt = false;
    return i;
  }

  /** Whether a body that collides by shape (the ragdoll's world) meets patch `i`; false: it answers height queries only. */
  setSolid(i: number, solid: boolean): void {
    this.q[i * Q_STRIDE + Q_SOLID] = solid ? 1 : 0;
  }

  /** Readies `always` for a query at plan (`x`, `z`) asked by body slot `skip`: every query tests a static surface's alike; the cars' tops list the roofs near the asker (`CarSurfaces`). */
  near(_skip: number, _x: number, _z: number): void {}

  /** A bilinear grid patch; returns its index. */
  addGrid(g: GridSpec): number {
    const i = this.addPatch(GRID);
    const o = i * P_STRIDE;
    const qo = i * Q_STRIDE;
    this.q[qo + Q_NU] = g.nu;
    this.q[qo + Q_NV] = g.nv;
    this.q[qo + Q_SURF] = g.surface ?? ASPHALT;
    this.nodes[i] = g.heights;
    this.p[o + P_U0] = g.u0;
    this.p[o + P_V0] = g.v0;
    this.p[o + P_STEP] = g.step;
    this.p[o + P_STEPV] = g.stepV;
    this.p[o + P_REACH] = g.reach;
    this.p[o + P_GRIP] = g.grip ?? 1;
    this.p[o + P_DROP] = g.drop ?? 0;
    this.p[o + P_RAD2] = g.radius === undefined ? 0 : g.radius * g.radius;
    let hext = g.hmax ?? 0;
    if (g.hmax === undefined) for (let k = 0; k < g.heights.length; k++) hext = Math.max(hext, Math.abs(g.heights[k]!));
    this.p[o + P_HMAX] = hext;
    this.q[qo + Q_UNB] = g.unbounded ? 1 : 0;
    if (g.surfs) this.surfs[i] = g.surfs;
    if (g.aux) this.auxs[i] = g.aux;
    if (g.crease) {
      this.centre[i] = g.crease[0];
      this.lat[i] = g.crease[1];
      this.drop[i] = g.crease[2];
    }
    if (g.outside) {
      this.q[qo + Q_SURF2] = g.outside.surface;
      this.hills[i] = g.outside.hills;
    }
    if (g.hmax === undefined) this.cellTops[i] = cellTopsOf(g.nu, g.nv, g.heights, this.centre[i]!, this.lat[i]!, this.drop[i]!);
    this.setFrame(i, g.ox, g.oy, g.oz, g.axes ?? YAW0);
    return i;
  }

  /** A flat patch at height `h` over the plan rectangle [x0, x1] × [z0, z1], or the disc of `radius` about its middle when > 0. */
  addPlane(h: number, x0: number, x1: number, z0: number, z1: number, reach: number, radius = 0): number {
    const ox = (x0 + x1) / 2;
    const oz = (z0 + z1) / 2;
    return this.addGrid({ nu: 2, nv: 2, step: x1 - x0, stepV: z1 - z0, u0: x0 - ox, v0: z0 - oz, heights: new Float32Array([h, h, h, h]), ox, oy: 0, oz, axes: YAW0, reach, radius: radius > 0 ? radius : undefined });
  }

  /**
   * A rectangle `w` × `d` m, its corner at plan (ox, oz) and turned `yaw` about world y (u along (cos, −sin), v along (sin, cos)),
   * with the heights `h00` at (0, 0), `h10` at (w, 0), `h01` at (0, d) and `h11`: one cell, planar when h11 = h10 + h01 − h00.
   */
  addFace(ox: number, oz: number, yaw: number, w: number, d: number, h00: number, h10: number, h01: number, h11: number, reach: number): number {
    const i = this.addGrid({ nu: 2, nv: 2, step: w, stepV: d, u0: 0, v0: 0, heights: new Float32Array([h00, h10, h01, h11]), ox, oy: 0, oz, axes: YAW0, reach });
    this.setYaw(i, ox, oz, yaw);
    return i;
  }

  /** Face patch `i` (same data) turned `yaw` about its corner at (ox, oz). */
  setYaw(i: number, ox: number, oz: number, yaw: number): void {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    this.setFrame(i, ox, 0, oz, [c, 0, -s, 0, 1, 0, s, 0, c]);
  }

  /** A bridge deck segment (the road's crease form over one path segment); see `deckAt`. */
  addDeck(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, half: number, runL: number, runR: number, bank: number, surface: number, runSurface: number, reach: number): number {
    const i = this.addPatch(DECK);
    const o = i * P_STRIDE;
    const qo = i * Q_STRIDE;
    const P = this.p;
    const ex = x1 - x0;
    const ez = z1 - z0;
    const len2 = ex * ex + ez * ez || 1e-12;
    const len = Math.sqrt(len2);
    P[o + P_OX] = x0;
    P[o + P_OY] = y0;
    P[o + P_OZ] = z0;
    P[o + D_EX] = ex;
    P[o + D_EZ] = ez;
    P[o + D_DY] = y1 - y0;
    P[o + D_LEN2] = len2;
    P[o + D_LEN] = len;
    P[o + D_HALF] = half;
    P[o + D_RUNL] = runL;
    P[o + D_RUNR] = runR;
    P[o + D_TAN] = Math.tan(bank);
    P[o + P_REACH] = reach;
    this.q[qo + Q_SURF] = surface;
    this.q[qo + Q_SURF2] = runSurface;
    // The accepted region: f in [-0.02, 1.02] along the segment and |lat| within the road + run beyond it, boxed with a millimetre to spare.
    const r = half + Math.max(runL, runR) + 0.001;
    const mx = x0 + ex / 2;
    const mz = z0 + ez / 2;
    // A zero-length segment has no direction: it keeps a square of the padded reach.
    const moves = len > 1e-5;
    const bx = moves ? Math.abs(ex) * 0.52 + (Math.abs(ez) / len) * r : r;
    const bz = moves ? Math.abs(ez) * 0.52 + (Math.abs(ex) / len) * r : r;
    P[o + P_MINX] = mx - bx;
    P[o + P_MAXX] = mx + bx;
    P[o + P_MINZ] = mz - bz;
    P[o + P_MAXZ] = mz + bz;
    return i;
  }

  /** Set grid patch `i`'s frame (origin and the x, y, z axes) and its world box. A moving patch (a roof, a placed ramp) is rewritten in place. */
  setFrame(i: number, ox: number, oy: number, oz: number, axes: ArrayLike<number>): void {
    const o = i * P_STRIDE;
    const P = this.p;
    P[o + P_OX] = ox;
    P[o + P_OY] = oy;
    P[o + P_OZ] = oz;
    for (let k = 0; k < 9; k++) P[o + P_AX + k] = axes[k]!;
    this.box(i);
  }

  /** Patch `i`'s plan box over its own extent into `out` (min x, max x, min z, max z): a grid's corners from its frame, node extent (`P_HMAX`) and drop, even an unbounded one's. */
  nodeBox(i: number, out: Float64Array): void {
    const o = i * P_STRIDE;
    const qo = i * Q_STRIDE;
    const P = this.p;
    if (this.q[qo + Q_KIND] === DECK) {
      out[0] = P[o + P_MINX]!;
      out[1] = P[o + P_MAXX]!;
      out[2] = P[o + P_MINZ]!;
      out[3] = P[o + P_MAXZ]!;
      return;
    }
    const ox = P[o + P_OX]!;
    const oz = P[o + P_OZ]!;
    const u0 = P[o + P_U0]!;
    const v0 = P[o + P_V0]!;
    const u1 = u0 + (this.q[qo + Q_NU]! - 1) * P[o + P_STEP]!;
    const v1 = v0 + (this.q[qo + Q_NV]! - 1) * P[o + P_STEPV]!;
    const hmax = Math.max(0, P[o + P_HMAX]!) + Math.abs(P[o + P_DROP]!);
    // The box over the patch's corners (the frame's x and z axes; the roof's height term grows it by the frame's tilt).
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let a = 0; a < 2; a++) {
      for (let b = 0; b < 2; b++) {
        const u = a === 0 ? u0 : u1;
        const v = b === 0 ? v0 : v1;
        minX = Math.min(minX, ox + P[o + P_AX]! * u + P[o + P_CX]! * v);
        maxX = Math.max(maxX, ox + P[o + P_AX]! * u + P[o + P_CX]! * v);
        minZ = Math.min(minZ, oz + P[o + P_AX + 2]! * u + P[o + P_CX + 2]! * v);
        maxZ = Math.max(maxZ, oz + P[o + P_AX + 2]! * u + P[o + P_CX + 2]! * v);
      }
    }
    const tx = Math.abs(P[o + P_BX]!) * hmax;
    const tz = Math.abs(P[o + P_BX + 2]!) * hmax;
    out[0] = minX - tx;
    out[1] = maxX + tx;
    out[2] = minZ - tz;
    out[3] = maxZ + tz;
  }

  /** Grid patch `i`'s world box (`nodeBox`; the whole plan for an unbounded one). */
  private box(i: number): void {
    const o = i * P_STRIDE;
    const P = this.p;
    const unb = this.q[i * Q_STRIDE + Q_UNB] === 1;
    this.nodeBox(i, _box);
    P[o + P_MINX] = unb ? -WORLD : _box[0]!;
    P[o + P_MAXX] = unb ? WORLD : _box[1]!;
    P[o + P_MINZ] = unb ? -WORLD : _box[2]!;
    P[o + P_MAXZ] = unb ? WORLD : _box[3]!;
    this.moved(i);
  }

  /** Patch `i` changed: after the seal no cell reads it as plain (`unplain`); after the raster was built it is read one by one from now on, the raster built again without it. */
  private moved(i: number): void {
    this.unplain(i);
    if (!this.rasterBuilt || this.moving.includes(i)) return;
    this.moving.push(i);
    this.rasterBuilt = false;
  }

  /** Narrow patch `i`'s box (after `setFrame`) to the square of half width `r` about plan (cx, cz): a roof's reach about its car. */
  clipBox(i: number, cx: number, cz: number, r: number): void {
    const o = i * P_STRIDE;
    const P = this.p;
    P[o + P_MINX] = Math.max(P[o + P_MINX]!, cx - r);
    P[o + P_MAXX] = Math.min(P[o + P_MAXX]!, cx + r);
    P[o + P_MINZ] = Math.max(P[o + P_MINZ]!, cz - r);
    P[o + P_MAXZ] = Math.min(P[o + P_MAXZ]!, cz + r);
    this.unplain(i);
  }

  /** Point grid patch `i` at other node data (a slot changing style): `nu` × `nv` nodes `heights` and per-node factors `aux` (both row-major), `hmax` bounding |height|. Keeps the frame. */
  setGridData(i: number, nu: number, nv: number, step: number, stepV: number, u0: number, v0: number, heights: Float32Array, aux: Float32Array, hmax: number): void {
    const o = i * P_STRIDE;
    const qo = i * Q_STRIDE;
    this.q[qo + Q_NU] = nu;
    this.q[qo + Q_NV] = nv;
    this.p[o + P_STEP] = step;
    this.p[o + P_STEPV] = stepV;
    this.p[o + P_U0] = u0;
    this.p[o + P_V0] = v0;
    this.p[o + P_HMAX] = hmax;
    this.nodes[i] = heights;
    this.auxs[i] = aux;
    this.cellTops[i] = EMPTY64;
    this.box(i);
  }

  /** Re-size the one-cell grid patch `i` to the rectangle [u0, u0 + w] × [v0, v0 + d] in its frame, boxed again (a slab top that crumples). */
  setRect(i: number, u0: number, v0: number, w: number, d: number): void {
    const o = i * P_STRIDE;
    this.p[o + P_U0] = u0;
    this.p[o + P_V0] = v0;
    this.p[o + P_STEP] = w;
    this.p[o + P_STEPV] = d;
    this.box(i);
  }

  /** Empty patch `i`'s box: it answers nothing until its frame is set again. */
  disable(i: number): void {
    const o = i * P_STRIDE;
    this.p[o + P_MINX] = Infinity;
    this.p[o + P_MAXX] = -Infinity;
    this.p[o + P_MINZ] = Infinity;
    this.p[o + P_MAXZ] = -Infinity;
    this.moved(i);
  }

  /** Patch `i` is `owner`'s (a car's slot): its own queries skip it. */
  own(i: number, owner: number): void {
    this.q[i * Q_STRIDE + Q_OWNER] = owner;
    this.unplain(i);
  }

  /** Patch `i`'s crush drop (m). */
  setDrop(i: number, drop: number): void {
    this.p[i * P_STRIDE + P_DROP] = drop;
    this.moved(i);
  }

  /** Build the spatial index over the patches' boxes (a scene's static surfaces: once, at registration). Few patches are all tested. */
  seal(): void {
    this.sealed = true;
    this.indexBoxes();
    // The plain cells: the one candidate a plain grid.
    this.plainOutside = this.nAlways === 1 && this.plain(this.always[0]!) ? this.always[0]! : -1;
    if (this.cellList.length === 0) {
      this.plainOne = this.plainOutside;
      return;
    }
    this.plainOne = PLAIN_BY_CELL;
    const cells = this.cellStart.length - 1;
    this.plainCells = new Int32Array(cells);
    for (let c = 0; c < cells; c++) {
      const start = this.cellStart[c]!;
      const listed = this.cellStart[c + 1]! - start;
      if (listed === 0) this.plainCells[c] = this.plainOutside;
      else this.plainCells[c] = listed === 1 && this.nAlways === 0 && this.plain(this.cellList[start]!) ? this.cellList[start]! : -1;
    }
  }

  /**
   * Whether patch `i` is a grid `plainOffer` reads as `offer` does: level and unturned (its frame's x, y and z the world's, its
   * origin's height not −0, so the frame's zero terms change no bit of the height), unbounded (its box the whole plan, so its nodes
   * alone bound it), the world's, no disc, no per-node factors, unchanged since the seal.
   */
  private plain(i: number): boolean {
    const qo = i * Q_STRIDE;
    const o = i * P_STRIDE;
    const P = this.p;
    const level = P[o + P_AX] === 1 && P[o + P_AX + 1] === 0 && P[o + P_AX + 2] === 0 && P[o + P_BX + 1] === 1 && P[o + P_CX] === 0 && P[o + P_CX + 1] === 0 && P[o + P_CX + 2] === 1;
    return level && !Object.is(P[o + P_OY], -0) && this.q[qo + Q_UNB] === 1 && this.q[qo + Q_KIND] === GRID && this.q[qo + Q_DYN] === 0 && this.q[qo + Q_OWNER] === -1 && P[o + P_RAD2] === 0 && this.auxs[i]!.length === 0;
  }

  /** Patch `i` changed after the seal (`Q_DYN`): no cell reads it as plain from then on, every one that did tests its candidates. */
  private unplain(i: number): void {
    const qo = i * Q_STRIDE;
    if (!this.sealed || this.q[qo + Q_DYN] === 1) return;
    this.q[qo + Q_DYN] = 1;
    if (this.plainOne === i) this.plainOne = -1;
    if (this.plainOutside === i) this.plainOutside = -1;
    for (let c = 0; c < this.plainCells.length; c++) if (this.plainCells[c] === i) this.plainCells[c] = -1;
  }

  private indexBoxes(): void {
    const P = this.p;
    if (this.count <= INDEX_FROM) {
      this.always = Int32Array.from({ length: this.count }, (_, i) => i);
      this.nAlways = this.count;
      this.cellStart = new Int32Array(0);
      this.cellList = new Int32Array(0);
      return;
    }
    const wide: number[] = [];
    const local: number[] = [];
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < this.count; i++) {
      const o = i * P_STRIDE;
      if (P[o + P_MAXX]! - P[o + P_MINX]! > WIDE * CELL || P[o + P_MAXZ]! - P[o + P_MINZ]! > WIDE * CELL) {
        wide.push(i);
        continue;
      }
      local.push(i);
      minX = Math.min(minX, P[o + P_MINX]!);
      maxX = Math.max(maxX, P[o + P_MAXX]!);
      minZ = Math.min(minZ, P[o + P_MINZ]!);
      maxZ = Math.max(maxZ, P[o + P_MAXZ]!);
    }
    this.always = Int32Array.from(wide);
    this.nAlways = wide.length;
    if (local.length === 0) return;
    this.cx0 = Math.floor(minX / CELL);
    this.cz0 = Math.floor(minZ / CELL);
    this.cnx = Math.floor(maxX / CELL) - this.cx0 + 1;
    this.cnz = Math.floor(maxZ / CELL) - this.cz0 + 1;
    const cells = this.cnx * this.cnz;
    // Count, then fill: cell c's patches are cellList[cellStart[c] .. cellStart[c + 1]).
    const start = new Int32Array(cells + 1);
    for (const i of local) this.eachCell(i, (c) => start[c + 1]!++);
    for (let c = 0; c < cells; c++) start[c + 1]! += start[c]!;
    const fill = start.slice(0, cells);
    const list = new Int32Array(start[cells]!);
    for (const i of local) this.eachCell(i, (c) => (list[fill[c]!++] = i));
    this.cellStart = start;
    this.cellList = list;
  }

  private eachCell(i: number, fn: (c: number) => void): void {
    const o = i * P_STRIDE;
    const P = this.p;
    const i0 = Math.floor(P[o + P_MINX]! / CELL) - this.cx0;
    const i1 = Math.floor(P[o + P_MAXX]! / CELL) - this.cx0;
    const j0 = Math.floor(P[o + P_MINZ]! / CELL) - this.cz0;
    const j1 = Math.floor(P[o + P_MAXZ]! / CELL) - this.cz0;
    for (let j = j0; j <= j1; j++) for (let k = i0; k <= i1; k++) fn(j * this.cnx + k);
  }
}

const YAW0 = [1, 0, 0, 0, 1, 0, 0, 0, 1] as const;

/** The static surface in force (a scene's ground) and the cars' tops while a step runs; `surf` is `offer`'s best candidate's surface. */
const live: { statics: Surface | null; tops: Surface | null; surf: Surface | null } = { statics: null, tops: null, surf: null };

/** Make `s` the scene's static surface (`null`: none). Sealed on first use. */
export function activate(s: Surface | null): void {
  if (s !== null && !s.sealed) s.seal();
  live.statics = s;
}

/** Arm (or, with `null`, disarm) the dynamic tops: the other cars' roofs a body steps on while a world step runs. */
export function armTops(t: Surface | null): void {
  live.tops = t;
}

/** Whether the scene's static surface has walls its own contact parts a body from. */
export function groundWalls(): boolean {
  return live.statics !== null && live.statics.walls;
}

/**
 * `offer`'s scratch: the best candidate so far (`S_BEST`..`S_AUX`), the candidate being evaluated (`S_CG0`..`S_CAUX`, its height `S_H`:
 * NaN where it has none), one cell's bilinear partials (per cell unit, `S_PU`, `S_PV`, set by `bil`), `cellHeight`'s cell fractions in
 * (`S_TU`, `S_TV`) and height out (`S_CH`) and, for a best `plainOffer` found, the point in its grid (`S_PFU`, `S_PFV`; `S_PFU` −1 for
 * any other best), its node, factor and partials left to `plainRest`.
 */
const _s = new Float64Array(18);
const S_BEST = 0;
const S_PATCH = 1;
const S_G0 = 2;
const S_G1 = 3;
const S_NODE = 4;
const S_AUX = 5;
const S_CG0 = 6;
const S_CG1 = 7;
const S_CN = 8;
const S_CAUX = 9;
const S_PU = 10;
const S_PV = 11;
const S_H = 12;
const S_PFU = 13;
const S_PFV = 14;
const S_TU = 15;
const S_TV = 16;
const S_CH = 17;
/** `Surface.plainOne`: read `Surface.plainCells` per index cell. */
const PLAIN_BY_CELL = -2;

/** What a query works out past the height: also the nearest node (a per-node surface's grip, `heightGrip`), or that and the slopes (`report`'s normal). */
const NEED_HEIGHT = 0;
const NEED_GRIP = 1;
const NEED_ALL = 2;

/** Bilinear value of `f` in cell `c` at (fu, fv). */
function bil(f: Float32Array, c: number, nu: number, fu: number, fv: number): number {
  const a = f[c]! + (f[c + 1]! - f[c]!) * fu;
  const b = f[c + nu]! + (f[c + nu + 1]! - f[c + nu]!) * fu;
  return a + (b - a) * fv;
}

/** `bil`'s partials per cell unit at the cell fractions (`S_TU`, `S_TV`) into `S_PU`, `S_PV`. */
function bilSlopes(f: Float32Array, c: number, nu: number): void {
  const fu = _s[S_TU];
  const fv = _s[S_TV];
  const h00 = f[c]!;
  const h10 = f[c + 1]!;
  const h01 = f[c + nu]!;
  const h11 = f[c + nu + 1]!;
  _s[S_PU] = (1 - fv) * (h10 - h00) + fv * (h11 - h01);
  _s[S_PV] = h01 + (h11 - h01) * fu - (h00 + (h10 - h00) * fu);
}

/** Whether cell `c` of a grid `nu` nodes wide is on the road: its lateral `lat` set (not NaN) at all four corners. */
function creased(lat: Float32Array, c: number, nu: number): boolean {
  return lat.length > 0 && lat[c]! === lat[c]! && lat[c + 1]! === lat[c + 1]! && lat[c + nu]! === lat[c + nu]! && lat[c + nu + 1]! === lat[c + nu + 1]!;
}

/**
 * Grid patch `i`'s height in its frame in cell `c` at the cell fractions (`S_TU`, `S_TV`), `nu` nodes wide, into `S_CH`. On the road
 * (`creased`) the crease: centre height less the (clamped) lateral share of the drop, so the bank's edge stays sharp. In and out
 * through the scratch, so no boxed double crosses the call where V8 leaves it out of line.
 */
function cellHeight(s: Surface, i: number, c: number, nu: number): void {
  const fu = _s[S_TU];
  const fv = _s[S_TV];
  const lat = s.lat[i]!;
  if (!creased(lat, c, nu)) {
    _s[S_CH] = bil(s.nodes[i]!, c, nu, fu, fv);
    return;
  }
  const k = Math.max(-1, Math.min(1, bil(lat, c, nu, fu, fv)));
  _s[S_CH] = bil(s.centre[i]!, c, nu, fu, fv) - k * bil(s.drop[i]!, c, nu, fu, fv);
}

/** `cellHeight`'s partials per cell unit into `S_PU`, `S_PV`, at the same cell and fractions. */
function cellSlopes(s: Surface, i: number, c: number, nu: number): void {
  const lat = s.lat[i]!;
  if (!creased(lat, c, nu)) {
    bilSlopes(s.nodes[i]!, c, nu);
    return;
  }
  const fu = _s[S_TU];
  const fv = _s[S_TV];
  const l = bil(lat, c, nu, fu, fv);
  const k = Math.max(-1, Math.min(1, l));
  const drop = bil(s.drop[i]!, c, nu, fu, fv);
  bilSlopes(lat, c, nu);
  const lu = _s[S_PU];
  const lv = _s[S_PV];
  bilSlopes(s.centre[i]!, c, nu);
  const cu = _s[S_PU];
  const cv = _s[S_PV];
  bilSlopes(s.drop[i]!, c, nu);
  const inside = l > -1 && l < 1;
  _s[S_PU] = cu - k * _s[S_PU] - (inside ? lu * drop : 0);
  _s[S_PV] = cv - k * _s[S_PV] - (inside ? lv * drop : 0);
}

/** The base terrain past a grid: its gaussian hills' height at (x, z), the gradient into `_cg0`/`_cg1` (world plan). */
function hillsAt(h: Float64Array, q: Float64Array): void {
  const x = q[PQ_X]!;
  const z = q[PQ_Z]!;
  let sum = 0;
  let gx = 0;
  let gz = 0;
  for (let k = 0; k < h.length; k += 4) {
    const dx = x - h[k]!;
    const dz = z - h[k + 1]!;
    const r2 = h[k + 3]! * h[k + 3]!;
    const e = h[k + 2]! * Math.exp(-(dx * dx + dz * dz) / r2);
    sum += e;
    gx += (-2 * dx * e) / r2;
    gz += (-2 * dz * e) / r2;
  }
  _s[S_CG0] = gx;
  _s[S_CG1] = gz;
  _s[S_H] = sum;
}

/**
 * Grid patch `i` at (x, z), asked from height `y`: the surface's world height, NaN where it has none. Past `NEED_HEIGHT` sets
 * `_cn` (the nearest node, −1 past the grid), at `NEED_ALL` also `_cg0`/`_cg1` (the surface's partials along the frame's x and z;
 * in world plan past the grid). A patch with per-node factors (`auxs`) lowers by `P_DROP × factor` and leaves the factor in `_caux`
 * (`offer` presets it to 1).
 */
function gridAt(s: Surface, i: number, q: Float64Array, need: number): void {
  const x = q[PQ_X]!;
  const z = q[PQ_Z]!;
  const y = q[PQ_Y]!;
  const P = s.p;
  const o = i * P_STRIDE;
  const dx = x - P[o + P_OX]!;
  const dz = z - P[o + P_OZ]!;
  const rad2 = P[o + P_RAD2]!;
  if (rad2 > 0 && dx * dx + dz * dz > rad2) {
    _s[S_H] = NaN;
    return;
  }
  // The frame's coordinates of the point: its height counts only to a tilted frame (a roof); a plan-aligned one ignores it.
  const dy = y > -1e9 && y < 1e9 ? y - P[o + P_OY]! : 0;
  const lu = P[o + P_AX]! * dx + P[o + P_AX + 1]! * dy + P[o + P_AX + 2]! * dz;
  const lv = P[o + P_CX]! * dx + P[o + P_CX + 1]! * dy + P[o + P_CX + 2]! * dz;
  const step = P[o + P_STEP]!;
  const stepV = P[o + P_STEPV]!;
  const fu = (lu - P[o + P_U0]!) / step;
  const fv = (lv - P[o + P_V0]!) / stepV;
  const qo = i * Q_STRIDE;
  const nu = s.q[qo + Q_NU]!;
  const nv = s.q[qo + Q_NV]!;
  if (fu < 0 || fv < 0 || fu >= nu - 1 || fv >= nv - 1) {
    if (s.q[qo + Q_SURF2]! < 0) {
      _s[S_H] = NaN;
      return;
    }
    _s[S_CN] = -1;
    hillsAt(s.hills[i]!, q);
    _s[S_H] = P[o + P_OY]! + _s[S_H]!;
    return;
  }
  const ci = Math.floor(fu);
  const cj = Math.floor(fv);
  const c = (cj | 0) * nu + (ci | 0);
  const tu = fu - ci;
  const tv = fv - cj;
  const slopes = need === NEED_ALL;
  _s[S_TU] = tu;
  _s[S_TV] = tv;
  cellHeight(s, i, c, nu);
  let h = _s[S_CH];
  if (slopes) {
    cellSlopes(s, i, c, nu);
    _s[S_CG0] = _s[S_PU] / step;
    _s[S_CG1] = _s[S_PV] / stepV;
  }
  // Math.round of fv and fu (halves up): the cell's corner plus one where the fraction reaches a half.
  if (need !== NEED_HEIGHT) _s[S_CN] = (cj + (tv >= 0.5 ? 1 : 0)) * nu + ci + (tu >= 0.5 ? 1 : 0);
  const aux = s.auxs[i]!;
  if (aux.length > 0) _s[S_CAUX] = bil(aux, c, nu, tu, tv);
  h -= P[o + P_DROP]! * _s[S_CAUX];
  // The surface point's world height: the frame's origin plus its local x, y and z along the axes' y components.
  _s[S_H] = P[o + P_OY]! + P[o + P_AX + 1]! * lu + P[o + P_BX + 1]! * h + P[o + P_CX + 1]! * lv;
}

/** How far (share of its length) a deck segment answers past either end, so consecutive segments meet without a seam. */
const DECK_OVERRUN = 0.02;

/** A bridge deck segment at (x, z): its height, NaN off it. Sets `_cg0`/`_cg1` (the height's world-plan partials) and `_cn` (0 the road, 1 its run). */
function deckAt(s: Surface, i: number, q: Float64Array): void {
  const x = q[PQ_X]!;
  const z = q[PQ_Z]!;
  const P = s.p;
  const o = i * P_STRIDE;
  const ex = P[o + D_EX]!;
  const ez = P[o + D_EZ]!;
  const len2 = P[o + D_LEN2]!;
  const len = P[o + D_LEN]!;
  const x0 = P[o + P_OX]!;
  const z0 = P[o + P_OZ]!;
  const f = ((x - x0) * ex + (z - z0) * ez) / len2;
  if (f < -DECK_OVERRUN || f > 1 + DECK_OVERRUN) {
    _s[S_H] = NaN;
    return;
  }
  const lat = ((x - x0) * ez - (z - z0) * ex) / len;
  const half = P[o + D_HALF]!;
  const run = lat > 0 ? P[o + D_RUNL]! : P[o + D_RUNR]!;
  if (Math.abs(lat) > half + run) {
    _s[S_H] = NaN;
    return;
  }
  const tan = P[o + D_TAN]!;
  const inside = Math.abs(lat) < half;
  _s[S_CG0] = (P[o + D_DY]! * ex) / len2 - (inside ? (tan * ez) / len : 0);
  _s[S_CG1] = (P[o + D_DY]! * ez) / len2 + (inside ? (tan * ex) / len : 0);
  _s[S_CN] = Math.abs(lat) <= half ? 0 : 1;
  _s[S_H] = P[o + P_OY]! + P[o + D_DY]! * f - Math.max(-half, Math.min(half, lat)) * tan;
}

/** Test patch `i` of `s` for the point, working out what `need` asks; a candidate that reaches and is the highest so far becomes the best. */
function offer(s: Surface, i: number, q: Float64Array, skip: number, need: number): void {
  const P = s.p;
  const o = i * P_STRIDE;
  const x = q[PQ_X]!;
  const z = q[PQ_Z]!;
  if (x < P[o + P_MINX]! || x > P[o + P_MAXX]! || z < P[o + P_MINZ]! || z > P[o + P_MAXZ]!) return;
  const qo = i * Q_STRIDE;
  const owner = s.q[qo + Q_OWNER]!;
  // A car's own roof is not under it, nor is the roof of a car whose origin is higher (two cars standing on each other lifted one another 1.5 m a frame).
  if (owner >= 0 && (owner === skip || (skip >= 0 && skip < s.count && P[o + P_OY]! > P[skip * P_STRIDE + P_OY]!))) return;
  _s[S_CAUX] = 1;
  if (s.q[qo + Q_KIND] === DECK) deckAt(s, i, q);
  else gridAt(s, i, q, need);
  const h = _s[S_H]!;
  // NaN (no surface) fails the first test; an unlimited reach under an asker at -Infinity is NaN and passes the second.
  const y = q[PQ_Y]!;
  if (h !== h || h > y + P[o + P_REACH]! || h < _s[S_BEST]) return;
  _s[S_BEST] = h;
  live.surf = s;
  _s[S_PATCH] = i;
  _s[S_G0] = _s[S_CG0];
  _s[S_G1] = _s[S_CG1];
  _s[S_NODE] = _s[S_CN];
  _s[S_AUX] = _s[S_CAUX];
  _s[S_PFU] = -1;
}

/**
 * `offer` and `gridAt` for plain grid patch `i` of `s` (`Surface.plain`), the point's one candidate on `s` and the query's first (`find`
 * on the static surface right after the best is reset, so any height that reaches is the best): the same height to the bit, the point
 * in its grid kept for `plainRest`. False past the grid's nodes (its base terrain's hills), where `offer` answers.
 */
function plainOffer(s: Surface, i: number, q: Float64Array): boolean {
  const P = s.p;
  const o = i * P_STRIDE;
  const qo = i * Q_STRIDE;
  const fu = (q[PQ_X]! - P[o + P_OX]! - P[o + P_U0]!) / P[o + P_STEP]!;
  const fv = (q[PQ_Z]! - P[o + P_OZ]! - P[o + P_V0]!) / P[o + P_STEPV]!;
  const nu = s.q[qo + Q_NU]!;
  if (fu < 0 || fv < 0 || fu >= nu - 1 || fv >= s.q[qo + Q_NV]! - 1) return false;
  const ci = Math.floor(fu);
  const cj = Math.floor(fv);
  _s[S_TU] = fu - ci;
  _s[S_TV] = fv - cj;
  cellHeight(s, i, (cj | 0) * nu + (ci | 0), nu);
  const h = P[o + P_OY]! + (_s[S_CH] - P[o + P_DROP]!);
  if (h !== h || h > q[PQ_Y]! + P[o + P_REACH]!) return true;
  _s[S_BEST] = h;
  live.surf = s;
  _s[S_PATCH] = i;
  _s[S_PFU] = fu;
  _s[S_PFV] = fv;
  return true;
}

/**
 * A best candidate `plainOffer` found on `w`: its nearest node and factor and, with `slopes`, its partials into the scratch as `offer`
 * sets them at `NEED_GRIP` / `NEED_ALL`.
 */
function plainRest(w: Surface, slopes: boolean): void {
  const i = _s[S_PATCH];
  const o = i * P_STRIDE;
  const nu = w.q[i * Q_STRIDE + Q_NU]!;
  const fu = _s[S_PFU];
  const fv = _s[S_PFV];
  const ci = Math.floor(fu);
  const cj = Math.floor(fv);
  const tu = fu - ci;
  const tv = fv - cj;
  _s[S_NODE] = (cj + (tv >= 0.5 ? 1 : 0)) * nu + ci + (tu >= 0.5 ? 1 : 0);
  _s[S_AUX] = 1;
  if (!slopes) return;
  _s[S_TU] = tu;
  _s[S_TV] = tv;
  cellSlopes(w, i, (cj | 0) * nu + (ci | 0), nu);
  _s[S_G0] = _s[S_PU] / w.p[o + P_STEP]!;
  _s[S_G1] = _s[S_PV] / w.p[o + P_STEPV]!;
}

/** The plain grid that is the point's one candidate on `s` by index cell (`Surface.plainCells`, past the index `plainOutside`), else −1. */
function plainCell(s: Surface, q: Float64Array): number {
  const ci = Math.floor(q[PQ_X]! / CELL) - s.cx0;
  const cj = Math.floor(q[PQ_Z]! / CELL) - s.cz0;
  return ci < 0 || cj < 0 || ci >= s.cnx || cj >= s.cnz ? s.plainOutside : s.plainCells[cj * s.cnx + ci]!;
}

/** The highest surface at the point over `s`'s patches, into the best-candidate scratch (`need`: what to work out past its height). */
function find(s: Surface, q: Float64Array, skip: number, need: number): void {
  const i = s.plainOne === PLAIN_BY_CELL ? plainCell(s, q) : s.plainOne;
  if (i < 0 || !plainOffer(s, i, q)) offerAll(s, q, skip, need);
}

/** `find` over every candidate patch. */
function offerAll(s: Surface, q: Float64Array, skip: number, need: number): void {
  const always = s.always;
  for (let k = 0; k < s.nAlways; k++) offer(s, always[k]!, q, skip, need);
  if (s.cellList.length === 0) return;
  const ci = Math.floor(q[PQ_X]! / CELL) - s.cx0;
  const cj = Math.floor(q[PQ_Z]! / CELL) - s.cz0;
  if (ci < 0 || cj < 0 || ci >= s.cnx || cj >= s.cnz) return;
  const c = cj * s.cnx + ci;
  for (let k = s.cellStart[c]!; k < s.cellStart[c + 1]!; k++) offer(s, s.cellList[k]!, q, skip, need);
}

/** `out`'s height and normal (`C_H`, `C_NX`..`C_NZ`) at the best candidate: height `-Infinity` and straight up where there is none. */
function normalOf(out: Float64Array): void {
  const w = live.surf;
  if (w === null) {
    out[C_H] = NONE;
    out[C_NX] = 0;
    out[C_NY] = 1;
    out[C_NZ] = 0;
    return;
  }
  if (_s[S_PFU] >= 0) plainRest(w, true);
  const P = w.p;
  const o = _s[S_PATCH] * P_STRIDE;
  out[C_H] = _s[S_BEST];
  if (w.q[_s[S_PATCH] * Q_STRIDE + Q_KIND] === DECK || _s[S_NODE] < 0) {
    // Partials in world plan.
    const len = hypot3(_s[S_G0], 1, _s[S_G1]);
    out[C_NX] = -_s[S_G0] / len;
    out[C_NY] = 1 / len;
    out[C_NZ] = -_s[S_G1] / len;
  } else {
    // Partials along the frame's x and z: the normal is (−gx, 1, −gz) in the frame, turned into world.
    const nx = -_s[S_G0] * P[o + P_AX]! + P[o + P_BX]! - _s[S_G1] * P[o + P_CX]!;
    const ny = -_s[S_G0] * P[o + P_AX + 1]! + P[o + P_BX + 1]! - _s[S_G1] * P[o + P_CX + 1]!;
    const nz = -_s[S_G0] * P[o + P_AX + 2]! + P[o + P_BX + 2]! - _s[S_G1] * P[o + P_CX + 2]!;
    const len = hypot3(nx, ny, nz);
    out[C_NX] = nx / len;
    out[C_NY] = ny / len;
    out[C_NZ] = nz / len;
  }
}

/**
 * `out` = [height, nx, ny, nz, grip, surface index, owner (−1 the world's, else a car's slot), patch, aux] of the best candidate
 * (aux: the patch's per-node factor there, 1 without one); height `-Infinity` and grip 0 where there is none.
 */
function report(out: Float64Array): void {
  normalOf(out);
  const w = live.surf;
  if (w === null) {
    out[C_GRIP] = 0;
    out[C_SURF] = ASPHALT;
    out[C_OWNER] = -1;
    out[C_ARG] = -1;
    out[C_AUX] = 1;
    return;
  }
  const qo = _s[S_PATCH] * Q_STRIDE;
  const surf = bestSurf(w, qo, w.q[qo + Q_KIND] === DECK);
  out[C_SURF] = surf;
  out[C_GRIP] = w.p[_s[S_PATCH] * P_STRIDE + P_GRIP]! * GRIPS[surf]!;
  out[C_OWNER] = w.q[qo + Q_OWNER]!;
  out[C_ARG] = _s[S_PATCH];
  out[C_AUX] = _s[S_AUX];
}

/** The surface index of the best candidate, a patch of `w` (`qo`: its `q` offset; `deck`: a deck segment). */
function bestSurf(w: Surface, qo: number, deck: boolean): number {
  const surf = w.q[qo + Q_SURF]!;
  if (deck) return _s[S_NODE] !== 0 ? w.q[qo + Q_SURF2]! : surf;
  if (surf < 0) return _s[S_NODE] >= 0 ? w.surfs[_s[S_PATCH]]![_s[S_NODE]]! : w.q[qo + Q_SURF2]!;
  return _s[S_NODE] < 0 ? w.q[qo + Q_SURF2]! : surf;
}

/** `contactIn`'s grip (`C_GRIP`) at what the last `heightIn` asked `grip` found, its normal never worked out; 0 where it found nothing. */
export function heightGrip(): number {
  const w = live.surf;
  if (w === null) return 0;
  if (_s[S_PFU] >= 0) plainRest(w, false);
  const qo = _s[S_PATCH] * Q_STRIDE;
  return w.p[_s[S_PATCH] * P_STRIDE + P_GRIP]! * GRIPS[bestSurf(w, qo, w.q[qo + Q_KIND] === DECK)]!;
}

/** The asked point of a query, in the typed array a caller passes: world x, z and the asking height y (no boxed doubles cross the call). */
export const PQ_X = 0;
export const PQ_Z = 1;
export const PQ_Y = 2;
export const PQ_SIZE = 3;

/**
 * The surface at plan (x, z) of the query point `q` (`PQ_X`, `PQ_Z`, `PQ_Y`) under a body asking from height y (`Infinity`: the
 * top surface): the highest one of the scene's static surface and the armed car tops that is at most its patch's reach above y,
 * into `out` (see `report`). `skip` is the slot the body is itself (its own roof is not under it, nor is a roof of a car higher
 * than it), −1 none.
 */
export function pointContact(q: Float64Array, skip: number, out: Float64Array): void {
  seekAll(q, skip);
  report(out);
}

/** No car tops to ask. */
const NO_TOPS = new Int32Array(0);

/**
 * `pointContact` up to its report, over the static surface and patches `list[0..count)` of the car tops `tops` (`null`: none):
 * the best candidate into the scratch (`report` reads it); a footprint or edge sample needs its whole contact only when it is the highest yet.
 */
function seek(q: Float64Array, skip: number, tops: Surface | null, list: Int32Array, count: number): void {
  _s[S_BEST] = NONE;
  live.surf = null;
  if (live.statics !== null) find(live.statics, q, skip, NEED_ALL);
  if (tops !== null) for (let k = 0; k < count; k++) offer(tops, list[k]!, q, skip, NEED_ALL);
}

/** `seek` over every top near the asker `skip`. */
function seekAll(q: Float64Array, skip: number): void {
  const t = live.tops;
  if (t !== null) t.near(skip, q[PQ_X]!, q[PQ_Z]!);
  seek(q, skip, t, t?.always ?? NO_TOPS, t?.nAlways ?? 0);
}

/** `patchOf` the contact `seek` found would report. */
function seekPatch(): number {
  const w = live.surf;
  return w === null ? -1 * 1e6 + -1 : w.q[_s[S_PATCH] * Q_STRIDE + Q_OWNER]! * 1e6 + _s[S_PATCH];
}

/** `pointContact` over one surface alone: no other static and no car tops (a `Ground`'s own point queries). */
export function contactIn(s: Surface, q: Float64Array, out: Float64Array): void {
  look(s, q, NEED_ALL);
  report(out);
}

/** `contactIn`'s height alone (`C_H`), its normal, grip and owner never worked out; with `grip`, `heightGrip` then reads the grip there. */
export function heightIn(s: Surface, q: Float64Array, grip = false): number {
  return look(s, q, grip ? NEED_GRIP : NEED_HEIGHT);
}

/** The best candidate over `s` alone into the scratch, working out what `need` asks past its height; returns that height. */
function look(s: Surface, q: Float64Array, need: number): number {
  _s[S_BEST] = NONE;
  live.surf = null;
  if (!s.sealed) s.seal();
  find(s, q, -1, need);
  return _s[S_BEST];
}

// The tyre's footprint (wheel frame: axle x, then the rolling plane's y and z; at wheel scale 1): the drawn tyre's five tread rings
// (`TYRE_PROFILE`, car-materials.ts: the crown, its two edges and both shoulders), each over its lower half in `STEPS` arcs a side. A
// tyre rolling off a face's edge rests on the edge with whichever ring and arc still reach it, up to its hub's height, so its hub comes
// down that arc as the drawn tyre does. The whole tyre turns with the body, so a rolled or pitched car's tread meets the ground where
// the drawn tyre does. Where no patch ends within the tyre's reach (`edgeIn`) the rings' bottoms, turned to face the surface, are the
// whole footprint (`BASE`): over one patch's surface the arcs add nothing but queries.
const RINGS: readonly (readonly [number, number])[] = [
  [0, 0.32],
  [0.082, 0.314],
  [-0.082, 0.314],
  [0.104, 0.298],
  [-0.104, 0.298],
];
const STEPS = 12;
const FOOT = RINGS.length * (2 * STEPS + 1);
/**
 * The footprint's first points, every ring's bottom, hold the tread's lowest point over one plane at any tilt: tilted φ across the axle
 * (up to π/2, a rolled car's tyre on its sidewall) the tread's lowest point is the bottom of the ring with the greatest
 * |x| sin φ + r cos φ, and an outer ring takes over from the one inside it at tan φ = Δr / Δ|x|: the crown leads to 4.2°, the edges
 * to 36.0°, the shoulders past that, so none of the five is spare. The crown's alone sank the drawn tyre's edge 2.2 cm on the stunt
 * course's 17° bank; without the shoulders a corkscrew roll at 27 m/s came down on its wheels instead of its roof.
 */
const BASE = RINGS.length;
const FX = new Float64Array(FOOT);
const FY = new Float64Array(FOOT);
const FZ = new Float64Array(FOOT);
/** Arcs per ring, and the footprint index of ring s's arc k at `s * ARCS + k + STEPS`. */
const ARCS = 2 * STEPS + 1;
const KOF = new Int16Array(FOOT);
/** Footprint point `at` as ring `ring`'s arc `k`; returns the next point's index. */
function arc(at: number, ring: number, k: number): number {
  const a = (k / STEPS) * (Math.PI / 2);
  FX[at] = RINGS[ring]![0];
  FY[at] = -RINGS[ring]![1] * Math.cos(a);
  FZ[at] = RINGS[ring]![1] * Math.sin(a);
  KOF[ring * ARCS + k + STEPS] = at;
  return at + 1;
}
{
  let at = 0;
  for (let s = 0; s < RINGS.length; s++) at = arc(at, s, 0);
  for (let k = -STEPS; k <= STEPS; k++) {
    for (let s = 0; s < RINGS.length; s++) if (k !== 0) at = arc(at, s, k);
  }
}
/** How far (m at wheel scale 1, plan) a footprint point reaches from its hub, with a margin for the body's tilt. */
const FOOT_REACH = 0.4;

/**
 * Whether patch `i` of `s` ends within the tyre's reach (`FOOT_REACH` at the `_foot` scale, m plan) of the query point `q` (`skip`: the
 * asking car's slot, as `offer`).
 */
function endsNear(s: Surface, i: number, q: Float64Array, skip: number): boolean {
  const x = q[PQ_X]!;
  const z = q[PQ_Z]!;
  const y = q[PQ_Y]!;
  const r = FOOT_REACH * _foot[FOOT_SCALE]!;
  const P = s.p;
  const o = i * P_STRIDE;
  if (x < P[o + P_MINX]! - r || x > P[o + P_MAXX]! + r || z < P[o + P_MINZ]! - r || z > P[o + P_MAXZ]! + r) return false;
  const qo = i * Q_STRIDE;
  const owner = s.q[qo + Q_OWNER]!;
  // A car's top ends inside its grid (the plate is NaN past the body's plan).
  if (owner >= 0) return owner !== skip;
  const dx = x - P[o + P_OX]!;
  const dz = z - P[o + P_OZ]!;
  if (s.q[qo + Q_KIND] === DECK) {
    const len = P[o + D_LEN]!;
    const along = (dx * P[o + D_EX]! + dz * P[o + D_EZ]!) / len;
    const lat = (dx * P[o + D_EZ]! - dz * P[o + D_EX]!) / len;
    const side = P[o + D_HALF]! + (lat > 0 ? P[o + D_RUNR]! : P[o + D_RUNL]!);
    return along < r || along > len - r || Math.abs(Math.abs(lat) - side) < r;
  }
  const rad2 = P[o + P_RAD2]!;
  if (rad2 > 0) return Math.abs(Math.sqrt(dx * dx + dz * dz) - Math.sqrt(rad2)) < r;
  const dy = y > -1e9 && y < 1e9 ? y - P[o + P_OY]! : 0;
  const lu = P[o + P_AX]! * dx + P[o + P_AX + 1]! * dy + P[o + P_AX + 2]! * dz;
  const lv = P[o + P_CX]! * dx + P[o + P_CX + 1]! * dy + P[o + P_CX + 2]! * dz;
  const u0 = P[o + P_U0]!;
  const v0 = P[o + P_V0]!;
  const u1 = u0 + (s.q[qo + Q_NU]! - 1) * P[o + P_STEP]!;
  const v1 = v0 + (s.q[qo + Q_NV]! - 1) * P[o + P_STEPV]!;
  if (lu < u0 - r || lu > u1 + r || lv < v0 - r || lv > v1 + r) return false;
  return lu < u0 + r || lu > u1 - r || lv < v0 + r || lv > v1 - r;
}

/** Whether any patch of `s` ends within the tyre's reach of the query point `q` (`endsNear`): every cell the reach spans, and the patches every query tests. */
function edgeIn(s: Surface, q: Float64Array, skip: number): boolean {
  for (let k = 0; k < s.nAlways; k++) if (endsNear(s, s.always[k]!, q, skip)) return true;
  if (s.cellList.length === 0) return false;
  const x = q[PQ_X]!;
  const z = q[PQ_Z]!;
  const r = FOOT_REACH * _foot[FOOT_SCALE]!;
  const i0 = Math.max(0, Math.floor((x - r) / CELL) - s.cx0);
  const i1 = Math.min(s.cnx - 1, Math.floor((x + r) / CELL) - s.cx0);
  const j0 = Math.max(0, Math.floor((z - r) / CELL) - s.cz0);
  const j1 = Math.min(s.cnz - 1, Math.floor((z + r) / CELL) - s.cz0);
  for (let cj = j0; cj <= j1; cj++) {
    for (let ci = i0; ci <= i1; ci++) {
      const c = cj * s.cnx + ci;
      for (let k = s.cellStart[c]!; k < s.cellStart[c + 1]!; k++) if (endsNear(s, s.cellList[k]!, q, skip)) return true;
    }
  }
  return false;
}

/** Slack (m) on a height bound: the bilinear reading rounds up to a few ulps past its highest node. */
const TOP_SLACK = 1e-9;

/**
 * Per cell of a grid (row-major, `nu - 1` wide) the highest its surface stands in its frame, -Infinity where it has none: its nodes'
 * bilinear (`gridAt`), or the crease where all four corners have a lateral: the centre less the clamped lateral share of the drop,
 * its highest of the four products of the lateral's and the drop's extremes over the cell.
 */
function cellTopsOf(nu: number, nv: number, nodes: Float32Array, centre: Float32Array, lat: Float32Array, drop: Float32Array): Float64Array {
  const tops = new Float64Array((nu - 1) * (nv - 1));
  const corners = [0, 1, nu, nu + 1];
  for (let cj = 0; cj < nv - 1; cj++) {
    for (let ci = 0; ci < nu - 1; ci++) {
      const c = cj * nu + ci;
      let top = -Infinity;
      const creased = lat.length > 0 && corners.every((k) => !Number.isNaN(lat[c + k]!));
      if (creased) {
        let latLow = Infinity;
        let latHigh = -Infinity;
        let dropLow = Infinity;
        let dropHigh = -Infinity;
        for (const k of corners) {
          top = Math.max(top, centre[c + k]!);
          latLow = Math.min(latLow, Math.max(-1, Math.min(1, lat[c + k]!)));
          latHigh = Math.max(latHigh, Math.max(-1, Math.min(1, lat[c + k]!)));
          dropLow = Math.min(dropLow, drop[c + k]!);
          dropHigh = Math.max(dropHigh, drop[c + k]!);
        }
        top += Math.max(-latLow * dropLow, -latLow * dropHigh, -latHigh * dropLow, -latHigh * dropHigh);
      } else {
        for (const k of corners) if (nodes[c + k]! > top) top = nodes[c + k]!;
      }
      tops[cj * (nu - 1) + ci] = top + TOP_SLACK;
    }
  }
  return tops;
}

/**
 * The highest patch `i` of `s` stands anywhere over the plan box [xMin, xMax] × [zMin, zMax] (m, world y; -Infinity: nowhere there):
 * a level frame with fixed heights reads its cells under the box (`cellTops`), any other its whole extent (a crease or hills on one:
 * unbounded).
 */
function patchTop(s: Surface, i: number, xMin: number, xMax: number, zMin: number, zMax: number, skip: number): number {
  const P = s.p;
  const o = i * P_STRIDE;
  if (xMax < P[o + P_MINX]! || xMin > P[o + P_MAXX]! || zMax < P[o + P_MINZ]! || zMin > P[o + P_MAXZ]!) return -Infinity;
  const qo = i * Q_STRIDE;
  if (skip >= 0 && s.q[qo + Q_OWNER] === skip) return -Infinity;
  const originY = P[o + P_OY]!;
  if (s.q[qo + Q_KIND] === DECK) return originY + Math.abs(P[o + D_DY]!) * (1 + DECK_OVERRUN) + P[o + D_HALF]! * Math.abs(P[o + D_TAN]!) + TOP_SLACK;
  const step = P[o + P_STEP]!;
  const stepV = P[o + P_STEPV]!;
  const nu = s.q[qo + Q_NU]!;
  const nv = s.q[qo + Q_NV]!;
  const raised = Math.max(0, -P[o + P_DROP]!);
  const tops = s.cellTops[i]!;
  if (tops.length === 0 || P[o + P_BX + 1] !== 1) {
    if (s.lat[i]!.length > 0 || s.q[qo + Q_SURF2]! >= 0) return Infinity;
    const u0 = P[o + P_U0]!;
    const v0 = P[o + P_V0]!;
    const farU = Math.max(Math.abs(u0), Math.abs(u0 + (nu - 1) * step));
    const farV = Math.max(Math.abs(v0), Math.abs(v0 + (nv - 1) * stepV));
    const heightBound = Math.max(0, P[o + P_HMAX]!) + raised;
    return originY + Math.abs(P[o + P_AX + 1]!) * farU + Math.abs(P[o + P_BX + 1]!) * heightBound + Math.abs(P[o + P_CX + 1]!) * farV + TOP_SLACK;
  }
  // The box's corners in the level frame: each frame axis in plan reaches its least and greatest along the box's matching corners.
  const ax = P[o + P_AX]!;
  const az = P[o + P_AX + 2]!;
  const cx = P[o + P_CX]!;
  const cz = P[o + P_CX + 2]!;
  const dxMin = xMin - P[o + P_OX]!;
  const dxMax = xMax - P[o + P_OX]!;
  const dzMin = zMin - P[o + P_OZ]!;
  const dzMax = zMax - P[o + P_OZ]!;
  const u0 = P[o + P_U0]!;
  const v0 = P[o + P_V0]!;
  const fuMin = (ax * (ax >= 0 ? dxMin : dxMax) + az * (az >= 0 ? dzMin : dzMax) - u0) / step;
  const fuMax = (ax * (ax >= 0 ? dxMax : dxMin) + az * (az >= 0 ? dzMax : dzMin) - u0) / step;
  const fvMin = (cx * (cx >= 0 ? dxMin : dxMax) + cz * (cz >= 0 ? dzMin : dzMax) - v0) / stepV;
  const fvMax = (cx * (cx >= 0 ? dxMax : dxMin) + cz * (cz >= 0 ? dzMax : dzMin) - v0) / stepV;
  let top = -Infinity;
  if ((fuMin < 0 || fvMin < 0 || fuMax >= nu - 1 || fvMax >= nv - 1) && s.q[qo + Q_SURF2]! >= 0) {
    const hills = s.hills[i]!;
    top = TOP_SLACK;
    for (let k = 2; k < hills.length; k += 4) top += Math.max(0, hills[k]!);
  }
  const i0 = Math.max(0, Math.floor(fuMin));
  const i1 = Math.min(nu - 2, Math.floor(fuMax));
  const j0 = Math.max(0, Math.floor(fvMin));
  const j1 = Math.min(nv - 2, Math.floor(fvMax));
  for (let cj = j0; cj <= j1; cj++) {
    for (let c = cj * (nu - 1) + i0; c <= cj * (nu - 1) + i1; c++) if (tops[c]! > top) top = tops[c]!;
  }
  return originY + top + raised;
}

/** The highest any patch of `s` but those in `except` stands over the plan box (m, world y; -Infinity: nothing there), patch by patch. */
function topIn(s: Surface, xMin: number, xMax: number, zMin: number, zMax: number, except: readonly number[]): number {
  if (!s.sealed) s.seal();
  let top = -Infinity;
  for (let k = 0; k < s.nAlways; k++) if (!except.includes(s.always[k]!)) top = Math.max(top, patchTop(s, s.always[k]!, xMin, xMax, zMin, zMax, -1));
  if (s.cellList.length === 0) return top;
  const i0 = Math.max(0, Math.floor(xMin / CELL) - s.cx0);
  const i1 = Math.min(s.cnx - 1, Math.floor(xMax / CELL) - s.cx0);
  const j0 = Math.max(0, Math.floor(zMin / CELL) - s.cz0);
  const j1 = Math.min(s.cnz - 1, Math.floor(zMax / CELL) - s.cz0);
  for (let cj = j0; cj <= j1; cj++) {
    for (let ci = i0; ci <= i1; ci++) {
      const c = cj * s.cnx + ci;
      for (let k = s.cellStart[c]!; k < s.cellStart[c + 1]!; k++) if (!except.includes(s.cellList[k]!)) top = Math.max(top, patchTop(s, s.cellList[k]!, xMin, xMax, zMin, zMax, -1));
    }
  }
  return top;
}

/** Raster cell (m): a static surface's height bounds are kept per square of this side, aligned to whole metres. */
const RASTER = 1;
/** A patch wider than this (m) is no part of the raster's extent (a scene's endless plane): its bound still is of every cell's. */
const RASTER_SPAN = 4096;
/** The most cells a raster takes; a larger extent keeps none (every bound read patch by patch). */
const RASTER_MAX_CELLS = 1 << 22;
/** A raster cell reads the patches over its square shrunk by this much (m) on its far sides, so a cell-aligned grid's neighbour cells stay out. */
const RASTER_EDGE = 1e-9;
const NO_PATCHES: readonly number[] = [];

/** Build `s`'s raster (`Surface.raster`) over its patches' plan extent, the moving ones left out (`staticTop` tests them one by one). */
function buildRaster(s: Surface): void {
  if (!s.sealed) s.seal();
  s.rasterBuilt = true;
  s.raster = EMPTY64;
  s.rasterNx = 0;
  s.rasterNz = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < s.count; i++) {
    if (s.moving.includes(i)) continue;
    s.nodeBox(i, _box);
    if (_box[1]! - _box[0]! > RASTER_SPAN || _box[3]! - _box[2]! > RASTER_SPAN) continue;
    minX = Math.min(minX, _box[0]!);
    maxX = Math.max(maxX, _box[1]!);
    minZ = Math.min(minZ, _box[2]!);
    maxZ = Math.max(maxZ, _box[3]!);
  }
  if (!(maxX >= minX && maxZ >= minZ)) return;
  const x0 = Math.floor(minX / RASTER) * RASTER;
  const z0 = Math.floor(minZ / RASTER) * RASTER;
  const nx = Math.floor((maxX - x0) / RASTER) + 1;
  const nz = Math.floor((maxZ - z0) / RASTER) + 1;
  if (nx * nz > RASTER_MAX_CELLS) return;
  const raster = new Float64Array(nx * nz);
  for (let cj = 0; cj < nz; cj++) {
    for (let ci = 0; ci < nx; ci++) {
      const x = x0 + ci * RASTER;
      const z = z0 + cj * RASTER;
      raster[cj * nx + ci] = topIn(s, x, x + RASTER - RASTER_EDGE, z, z + RASTER - RASTER_EDGE, s.moving);
    }
  }
  s.raster = raster;
  s.rasterX0 = x0;
  s.rasterZ0 = z0;
  s.rasterNx = nx;
  s.rasterNz = nz;
}

/**
 * The highest the static surface `s` stands over the plan box [xMin, xMax] × [zMin, zMax] (m, world y; -Infinity: nothing there): a body
 * above it meets nothing of `s`. Read off its raster, the patches that moved since tested one by one; past the raster, patch by patch,
 * or with `cellsOnly` no bound at all (Infinity): the raster's answer never falls as the box grows, the patch by patch one can.
 */
export function staticTop(s: Surface, xMin: number, xMax: number, zMin: number, zMax: number, cellsOnly = false): number {
  if (!s.rasterBuilt) buildRaster(s);
  const i0 = Math.floor((xMin - s.rasterX0) / RASTER);
  const i1 = Math.floor((xMax - s.rasterX0) / RASTER);
  const j0 = Math.floor((zMin - s.rasterZ0) / RASTER);
  const j1 = Math.floor((zMax - s.rasterZ0) / RASTER);
  if (i0 < 0 || j0 < 0 || i1 >= s.rasterNx || j1 >= s.rasterNz) return cellsOnly ? Infinity : topIn(s, xMin, xMax, zMin, zMax, NO_PATCHES);
  const raster = s.raster;
  const nx = s.rasterNx;
  let top = -Infinity;
  for (let cj = j0; cj <= j1; cj++) {
    for (let c = cj * nx + i0; c <= cj * nx + i1; c++) if (raster[c]! > top) top = raster[c]!;
  }
  const moving = s.moving;
  for (let k = 0; k < moving.length; k++) top = Math.max(top, patchTop(s, moving[k]!, xMin, xMax, zMin, zMax, -1));
  return top;
}

/** The highest the car tops near body `skip` (`CarSurfaces.near`) stand over the plan box (m, world y; -Infinity: none there). */
export function topsTop(skip: number, xMin: number, xMax: number, zMin: number, zMax: number): number {
  const tops = live.tops;
  if (tops === null) return -Infinity;
  tops.near(skip, (xMin + xMax) / 2, (zMin + zMax) / 2);
  let top = -Infinity;
  for (let k = 0; k < tops.nAlways; k++) top = Math.max(top, patchTop(tops, tops.always[k]!, xMin, xMax, zMin, zMax, skip));
  return top;
}

const _w = new Float64Array(HIT_SIZE);
const _x = new Float64Array(HIT_SIZE);
const _pq = new Float64Array(PQ_SIZE);
/**
 * The footprint's pose `tread` reads: its turn in the rolling plane (cos, sin), the wheel's scale and the highest the surfaces stand
 * over the footprint (`Infinity`: unbounded) (no boxed doubles cross the call).
 */
const _foot = new Float64Array(4);
const FOOT_COS = 0;
const FOOT_SIN = 1;
const FOOT_SCALE = 2;
const FOOT_TOP = 3;
/** Per footprint point of the last `wheelContact`: its rise, the patch that sets it (`patchOf`) and the point (world x, y, z). */
const _rise = new Float64Array(FOOT);
const _pid = new Float64Array(FOOT);
const _fx = new Float64Array(FOOT);
const _fy = new Float64Array(FOOT);
const _fz = new Float64Array(FOOT);
/** The span (m) `edgeCross` halves a segment down to: a tread or a belly within 0.1 mm of the edge. At a fixed 1/32 of the span a
 *  tyre leaving the wedge's side read 1.4 mm under its tread there, 0.6 mm more than the ground-fit judge's tread rings. */
const EDGE_TOL = 1e-4;
/** The most (m at wheel scale 1) an arc's step can move a ring's height: a ring this far under the highest point cannot set the rise. */
const ARC_RISE = (RINGS[0]![1] * (Math.PI / 2)) / STEPS;

/** The patch that sets `hit` (a `pointContact` result): owner · 1e6 + patch, one number per patch of the store (-1e6 - 1: none). */
export function patchOf(hit: Float64Array): number {
  return hit[C_OWNER]! * 1e6 + hit[C_ARG]!;
}

/** The `pointContact` of the point `edgeCross` found, with the point itself in `C_PX`, `C_PY`, `C_PZ`. */
export const EDGE_HIT = new Float64Array(HIT_SIZE);

/**
 * Where a body's surface between two of its sample points, A on patch `id` and B on another, crosses off `id`: the segment A→B
 * (world) is halved down to `EDGE_TOL`, keeping the half whose near end stands on `id`, so a tyre's tread or a belly meets a face's
 * edge where the edge is, not at the nearest sample. With `rad` > 0, A and B are on a tread ring of that radius about (`ox`, `oy`,
 * `oz`) and each point is taken on the ring, not on the chord between them (7.5° of a ring's chord is 0.6 mm inside it). Each point
 * asks from height `ask` (a tyre's hub) or, NaN, its own. Returns the greatest rise (surface height less the point's) found on `id`,
 * `-Infinity` if none; that point's contact is in `EDGE_HIT`.
 */
export function edgeCross(ax: number, ay: number, az: number, bx: number, by: number, bz: number, ox: number, oy: number, oz: number, rad: number, ask: number, skip: number, id: number): number {
  let best = NONE;
  let t0 = 0;
  let t1 = 1;
  const len = Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay) + (bz - az) * (bz - az));
  while ((t1 - t0) * len > EDGE_TOL) {
    const t = (t0 + t1) / 2;
    let px = ax + (bx - ax) * t;
    let py = ay + (by - ay) * t;
    let pz = az + (bz - az) * t;
    if (rad > 0) {
      const k = rad / Math.sqrt((px - ox) * (px - ox) + (py - oy) * (py - oy) + (pz - oz) * (pz - oz));
      px = ox + (px - ox) * k;
      py = oy + (py - oy) * k;
      pz = oz + (pz - oz) * k;
    }
    _pq[PQ_X] = px;
    _pq[PQ_Z] = pz;
    _pq[PQ_Y] = Number.isNaN(ask) ? py : ask;
    seekAll(_pq, skip);
    if (seekPatch() !== id) {
      t1 = t;
      continue;
    }
    t0 = t;
    const r = _s[S_BEST] - py;
    if (!(r > best)) continue;
    best = r;
    report(_x);
    EDGE_HIT.set(_x);
    EDGE_HIT[C_PX] = px;
    EDGE_HIT[C_PY] = py;
    EDGE_HIT[C_PZ] = pz;
  }
  return best;
}

/** The step (m) `ridgeCross` reads a segment at, and the span it narrows its highest reading down to. */
const RIDGE_STEP = 0.05;
const RIDGE_TOL = 0.002;
const ridgeBest = new Float64Array(1);

/** `ridgeCross`'s reading at `t` along A + t·D: the rise on patch `id` (NONE off it), kept in `EDGE_HIT` when the highest yet. */
function ridgeAt(ax: number, ay: number, az: number, dx: number, dy: number, dz: number, t: number, skip: number, id: number): number {
  const px = ax + dx * t;
  const py = ay + dy * t;
  const pz = az + dz * t;
  _pq[PQ_X] = px;
  _pq[PQ_Z] = pz;
  _pq[PQ_Y] = py;
  seekAll(_pq, skip);
  if (seekPatch() !== id) return NONE;
  const r = _s[S_BEST] - py;
  if (r > ridgeBest[0]!) {
    ridgeBest[0] = r;
    report(_x);
    EDGE_HIT.set(_x);
    EDGE_HIT[C_PX] = px;
    EDGE_HIT[C_PY] = py;
    EDGE_HIT[C_PZ] = pz;
  }
  return r;
}

/**
 * Where a body's surface between two of its sample points A and B, both over patch `id`, meets that patch's highest point under it:
 * a car's top is one patch, and its roof's front edge is a ridge in it that a car lying across it rests on between its belly's rows.
 * The segment A→B (world) is read every `RIDGE_STEP` and the highest reading narrowed to `RIDGE_TOL`. Returns the greatest rise found
 * on `id` strictly between A and B, `-Infinity` if none; that point's contact is in `EDGE_HIT`.
 */
export function ridgeCross(ax: number, ay: number, az: number, bx: number, by: number, bz: number, skip: number, id: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const m = Math.ceil(len / RIDGE_STEP);
  ridgeBest[0] = NONE;
  let at = -1;
  let top = NONE;
  for (let k = 1; k < m; k++) {
    const r = ridgeAt(ax, ay, az, dx, dy, dz, k / m, skip, id);
    if (!(r > top)) continue;
    top = r;
    at = k;
  }
  if (at < 0) return NONE;
  let t0 = (at - 1) / m;
  let t1 = (at + 1) / m;
  while ((t1 - t0) * len > RIDGE_TOL) {
    const ta = t0 + (t1 - t0) / 3;
    const tb = t1 - (t1 - t0) / 3;
    if (ridgeAt(ax, ay, az, dx, dy, dz, ta, skip, id) < ridgeAt(ax, ay, az, dx, dy, dz, tb, skip, id)) t0 = ta;
    else t1 = tb;
  }
  return ridgeBest[0]!;
}

/** `hit` (a `pointContact` with its point in `C_PX`..`C_PZ`) as the wheel's contact in `out`: rise `r`, footprint index `k`. */
function take(out: Float64Array, hit: Float64Array, r: number, k: number): void {
  out[C_H] = r;
  out[C_NX] = hit[C_NX]!;
  out[C_NY] = hit[C_NY]!;
  out[C_NZ] = hit[C_NZ]!;
  out[C_GRIP] = hit[C_GRIP]!;
  out[C_SURF] = hit[C_SURF]!;
  out[C_OWNER] = hit[C_OWNER]!;
  out[C_ARG] = k;
  out[C_AUX] = hit[C_AUX]!;
  out[C_PX] = hit[C_PX]!;
  out[C_PY] = hit[C_PY]!;
  out[C_PZ] = hit[C_PZ]!;
}

/** The car tops `wheelContact`'s footprint asks (`null`: none whose edge is within the tyre's reach) and their patches whose box is within reach of its hub. */
let _reachOf: Surface | null = null;
let _reach = new Int32Array(8);
let _nReach = 0;

/**
 * Footprint point `k` (wheel frame at wheel scale 1, turned and scaled by `_foot`) asked from the hub's height over the statics and
 * the tops within reach (`_reach`): its rise, patch and point into the footprint's store, and into `out` as the wheel's contact when
 * it is the highest yet. Not asked where the highest the surfaces stand over the footprint (`FOOT_TOP`) is no higher over the point
 * than the rise so far: its rise cannot be greater (its store is left as it was; only the arcs' pass reads it).
 */
function tread(hub: Float64Array, axes: Float64Array, skip: number, k: number, out: Float64Array): void {
  const c = _foot[FOOT_COS]!;
  const s = _foot[FOOT_SIN]!;
  const scale = _foot[FOOT_SCALE]!;
  const lx = FX[k]! * scale;
  const ly = (FY[k]! * c + FZ[k]! * s) * scale;
  const lz = (FZ[k]! * c - FY[k]! * s) * scale;
  const px = hub[0]! + axes[0]! * lx + axes[3]! * ly + axes[6]! * lz;
  const py = hub[1]! + axes[1]! * lx + axes[4]! * ly + axes[7]! * lz;
  const pz = hub[2]! + axes[2]! * lx + axes[5]! * ly + axes[8]! * lz;
  if (_foot[FOOT_TOP]! - py <= out[C_H]!) return;
  _pq[PQ_X] = px;
  _pq[PQ_Z] = pz;
  _pq[PQ_Y] = hub[1]!;
  seek(_pq, skip, _reachOf, _reach, _nReach);
  const r = _s[S_BEST] - py;
  _rise[k] = r;
  _pid[k] = seekPatch();
  _fx[k] = px;
  _fy[k] = py;
  _fz[k] = pz;
  if (!(r > out[C_H]!)) return;
  report(_w);
  _w[C_PX] = px;
  _w[C_PY] = py;
  _w[C_PZ] = pz;
  take(out, _w, r, k);
}

/**
 * A wheel's contact with the surfaces: its tread's footprint swept over the store. `hub` is the hub's world position (x, y, z),
 * `axes` the body's rotation (world x, y, z axes, 9 numbers), `scale` the wheel's size.
 * `out` = [rise, nx, ny, nz, grip, surface, owner, footprint index, aux, footprint point x, y, z, touch]: `rise` the greatest height
 * any footprint point must lift to clear the surface under it (the tread gap is `-rise`; `-Infinity` with nothing under the wheel),
 * the rest as `pointContact`'s at the point that sets it (the hub itself with nothing under the wheel), so a wheel riding up a lip
 * rises continuously as its arc meets the edge. The surface point under the footprint point that sets it is (`C_PX`, `C_PY` + `rise`,
 * `C_PZ`): where the tyre rests, whichever side of the hub that is. `touch` is `rise` or, when a face too high to mount is pressed by
 * the tread, how far that is in it.
 */
export function wheelContact(hub: Float64Array, axes: Float64Array, scale: number, skip: number, out: Float64Array): void {
  out[C_NX] = 0;
  out[C_NY] = 1;
  out[C_NZ] = 0;
  out[C_GRIP] = 0;
  out[C_SURF] = ASPHALT;
  out[C_OWNER] = -1;
  out[C_ARG] = -1;
  out[C_AUX] = 1;
  out[C_PX] = hub[0]!;
  out[C_PY] = hub[1]!;
  out[C_PZ] = hub[2]!;
  // Every footprint point asks from the hub's height, as a tread point of the drawn tyre does: a face lower than the hub is the ground
  // the tyre sits in, a taller one is a wall. The rings' arcs only where a patch ends within the tyre's reach.
  const r = FOOT_REACH * scale;
  const x = hub[0]!;
  const z = hub[2]!;
  const y = hub[1]!;
  const tops = live.tops;
  _nReach = 0;
  if (tops !== null) {
    tops.near(skip, x, z);
    if (_reach.length < tops.nAlways) _reach = new Int32Array(tops.always.length);
    // A top whose box ends farther than the tyre's reach from the hub holds none of the footprint's points (every one is within it).
    const P = tops.p;
    for (let k = 0; k < tops.nAlways; k++) {
      const i = tops.always[k]!;
      const o = i * P_STRIDE;
      if (x < P[o + P_MINX]! - r || x > P[o + P_MAXX]! + r || z < P[o + P_MINZ]! - r || z > P[o + P_MAXZ]! + r) continue;
      _reach[_nReach++] = i;
    }
  }
  // No top's edge within the tyre's reach: the hub and its footprint never ask the tops.
  _pq[PQ_X] = x;
  _pq[PQ_Z] = z;
  _pq[PQ_Y] = y;
  _foot[FOOT_SCALE] = scale;
  _reachOf = tops !== null && edgeIn(tops, _pq, skip) ? tops : null;
  const n = _reachOf !== null || (live.statics !== null && edgeIn(live.statics, _pq, skip)) ? FOOT : BASE;
  // The footprint turns in the rolling plane to face the surface under the hub: each ring's bottom is then its point nearest that
  // surface, as the drawn tyre's is (a car pitched 10° on three wheels held a rear tyre's shoulder 5 mm off the floor at its body-down point).
  seek(_pq, skip, _reachOf, _reach, _nReach);
  normalOf(_w);
  let c = 1;
  let s = 0;
  if (_w[C_H]! !== NONE) {
    const ny = _w[C_NX]! * axes[3]! + _w[C_NY]! * axes[4]! + _w[C_NZ]! * axes[5]!;
    const nz = _w[C_NX]! * axes[6]! + _w[C_NY]! * axes[7]! + _w[C_NZ]! * axes[8]!;
    const len = hypot2(ny, nz);
    if (len > 1e-9) {
      c = ny / len;
      s = -nz / len;
    }
  }
  out[C_H] = NONE;
  _foot[FOOT_COS] = c;
  _foot[FOOT_SIN] = s;
  // With no car top asked (`_reachOf` null: none within the tyre's reach) and the rings' bottoms alone (no patch ends within reach),
  // the static surface's highest over the footprint bounds every point's surface; otherwise every point is asked (a top's own height
  // is not in the bound, and the arcs' pass reads every rise).
  _foot[FOOT_TOP] = _reachOf !== null || n === FOOT ? Infinity : live.statics === null ? NONE : staticTop(live.statics, x - r, x + r, z - r, z + r);
  for (let k = 0; k < n; k++) tread(hub, axes, skip, k, out);
  // Near an edge a ring's highest point is where it crosses onto the patch that holds it, between two arcs: the chord to the
  // neighbour on another patch is halved (`edgeCross`; a front tyre leaving the wedge's side read 1.6 cm lower at its nearest arc
  // than the drawn tyre's tread).
  if (n === FOOT) {
    const best = out[C_H]! - ARC_RISE * scale;
    for (let ring = 0; ring < RINGS.length; ring++) {
      let jb = 0;
      let rb = NONE;
      for (let j = -STEPS; j <= STEPS; j++) {
        const rj = _rise[KOF[ring * ARCS + j + STEPS]!]!;
        if (rj > rb) {
          rb = rj;
          jb = j;
        }
      }
      if (!(rb > best)) continue;
      const kb = KOF[ring * ARCS + jb + STEPS]!;
      // The ring's centre: the hub moved along the axle by the ring's offset.
      const lx = RINGS[ring]![0] * scale;
      const rad = RINGS[ring]![1] * scale;
      for (let side = -1; side <= 1; side += 2) {
        const jn = jb + side;
        if (jn < -STEPS || jn > STEPS) continue;
        const kn = KOF[ring * ARCS + jn + STEPS]!;
        if (_pid[kn] === _pid[kb]) continue;
        const r = edgeCross(_fx[kb]!, _fy[kb]!, _fz[kb]!, _fx[kn]!, _fy[kn]!, _fz[kn]!, x + axes[0]! * lx, y + axes[1]! * lx, z + axes[2]! * lx, rad, y, skip, _pid[kb]!);
        if (r > out[C_H]!) take(out, EDGE_HIT, r, kb);
      }
    }
  }
  out[C_TOUCH] = out[C_H]!;
}
