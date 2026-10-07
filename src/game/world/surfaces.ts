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
export const Q_STRIDE = 8;
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
    this.sealed = false;
    return i;
  }

  /** Whether a body that collides by shape (the ragdoll's world) meets patch `i`; false: it answers height queries only. */
  setSolid(i: number, solid: boolean): void {
    this.q[i * Q_STRIDE + Q_SOLID] = solid ? 1 : 0;
  }

  /** Readies `always` for a query asked by body slot `skip`: every query tests a static surface's alike; the cars' tops list the roofs near the asker (`CarSurfaces`). */
  near(_skip: number): void {}

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

  /** Grid patch `i`'s world box from its frame, node extent (`P_HMAX`) and drop. */
  private box(i: number): void {
    const o = i * P_STRIDE;
    const qo = i * Q_STRIDE;
    const P = this.p;
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
    const unb = this.q[qo + Q_UNB] === 1;
    P[o + P_MINX] = unb ? -WORLD : minX - tx;
    P[o + P_MAXX] = unb ? WORLD : maxX + tx;
    P[o + P_MINZ] = unb ? -WORLD : minZ - tz;
    P[o + P_MAXZ] = unb ? WORLD : maxZ + tz;
  }

  /** Narrow patch `i`'s box (after `setFrame`) to the square of half width `r` about plan (cx, cz): a roof's reach about its car. */
  clipBox(i: number, cx: number, cz: number, r: number): void {
    const o = i * P_STRIDE;
    const P = this.p;
    P[o + P_MINX] = Math.max(P[o + P_MINX]!, cx - r);
    P[o + P_MAXX] = Math.min(P[o + P_MAXX]!, cx + r);
    P[o + P_MINZ] = Math.max(P[o + P_MINZ]!, cz - r);
    P[o + P_MAXZ] = Math.min(P[o + P_MAXZ]!, cz + r);
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
  }

  /** Patch `i` is `owner`'s (a car's slot): its own queries skip it. */
  own(i: number, owner: number): void {
    this.q[i * Q_STRIDE + Q_OWNER] = owner;
  }

  /** Patch `i`'s crush drop (m). */
  setDrop(i: number, drop: number): void {
    this.p[i * P_STRIDE + P_DROP] = drop;
  }

  /** Build the spatial index over the patches' boxes (a scene's static surfaces: once, at registration). Few patches are all tested. */
  seal(): void {
    this.sealed = true;
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

/** `offer`'s scratch: the best candidate so far (`S_BEST`..`S_AUX`), the candidate being evaluated (`S_CG0`..`S_CAUX`) and one cell's bilinear partials (per cell unit, `S_PU`, `S_PV`, set by `bil`). */
const _s = new Float64Array(13);
const S_BEST = 0;
const S_PATCH = 1;
const S_G0 = 2;
const S_G1 = 3;
const S_NODE = 4;
const S_OWNER = 5;
const S_AUX = 6;
const S_CG0 = 7;
const S_CG1 = 8;
const S_CN = 9;
const S_CAUX = 10;
const S_PU = 11;
const S_PV = 12;

function bil(f: Float32Array, c: number, nu: number, fu: number, fv: number): number {
  const h00 = f[c]!;
  const h10 = f[c + 1]!;
  const h01 = f[c + nu]!;
  const h11 = f[c + nu + 1]!;
  const a = h00 + (h10 - h00) * fu;
  const b = h01 + (h11 - h01) * fu;
  _s[S_PU] = (1 - fv) * (h10 - h00) + fv * (h11 - h01);
  _s[S_PV] = b - a;
  return a + (b - a) * fv;
}

/** The base terrain past a grid: its gaussian hills' height at (x, z), the gradient into `_cg0`/`_cg1` (world plan). */
function hillsAt(h: Float64Array, x: number, z: number): number {
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
  return sum;
}

/**
 * Grid patch `i` at (x, z), asked from height `y`: the surface's world height, NaN where it has none. Sets `_cg0`/`_cg1` (the
 * surface's partials along the frame's x and z; in world plan past the grid) and `_cn` (the nearest node, −1 past the grid). A
 * patch with per-node factors (`auxs`) lowers by `P_DROP × factor` and leaves the factor in `_caux` (`offer` presets it to 1).
 */
function gridAt(s: Surface, i: number, x: number, z: number, y: number): number {
  const P = s.p;
  const o = i * P_STRIDE;
  const dx = x - P[o + P_OX]!;
  const dz = z - P[o + P_OZ]!;
  const rad2 = P[o + P_RAD2]!;
  if (rad2 > 0 && dx * dx + dz * dz > rad2) return NaN;
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
    if (s.q[qo + Q_SURF2]! < 0) return NaN;
    _s[S_CN] = -1;
    return P[o + P_OY]! + hillsAt(s.hills[i]!, x, z);
  }
  const ci = Math.floor(fu);
  const cj = Math.floor(fv);
  const c = cj * nu + ci;
  const tu = fu - ci;
  const tv = fv - cj;
  let h: number;
  const lat = s.lat[i]!;
  if (lat.length > 0 && lat[c]! === lat[c]! && lat[c + 1]! === lat[c + 1]! && lat[c + nu]! === lat[c + nu]! && lat[c + nu + 1]! === lat[c + nu + 1]!) {
    // The road's crease: centre height less the (clamped) lateral share of the drop, so the bank's edge stays sharp.
    const l = bil(lat, c, nu, tu, tv);
    const lu1 = _s[S_PU];
    const lv1 = _s[S_PV];
    const centre = bil(s.centre[i]!, c, nu, tu, tv);
    const cu = _s[S_PU];
    const cv = _s[S_PV];
    const drop = bil(s.drop[i]!, c, nu, tu, tv);
    const du = _s[S_PU];
    const dv = _s[S_PV];
    const k = Math.max(-1, Math.min(1, l));
    const inside = l > -1 && l < 1;
    h = centre - k * drop;
    _s[S_CG0] = (cu - k * du - (inside ? lu1 * drop : 0)) / step;
    _s[S_CG1] = (cv - k * dv - (inside ? lv1 * drop : 0)) / stepV;
  } else {
    h = bil(s.nodes[i]!, c, nu, tu, tv);
    _s[S_CG0] = _s[S_PU] / step;
    _s[S_CG1] = _s[S_PV] / stepV;
  }
  _s[S_CN] = Math.round(fv) * nu + Math.round(fu);
  const aux = s.auxs[i]!;
  if (aux.length > 0) _s[S_CAUX] = bil(aux, c, nu, tu, tv);
  h -= P[o + P_DROP]! * _s[S_CAUX];
  // The surface point's world height: the frame's origin plus its local x, y and z along the axes' y components.
  return P[o + P_OY]! + P[o + P_AX + 1]! * lu + P[o + P_BX + 1]! * h + P[o + P_CX + 1]! * lv;
}

/** A bridge deck segment at (x, z): its height, NaN off it. Sets `_cg0`/`_cg1` (the height's world-plan partials) and `_cn` (0 the road, 1 its run). */
function deckAt(s: Surface, i: number, x: number, z: number): number {
  const P = s.p;
  const o = i * P_STRIDE;
  const ex = P[o + D_EX]!;
  const ez = P[o + D_EZ]!;
  const len2 = P[o + D_LEN2]!;
  const len = P[o + D_LEN]!;
  const x0 = P[o + P_OX]!;
  const z0 = P[o + P_OZ]!;
  const f = ((x - x0) * ex + (z - z0) * ez) / len2;
  if (f < -0.02 || f > 1.02) return NaN;
  const lat = ((x - x0) * ez - (z - z0) * ex) / len;
  const half = P[o + D_HALF]!;
  const run = lat > 0 ? P[o + D_RUNL]! : P[o + D_RUNR]!;
  if (Math.abs(lat) > half + run) return NaN;
  const tan = P[o + D_TAN]!;
  const inside = Math.abs(lat) < half;
  _s[S_CG0] = (P[o + D_DY]! * ex) / len2 - (inside ? (tan * ez) / len : 0);
  _s[S_CG1] = (P[o + D_DY]! * ez) / len2 + (inside ? (tan * ex) / len : 0);
  _s[S_CN] = Math.abs(lat) <= half ? 0 : 1;
  return P[o + P_OY]! + P[o + D_DY]! * f - Math.max(-half, Math.min(half, lat)) * tan;
}

/** Test patch `i` of `s` for the point; a candidate that reaches and is the highest so far becomes the best. */
function offer(s: Surface, i: number, x: number, z: number, y: number, skip: number): void {
  const P = s.p;
  const o = i * P_STRIDE;
  if (x < P[o + P_MINX]! || x > P[o + P_MAXX]! || z < P[o + P_MINZ]! || z > P[o + P_MAXZ]!) return;
  const qo = i * Q_STRIDE;
  const owner = s.q[qo + Q_OWNER]!;
  // A car's own roof is not under it, nor is the roof of a car whose origin is higher (two cars standing on each other lifted one another 1.5 m a frame).
  if (owner >= 0 && (owner === skip || (skip >= 0 && skip < s.count && P[o + P_OY]! > P[skip * P_STRIDE + P_OY]!))) return;
  _s[S_CAUX] = 1;
  const h = s.q[qo + Q_KIND] === DECK ? deckAt(s, i, x, z) : gridAt(s, i, x, z, y);
  // NaN (no surface) fails the first test; an unlimited reach under an asker at -Infinity is NaN and passes the second.
  if (h !== h || h > y + P[o + P_REACH]! || h < _s[S_BEST]) return;
  _s[S_BEST] = h;
  live.surf = s;
  _s[S_PATCH] = i;
  _s[S_G0] = _s[S_CG0];
  _s[S_G1] = _s[S_CG1];
  _s[S_NODE] = _s[S_CN];
  _s[S_AUX] = _s[S_CAUX];
  _s[S_OWNER] = owner;
}

/** The highest surface at the point over `s`'s patches, into the best-candidate scratch. */
function find(s: Surface, x: number, z: number, y: number, skip: number): void {
  const always = s.always;
  for (let k = 0; k < s.nAlways; k++) offer(s, always[k]!, x, z, y, skip);
  if (s.cellList.length === 0) return;
  const ci = Math.floor(x / CELL) - s.cx0;
  const cj = Math.floor(z / CELL) - s.cz0;
  if (ci < 0 || cj < 0 || ci >= s.cnx || cj >= s.cnz) return;
  const c = cj * s.cnx + ci;
  for (let k = s.cellStart[c]!; k < s.cellStart[c + 1]!; k++) offer(s, s.cellList[k]!, x, z, y, skip);
}

/**
 * `out` = [height, nx, ny, nz, grip, surface index, owner (−1 the world's, else a car's slot), patch, aux] of the best candidate
 * (aux: the patch's per-node factor there, 1 without one); height `-Infinity` and grip 0 where there is none.
 */
function report(out: Float64Array): void {
  const w = live.surf;
  if (w === null) {
    out[C_H] = NONE;
    out[C_NX] = 0;
    out[C_NY] = 1;
    out[C_NZ] = 0;
    out[C_GRIP] = 0;
    out[C_SURF] = ASPHALT;
    out[C_OWNER] = -1;
    out[C_ARG] = -1;
    out[C_AUX] = 1;
    return;
  }
  const P = w.p;
  const o = _s[S_PATCH] * P_STRIDE;
  const qo = _s[S_PATCH] * Q_STRIDE;
  const deck = w.q[qo + Q_KIND] === DECK;
  out[C_H] = _s[S_BEST];
  if (deck || _s[S_NODE] < 0) {
    // Partials in world plan.
    const len = Math.hypot(_s[S_G0], 1, _s[S_G1]);
    out[C_NX] = -_s[S_G0] / len;
    out[C_NY] = 1 / len;
    out[C_NZ] = -_s[S_G1] / len;
  } else {
    // Partials along the frame's x and z: the normal is (−gx, 1, −gz) in the frame, turned into world.
    const nx = -_s[S_G0] * P[o + P_AX]! + P[o + P_BX]! - _s[S_G1] * P[o + P_CX]!;
    const ny = -_s[S_G0] * P[o + P_AX + 1]! + P[o + P_BX + 1]! - _s[S_G1] * P[o + P_CX + 1]!;
    const nz = -_s[S_G0] * P[o + P_AX + 2]! + P[o + P_BX + 2]! - _s[S_G1] * P[o + P_CX + 2]!;
    const len = Math.hypot(nx, ny, nz);
    out[C_NX] = nx / len;
    out[C_NY] = ny / len;
    out[C_NZ] = nz / len;
  }
  let surf = w.q[qo + Q_SURF]!;
  if (deck) {
    if (_s[S_NODE] !== 0) surf = w.q[qo + Q_SURF2]!;
  } else if (surf < 0) surf = _s[S_NODE] >= 0 ? w.surfs[_s[S_PATCH]]![_s[S_NODE]]! : w.q[qo + Q_SURF2]!;
  else if (_s[S_NODE] < 0) surf = w.q[qo + Q_SURF2]!;
  out[C_SURF] = surf;
  out[C_GRIP] = P[o + P_GRIP]! * GRIPS[surf]!;
  out[C_OWNER] = _s[S_OWNER];
  out[C_ARG] = _s[S_PATCH];
  out[C_AUX] = _s[S_AUX];
}

/**
 * The surface at plan (x, z) under a body asking from height `y` (`Infinity`: the top surface): the highest one of the scene's
 * static surface and the armed car tops that is at most its patch's reach above `y`, into `out` (see `report`). `skip` is the
 * slot the body is itself (its own roof is not under it, nor is a roof of a car higher than it), −1 none.
 */
export function pointContact(x: number, z: number, y: number, skip: number, out: Float64Array): void {
  _s[S_BEST] = NONE;
  live.surf = null;
  if (live.statics !== null) find(live.statics, x, z, y, skip);
  const t = live.tops;
  if (t !== null) {
    t.near(skip);
    for (let k = 0; k < t.nAlways; k++) offer(t, t.always[k]!, x, z, y, skip);
  }
  report(out);
}

/** `pointContact` over one surface alone: no other static and no car tops (a `Ground`'s own point queries). */
export function contactIn(s: Surface, x: number, z: number, y: number, out: Float64Array): void {
  _s[S_BEST] = NONE;
  live.surf = null;
  if (!s.sealed) s.seal();
  find(s, x, z, y, -1);
  report(out);
}

// The tyre's footprint (wheel frame: axle x, then the rolling plane's y and z; at wheel scale 1): the drawn tyre's five tread rings
// (`TYRE_PROFILE`, car-materials.ts: the crown, its two edges and both shoulders), each over its lower half in `STEPS` arcs a side. A
// tyre rolling off a face's edge rests on the edge with whichever ring and arc still reach it, up to its hub's height, so its hub comes
// down that arc as the drawn tyre does. The whole tyre turns with the body, so a rolled or pitched car's tread meets the ground where
// the drawn tyre does. The first `BASE` points (every ring's bottom and the crown's arc to 45°) are the whole footprint where no
// patch ends within the tyre's reach (`edgeIn`): over one patch's surface the rings' arcs add nothing (11 points against 85 is
// 10-40 % of a 32-car derby's frame, measured).
const RINGS: readonly (readonly [number, number])[] = [
  [0, 0.32],
  [0.082, 0.314],
  [-0.082, 0.314],
  [0.104, 0.298],
  [-0.104, 0.298],
];
const STEPS = 12;
const FOOT = RINGS.length * (2 * STEPS + 1);
const BASE = RINGS.length + 6;
/** The crown's arcs (in steps either side) that the base footprint carries: 7.5°, 15° and 45°. */
const CROWN = [1, 2, STEPS / 2];
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
  for (let c = 0; c < CROWN.length; c++) {
    at = arc(at, 0, CROWN[c]!);
    at = arc(at, 0, -CROWN[c]!);
  }
  for (let k = -STEPS; k <= STEPS; k++) {
    for (let s = 0; s < RINGS.length; s++) if (k !== 0 && (s !== 0 || !CROWN.includes(Math.abs(k)))) at = arc(at, s, k);
  }
}
/** How far (m at wheel scale 1, plan) a footprint point reaches from its hub, with a margin for the body's tilt. */
const FOOT_REACH = 0.4;

/** Whether patch `i` of `s` ends within `r` (m, plan) of (x, z) asked from height `y` (`skip`: the asking car's slot, as `offer`). */
function endsNear(s: Surface, i: number, x: number, z: number, y: number, r: number, skip: number): boolean {
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

/** Whether any patch of `s` ends within `r` (m, plan) of (x, z): every cell `r` reaches, and the patches every query tests. */
function edgeIn(s: Surface, x: number, z: number, y: number, r: number, skip: number): boolean {
  for (let k = 0; k < s.nAlways; k++) if (endsNear(s, s.always[k]!, x, z, y, r, skip)) return true;
  if (s.cellList.length === 0) return false;
  const i0 = Math.max(0, Math.floor((x - r) / CELL) - s.cx0);
  const i1 = Math.min(s.cnx - 1, Math.floor((x + r) / CELL) - s.cx0);
  const j0 = Math.max(0, Math.floor((z - r) / CELL) - s.cz0);
  const j1 = Math.min(s.cnz - 1, Math.floor((z + r) / CELL) - s.cz0);
  for (let cj = j0; cj <= j1; cj++) {
    for (let ci = i0; ci <= i1; ci++) {
      const c = cj * s.cnx + ci;
      for (let k = s.cellStart[c]!; k < s.cellStart[c + 1]!; k++) if (endsNear(s, s.cellList[k]!, x, z, y, r, skip)) return true;
    }
  }
  return false;
}

const _w = new Float64Array(HIT_SIZE);
const _x = new Float64Array(HIT_SIZE);
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
    pointContact(px, pz, Number.isNaN(ask) ? py : ask, skip, _x);
    if (patchOf(_x) !== id) {
      t1 = t;
      continue;
    }
    t0 = t;
    const r = _x[C_H]! - py;
    if (!(r > best)) continue;
    best = r;
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
let ridgeBest = NONE;

/** `ridgeCross`'s reading at `t` along A + t·D: the rise on patch `id` (NONE off it), kept in `EDGE_HIT` when the highest yet. */
function ridgeAt(ax: number, ay: number, az: number, dx: number, dy: number, dz: number, t: number, skip: number, id: number): number {
  const px = ax + dx * t;
  const py = ay + dy * t;
  const pz = az + dz * t;
  pointContact(px, pz, py, skip, _x);
  if (patchOf(_x) !== id) return NONE;
  const r = _x[C_H]! - py;
  if (r > ridgeBest) {
    ridgeBest = r;
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
  ridgeBest = NONE;
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
  return ridgeBest;
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

/**
 * Footprint point `k` (wheel frame at wheel scale 1, turned by cos `c` / sin `s` in the rolling plane) asked from the hub's height:
 * its rise, patch and point into the footprint's store, and into `out` as the wheel's contact when it is the highest yet.
 */
function tread(hub: Float64Array, axes: Float64Array, scale: number, skip: number, c: number, s: number, k: number, out: Float64Array): void {
  const lx = FX[k]! * scale;
  const ly = (FY[k]! * c + FZ[k]! * s) * scale;
  const lz = (FZ[k]! * c - FY[k]! * s) * scale;
  const px = hub[0]! + axes[0]! * lx + axes[3]! * ly + axes[6]! * lz;
  const py = hub[1]! + axes[1]! * lx + axes[4]! * ly + axes[7]! * lz;
  const pz = hub[2]! + axes[2]! * lx + axes[5]! * ly + axes[8]! * lz;
  pointContact(px, pz, hub[1]!, skip, _w);
  const r = _w[C_H]! - py;
  _rise[k] = r;
  _pid[k] = patchOf(_w);
  _fx[k] = px;
  _fy[k] = py;
  _fz[k] = pz;
  if (!(r > out[C_H]!)) return;
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
  if (tops !== null) tops.near(skip);
  const n = (live.statics !== null && edgeIn(live.statics, x, z, y, r, skip)) || (tops !== null && edgeIn(tops, x, z, y, r, skip)) ? FOOT : BASE;
  // The footprint turns in the rolling plane to face the surface under the hub: each ring's bottom is then its point nearest that
  // surface, as the drawn tyre's is (a car pitched 10° on three wheels held a rear tyre's shoulder 5 mm off the floor at its body-down point).
  pointContact(x, z, y, skip, _w);
  let c = 1;
  let s = 0;
  if (_w[C_H]! !== NONE) {
    const ny = _w[C_NX]! * axes[3]! + _w[C_NY]! * axes[4]! + _w[C_NZ]! * axes[5]!;
    const nz = _w[C_NX]! * axes[6]! + _w[C_NY]! * axes[7]! + _w[C_NZ]! * axes[8]!;
    const len = Math.hypot(ny, nz);
    if (len > 1e-9) {
      c = ny / len;
      s = -nz / len;
    }
  }
  out[C_H] = NONE;
  for (let k = 0; k < n; k++) tread(hub, axes, scale, skip, c, s, k, out);
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
