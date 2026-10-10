import * as THREE from "three";
import type { CageFields, CageStyle } from "../vehicle/car-cage.ts";
import { GLASS_NAMES } from "../vehicle/car-glass.ts";
import { hypot2, hypot3 } from "../kernel/physics-core.js";

/**
 * The dummies' world sees each car as its drawn body (docs/UNIFIED_CONTACT.md stage 3, "the cage is the body"): the cuboids
 * a car's proxy is made of are fitted to its cage's fields (`CarCage.fields`), by this one builder, whenever the cage refits.
 * A dummy lies against a column under the hood, one under the deck, a slab at the roof and a slab at each pane of its glass.
 */

/** Cuboids a car's proxy may hold (its lower box, then its leaves). */
export const PROXY_BOXES = 128;
/** A cuboid's floats: centre x, y, z (car frame, origin on the ground, +z forward), half extents x, y, z, its turn (quaternion x, y, z, w). */
export const BOX_FLOATS = 10;
export const PANES = GLASS_NAMES.length;
/**
 * How far (m) a car's columns reach under the ground: no gap under one for a lying body to wedge into, so the box's front
 * shoves it and never presses it into the ground (with its bottom 5 cm up, 31 of 80 run-overs of a lying cone pressed its
 * lowest point over 32 mm under the road, one 0.66 m, left buried), and a car landing on one from up to a metre up shoves
 * it aside. A bridge deck clears a road under it by more.
 */
export const UNDER = 1;
/** Where the cabin starts in the cage's frame (m): every cage body's hood and deck top stays under it (0.62-0.91 m), every roof is over it (1.19-1.37 m). */
export const BELT_Y = 1;
/** The top (m, cage frame) of the lower box under the cabin: under the doors' flank (0.80-0.83 m on every cage body) and every hood and deck. */
export const SILL_Y = 0.8;
/**
 * How far apart (m) the cage's top may be inside one leaf: the leaf's top sits at the middle of the spread, so no node of it is
 * more than half this from the drawn top, inside the 5 cm held against it (docs/UNIFIED_CONTACT.md section 8).
 */
const LEAF_RANGE = 0.04;
/**
 * How far (m) a leaf's span of nodes (each node's step-wide square) is shifted toward +x and +z: a drawn cell's middle is half a step
 * from the nodes, on the face between two spans, and a hair of shift hands each such cell to the span at its low side, so a ray
 * never meets two faces at once or slips between them.
 */
const SHIFT = 0.005;
/** The leaf tops sit this far (m) over the middle of their spread: the cage's top lies a hair under the drawn body's (its decimated vertices miss the crowns); 1.5 cm centred the audit's four bodies in `ragdoll-proxy-fit.test.ts`. */
const TOP_BIAS = 0.015;
/** How far (m) in from the plan's outline the body's edge rolls away (0.1-0.3 m under the top in 0.15 m): the leaves fit the nodes inside it, those in it that lie near the inside's top (`RIM_DROP`), and run out over the rest. */
const RIM = 0.1;
/** How far (m) under its leaf's inside a rim node may lie and still be the leaf's (a crushed hood's crater wall is 0.08 m under the hood; an edge rolling away 0.1-0.3 m). */
const RIM_DROP = 0.1;
/** Floats of a node set's moments: count, Σy, Σy² (`misses`), and how many of its nodes are inside the rim. */
const MOMENTS = 4;
/** `ProxyFitter.open` with no gone pane. */
const OPEN_NONE = [Infinity, -Infinity, Infinity, -Infinity] as const;
/** `ProxyFitter.glassNode` of a node under a gone pane, and the height (m) its opening reads as. */
const OPEN = 2;
const OPEN_Y = 0;
/** Nodes a roof leaf is wide at least, each way, to bear the lower box (0.3 m): a narrower one is a fin, a lip or a pillar. */
const CABIN_SIDE = 6;
/** The cabin's roof slab half-thickness (m). */
const ROOF_HALF = 0.04;
/**
 * A pane's slab is `PANE_HALF` thick inside the glass and runs `PANE_PAD` past its sides, which closes the pillars between
 * panes; hollow under the roof, so a pane that is gone (shattered by the crash, a torso or the throw) lets a dummy through.
 */
export const PANE_HALF = 0.03;
const PANE_PAD = 0.05;
/** A pane's state in `CarCore.glassBits` (two bits per pane) when it is gone: shattered out. */
export const PANE_GONE = 2;
/**
 * How far (m) a pane's slab stops short of the glass's top: the crushed roof's step meets the glass there, and a slab running on
 * past its edge stands over the roof's cells by its own thickness.
 */
const PANE_TOP_TRIM = 2 * PANE_HALF;

/** The most node lines a lattice has along one axis (`CageStyle.nu`, `nv`; 49 × 97 at the 5 cm step). */
const LINES = 128;

/** Corner order around a pane's quad: its corners run base 0, base 1, top 0, top 1. */
const QUAD_ORDER = [0, 1, 3, 2] as const;
/** How far (m) the cage's top may lie under a pane's plane and still be the glass's: the glass is the surface of the cage under it. */
const GLASS_UNDER = 0.1;
/** How far (m) the cage's top may lie over a pane's plane and still be the glass's: more is the sill or lip the glass sits in, which stays a leaf. */
const GLASS_OVER = 0.045;
/** A pane whose normal points less than this share of its length up (0.2: within 12 degrees of upright) covers no node: the doors' and quarters' glass. */
const GLASS_UPRIGHT = 0.2;
/** A pane whose normal points at least this share of its length up (0.5: within 60 degrees of upright) is lying: a windshield or rear window, not a door's or a quarter's glass. */
const GLASS_LYING = 0.5;

/** The squared miss of the mean over the node set whose moments are `m`. */
function misses(m: Float64Array): number {
  return m[2]! - (m[1]! * m[1]!) / m[0]!;
}

const _basis = new THREE.Matrix4();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _u = new THREE.Vector3();

/** One car's proxy cuboids, fitted from its cage: `fit` the leaves, `fitPanes` the glass. Allocates once, here. */
export class ProxyFitter {
  /** The boxes, `BOX_FLOATS` each, `count` of them. */
  readonly boxes = new Float64Array(PROXY_BOXES * BOX_FLOATS);
  count = 0;
  /** The pane slabs, `BOX_FLOATS` each, in `GLASS_NAMES` order. */
  readonly panes = new Float64Array(PANES * BOX_FLOATS);
  private readonly corner = new Float64Array(12);
  /** Per leaf, its node rectangle (inclusive), whether it is of the roof (nodes over the belt), whether it has no node inside the rim (it fits all its nodes), the lowest and highest the cage's top lies over it, and the band of tops a rim node may lie in to count (`counts`). */
  private readonly i0 = new Int16Array(PROXY_BOXES);
  private readonly i1 = new Int16Array(PROXY_BOXES);
  private readonly j0 = new Int16Array(PROXY_BOXES);
  private readonly j1 = new Int16Array(PROXY_BOXES);
  private readonly roof = new Uint8Array(PROXY_BOXES);
  private readonly rim = new Uint8Array(PROXY_BOXES);
  /** Per leaf, whether no cut can split it (`cut`): it stays one box. */
  private readonly whole = new Uint8Array(PROXY_BOXES);
  private readonly lo = new Float64Array(PROXY_BOXES);
  private readonly hi = new Float64Array(PROXY_BOXES);
  private readonly floor = new Float64Array(PROXY_BOXES);
  private readonly ceil = new Float64Array(PROXY_BOXES);
  /** Per node line of the leaf being cut (`cut`; i lines, then j lines), the moments of its nodes (`MOMENTS`), and the whole leaf's and the left side's. */
  private readonly line = new Float64Array(2 * LINES * MOMENTS);
  private readonly total = new Float64Array(MOMENTS);
  private readonly left = new Float64Array(MOMENTS);
  private readonly right = new Float64Array(MOMENTS);
  private cutAlongI = true;
  private plan: Float32Array = new Float32Array(0);
  /** Per node, 1 where it lies under a pane that is not upright (`markGlass`), standing or gone: the glass, or its opening, is the surface there, not a leaf. */
  private readonly glassNode = new Uint8Array(LINES * LINES);
  /** The node lines (x min, x max, z min, z max) under the gone panes: the opening a dummy falls through, over which the lower box runs on. */
  private readonly open = new Float64Array(4);

  /** Whether node `n` is one leaf `k` holds: covered by the plan, with a top, under no pane, and on its side of the belt (a roof leaf never takes a hood's nodes). */
  private holds(k: number, f: CageFields, n: number): boolean {
    return f.covered[n] === 1 && this.glassNode[n] === 0 && Number.isFinite(f.top[n]!) && f.top[n]! > BELT_Y === (this.roof[k] === 1);
  }

  /**
   * Whether node `n` counts in leaf `k`'s spread: one the leaf holds that is inside the rim, or in it and no more than `RIM_DROP`
   * under the inside's highest nor `LEAF_RANGE` over it (a crater's wall, not the edge rolling away or a stray vertex), or any it
   * holds when it has none inside the rim (a stray row along an outline, which a cut never splits off a leaf with an inside).
   */
  private counts(k: number, f: CageFields, n: number): boolean {
    if (!this.holds(k, f, n)) return false;
    return this.rim[k] === 1 || this.plan[n]! <= -RIM || (f.top[n]! >= this.floor[k]! && f.top[n]! <= this.ceil[k]!);
  }

  /**
   * Fits leaf `k`: its node rectangle tightened to the nodes it holds, and the lowest and highest top over those that count. False
   * when it holds none.
   */
  private measure(k: number, f: CageFields, nu: number): boolean {
    let held = false;
    let i0 = this.i1[k]!;
    let i1 = this.i0[k]!;
    let j0 = this.j1[k]!;
    let j1 = this.j0[k]!;
    for (let j = this.j0[k]!; j <= this.j1[k]!; j++) {
      for (let i = this.i0[k]!; i <= this.i1[k]!; i++) {
        if (!this.holds(k, f, j * nu + i)) continue;
        held = true;
        if (i < i0) i0 = i;
        if (i > i1) i1 = i;
        if (j < j0) j0 = j;
        if (j > j1) j1 = j;
      }
    }
    if (!held) return false;
    let inner = 0;
    let innerHi = -Infinity;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (!this.holds(k, f, j * nu + i) || this.plan[j * nu + i]! > -RIM) continue;
        inner++;
        innerHi = Math.max(innerHi, f.top[j * nu + i]!);
      }
    }
    this.rim[k] = inner === 0 ? 1 : 0;
    this.floor[k] = innerHi - RIM_DROP;
    this.ceil[k] = innerHi + LEAF_RANGE;
    let lo = Infinity;
    let hi = -Infinity;
    let ci0 = i1;
    let ci1 = i0;
    let cj0 = j1;
    let cj1 = j0;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const y = this.sample(k, f, j * nu + i);
        if (Number.isNaN(y)) continue;
        if (y < lo) lo = y;
        if (y > hi) hi = y;
        if (i < ci0) ci0 = i;
        if (i > ci1) ci1 = i;
        if (j < cj0) cj0 = j;
        if (j > cj1) cj1 = j;
      }
    }
    // A roof leaf is a slab afloat over its rectangle: it takes only the nodes that count, so a ring that holds (over the belt) but
    // lies under the inside's floor (a bed's wall round a crushed deck) does not stretch it over the deck between. A leaf under the
    // belt is a column from under the ground, which stands under every node of its rectangle.
    if (this.roof[k] === 1) {
      this.i0[k] = ci0;
      this.i1[k] = ci1;
      this.j0[k] = cj0;
      this.j1[k] = cj1;
    } else {
      this.i0[k] = i0;
      this.i1[k] = i1;
      this.j0[k] = j0;
      this.j1[k] = j1;
    }
    this.lo[k] = lo;
    this.hi[k] = hi;
    return true;
  }

  /**
   * Node `n`'s height as leaf `k`'s spread reads it: its top when it counts, `OPEN_Y` (the ground: nothing there) for a node under a
   * gone pane, so no leaf spans the opening a dummy falls through and every cut across one splits it off; NaN for the rest.
   */
  private sample(k: number, f: CageFields, n: number): number {
    if (this.glassNode[n] === OPEN && f.covered[n] === 1) return OPEN_Y;
    return this.counts(k, f, n) ? f.top[n]! : NaN;
  }

  /**
   * Where leaf `k` is best cut: the line of nodes (a column along i, or a row along j) after which the two sides' tops lie least
   * spread about their means (the sum of their squared misses, read off moments summed along the lines), so a bump or a step is
   * cut off in one cut and a slope in the middle. Returns the node after which it is cut, and sets `cutAlongI`.
   */
  private cut(k: number, f: CageFields, nu: number): number {
    this.line.fill(0);
    for (let j = this.j0[k]!; j <= this.j1[k]!; j++) {
      for (let i = this.i0[k]!; i <= this.i1[k]!; i++) {
        const y = this.sample(k, f, j * nu + i);
        if (Number.isNaN(y)) continue;
        const inside = this.plan[j * nu + i]! <= -RIM ? 1 : 0;
        for (let axis = 0; axis < 2; axis++) {
          const o = (axis * LINES + (axis === 0 ? i - this.i0[k]! : j - this.j0[k]!)) * MOMENTS;
          this.line[o]!++;
          this.line[o + 1]! += y;
          this.line[o + 2]! += y * y;
          this.line[o + 3]! += inside;
        }
      }
    }
    let best = Infinity;
    let at = -1;
    for (let axis = 0; axis < 2; axis++) {
      const lines = (axis === 0 ? this.i1[k]! - this.i0[k]! : this.j1[k]! - this.j0[k]!) + 1;
      this.total.fill(0);
      this.left.fill(0);
      for (let m = 0; m < lines; m++) for (let q = 0; q < MOMENTS; q++) this.total[q]! += this.line[(axis * LINES + m) * MOMENTS + q]!;
      for (let m = 0; m < lines - 1; m++) {
        for (let q = 0; q < MOMENTS; q++) {
          this.left[q]! += this.line[(axis * LINES + m) * MOMENTS + q]!;
          this.right[q] = this.total[q]! - this.left[q]!;
        }
        if (this.left[0]! === 0 || this.right[0]! === 0) continue;
        if (this.total[3]! > 0 && (this.left[3]! === 0 || this.right[3]! === 0)) continue;
        const miss = misses(this.left) + misses(this.right);
        if (miss < best) {
          best = miss;
          at = (axis === 0 ? this.i0[k]! : this.j0[k]!) + m;
          this.cutAlongI = axis === 0;
        }
      }
    }
    return best === Infinity ? -1 : at;
  }

  /** Leaf `n` takes the half of leaf `k` that starts after node `at` along i (`alongI`) or j, and `k` keeps the rest. */
  private halve(k: number, n: number, at: number, alongI: boolean): void {
    this.roof[n] = this.roof[k]!;
    this.whole[n] = 0;
    this.whole[k] = 0;
    this.i0[n] = alongI ? at + 1 : this.i0[k]!;
    this.j0[n] = alongI ? this.j0[k]! : at + 1;
    this.i1[n] = this.i1[k]!;
    this.j1[n] = this.j1[k]!;
    if (alongI) this.i1[k] = at;
    else this.j1[k] = at;
  }

  /** Leaf `k` becomes a copy of leaf `n`. */
  private take(k: number, n: number): void {
    this.roof[k] = this.roof[n]!;
    this.rim[k] = this.rim[n]!;
    this.i0[k] = this.i0[n]!;
    this.i1[k] = this.i1[n]!;
    this.j0[k] = this.j0[n]!;
    this.j1[k] = this.j1[n]!;
    this.lo[k] = this.lo[n]!;
    this.hi[k] = this.hi[n]!;
    this.floor[k] = this.floor[n]!;
    this.ceil[k] = this.ceil[n]!;
    this.whole[k] = this.whole[n]!;
  }

  /**
   * Marks the nodes under each standing pane that is not upright (its plan's quad, the cage's top there no more than `GLASS_OVER`
   * over and `GLASS_UNDER` under the glass's plane): the windshield, the rear window and the door glass are the surface there, and a
   * dummy that breaks through one falls into the cabin rather than onto a stair of leaves. A gone pane (`PANE_GONE` in its
   * `paneBits`) opens its quad (`OPEN`: the lower box runs under it) only where the cage's top reaches the glass's plane or stands
   * over it, a header, a pillar or the headliner in the way of a dummy; where the cage's top lies under the plane (the dash, the
   * parcel shelf, the seats the interior shows through the opening) the node stays a leaf at that top, the one law. An upright pane (`GLASS_UPRIGHT`) marks none. The
   * nodes along the glass's base, and along the top of a lying pane (`GLASS_LYING`: a windshield, a rear window; the roof's step
   * meets it there), stay leaves: the glass rests on them; a door's reach one node past its top, the roof's rail behind it.
   */
  private markGlass(f: CageFields, style: CageStyle, glass: Float32Array, paneBits: number): void {
    const { nu, nv, step, u0, v0 } = style;
    this.glassNode.fill(0, 0, nu * nv);
    this.open.set(OPEN_NONE);
    for (let p = 0; p < PANES; p++) {
      const gone = ((paneBits >> (2 * p)) & 3) === PANE_GONE;
      const o = 12 * p;
      const ex = glass[o + 3]! - glass[o]!;
      const ey = glass[o + 4]! - glass[o + 1]!;
      const ez = glass[o + 5]! - glass[o + 2]!;
      const fx = glass[o + 6]! - glass[o]!;
      const fy = glass[o + 7]! - glass[o + 1]!;
      const fz = glass[o + 8]! - glass[o + 2]!;
      const nx = ey * fz - ez * fy;
      const ny = ez * fx - ex * fz;
      const nz = ex * fy - ey * fx;
      const lying = Math.abs(ny) >= GLASS_LYING * hypot3(nx, ny, nz);
      if (Math.abs(ny) < GLASS_UPRIGHT * hypot3(nx, ny, nz)) continue;
      let x0 = Infinity;
      let x1 = -Infinity;
      let z0 = Infinity;
      let z1 = -Infinity;
      for (let k = 0; k < 4; k++) {
        x0 = Math.min(x0, glass[o + 3 * k]!);
        x1 = Math.max(x1, glass[o + 3 * k]!);
        z0 = Math.min(z0, glass[o + 3 * k + 2]!);
        z1 = Math.max(z1, glass[o + 3 * k + 2]!);
      }
      const turn = (glass[o + 3]! - glass[o]!) * (glass[o + 11]! - glass[o + 2]!) - (glass[o + 5]! - glass[o + 2]!) * (glass[o + 9]! - glass[o]!) < 0 ? -1 : 1;
      for (let j = Math.max(0, Math.floor((z0 - v0) / step) - 1); j <= Math.min(nv - 1, Math.floor((z1 - v0) / step) + 1); j++) {
        for (let i = Math.max(0, Math.floor((x0 - u0) / step) - 1); i <= Math.min(nu - 1, Math.floor((x1 - u0) / step) + 1); i++) {
          const n = j * nu + i;
          const x = u0 + (i + 0.5) * step;
          const z = v0 + (j + 0.5) * step;
          let inQuad = true;
          for (let e = 0; e < 4 && inQuad; e++) {
            const a = o + 3 * QUAD_ORDER[e]!;
            const b = o + 3 * QUAD_ORDER[(e + 1) % 4]!;
            const edgeX = glass[b]! - glass[a]!;
            const edgeZ = glass[b + 2]! - glass[a + 2]!;
            const inside = (turn * (edgeX * (z - glass[a + 2]!) - edgeZ * (x - glass[a]!))) / hypot2(edgeX, edgeZ);
            // Base edge: its nodes stay the hood's or the deck's. Top edge: a standing lying pane's stay the roof's (its step meets the glass); a door's reach a node past it, the roof rail the torso passes through the open window. A gone pane opens its quad `PANE_PAD` past its sides and top edge (the standing slab's own pad): no pillar or header stands in the opening a dummy goes through.
            const margin = gone ? (e === 0 ? step : -PANE_PAD) : e === 0 ? step : e === 2 ? (lying ? step : -step) : 0;
            inQuad = inside > margin;
          }
          if (!inQuad) continue;
          const top = f.top[n]!;
          const plane = glass[o + 1]! - (nx * (x - glass[o]!) + nz * (z - glass[o + 2]!)) / ny;
          if (Number.isFinite(top) && (gone ? top >= plane : top - plane <= GLASS_OVER && plane - top <= GLASS_UNDER)) {
            this.glassNode[n] = gone ? OPEN : 1;
            if (!gone) continue;
            this.open[0] = Math.min(this.open[0]!, u0 + i * step);
            this.open[1] = Math.max(this.open[1]!, u0 + i * step);
            this.open[2] = Math.min(this.open[2]!, v0 + j * step);
            this.open[3] = Math.max(this.open[3]!, v0 + j * step);
          }
        }
      }
    }
  }

  /**
   * Fits the leaves to `f` on `style`'s lattice (the body mesh's frame), `plan` its plan distance field, `glass` its panes' corners
   * and `paneBits` their states (`markGlass`): the plan's covered nodes not under a standing pane are cut into rectangles of the
   * nodes under the belt and of those over it (cutting the one whose top spreads most over its area, `cut`) until none spreads
   * over `LEAF_RANGE` or the boxes are used. A leaf under the belt is a column from `UNDER` under the ground up to the middle of
   * its spread (a hood, a deck, a bed), one over it a slab there (the roof), with the lower box under the cabin (the roof leaves
   * of `CABIN_SIDE` nodes each way and over) from `UNDER` under the ground to the sill (first box, only when there is a cabin).
   * Writes `boxes` and `count`.
   */
  fit(f: CageFields, style: CageStyle, plan: Float32Array, glass: Float32Array, paneBits: number): void {
    const { nu, nv, step, u0, v0 } = style;
    this.plan = plan;
    this.markGlass(f, style, glass, paneBits);
    let leaves = 0;
    for (let side = 0; side < 2; side++) {
      this.roof[leaves] = side;
      this.whole[leaves] = 0;
      this.i0[leaves] = Math.max(0, Math.round((f.planBox[0]! - u0) / step));
      this.i1[leaves] = Math.min(nu - 1, Math.round((f.planBox[1]! - u0) / step));
      this.j0[leaves] = Math.max(0, Math.round((f.planBox[2]! - v0) / step));
      this.j1[leaves] = Math.min(nv - 1, Math.round((f.planBox[3]! - v0) / step));
      if (this.measure(leaves, f, nu)) leaves++;
    }
    while (leaves < PROXY_BOXES - 1) {
      let k = -1;
      let worst = 0;
      for (let n = 0; n < leaves; n++) {
        const area = (this.i1[n]! - this.i0[n]! + 1) * (this.j1[n]! - this.j0[n]! + 1);
        const off = (this.hi[n]! - this.lo[n]! - LEAF_RANGE) * area;
        if (off > worst && area > 1 && this.whole[n] === 0) {
          worst = off;
          k = n;
        }
      }
      if (k < 0) break;
      const at = this.cut(k, f, nu);
      if (at < 0) {
        this.whole[k] = 1;
        continue;
      }
      this.halve(k, leaves, at, this.cutAlongI);
      const kept = this.measure(k, f, nu);
      const moved = this.measure(leaves, f, nu);
      if (!kept && moved) this.take(k, leaves);
      else if (kept && moved) leaves++;
    }
    this.emit(leaves, style);
  }

  /** Writes the boxes of the `leaves` fitted: the lower box first (when a roof leaf is among them), then each leaf. */
  private emit(leaves: number, style: CageStyle): void {
    const { step, u0, v0 } = style;
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (let k = 0; k < leaves; k++) {
      if (this.roof[k] === 0 || Math.min(this.i1[k]! - this.i0[k]!, this.j1[k]! - this.j0[k]!) + 1 < CABIN_SIDE) continue;
      x0 = Math.min(x0, u0 + this.i0[k]! * step);
      x1 = Math.max(x1, u0 + this.i1[k]! * step);
      z0 = Math.min(z0, v0 + this.j0[k]! * step);
      z1 = Math.max(z1, v0 + this.j1[k]! * step);
    }
    if (x1 >= x0) {
      x0 = Math.min(x0, this.open[0]!);
      x1 = Math.max(x1, this.open[1]!);
      z0 = Math.min(z0, this.open[2]!);
      z1 = Math.max(z1, this.open[3]!);
    }
    let n = 0;
    if (x1 >= x0) this.setTurned(n++, (x0 + x1) / 2 + SHIFT, (SILL_Y - UNDER) / 2, (z0 + z1) / 2 + SHIFT, (x1 - x0 + step) / 2, (SILL_Y + UNDER) / 2, (z1 - z0 + step) / 2, 0, 0, 0, 1, this.boxes);
    for (let k = 0; k < leaves; k++) {
      const top = (this.lo[k]! + this.hi[k]!) / 2 + TOP_BIAS;
      const hy = this.roof[k] === 1 ? ROOF_HALF : (top + UNDER) / 2;
      this.setTurned(
        n++,
        u0 + ((this.i0[k]! + this.i1[k]!) / 2) * step + SHIFT,
        top - hy,
        v0 + ((this.j0[k]! + this.j1[k]!) / 2) * step + SHIFT,
        ((this.i1[k]! - this.i0[k]! + 1) * step) / 2,
        hy,
        ((this.j1[k]! - this.j0[k]! + 1) * step) / 2,
        0,
        0,
        0,
        1,
        this.boxes,
      );
    }
    this.count = n;
  }

  /** Box `n` of `into` about (`cx`, `cy`, `cz`) with half extents (`hx`, `hy`, `hz`) turned by (`qx`, `qy`, `qz`, `qw`). */
  private setTurned(n: number, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, qx: number, qy: number, qz: number, qw: number, into: Float64Array): void {
    const o = n * BOX_FLOATS;
    into[o] = cx;
    into[o + 1] = cy;
    into[o + 2] = cz;
    into[o + 3] = hx;
    into[o + 4] = hy;
    into[o + 5] = hz;
    into[o + 6] = qx;
    into[o + 7] = qy;
    into[o + 8] = qz;
    into[o + 9] = qw;
  }

  /** The cage's top (m, body frame) at (`x`, `z`): its nodes round it blended, those with none left out; NaN when none has one. */
  private topAt(f: CageFields, style: CageStyle, x: number, z: number): number {
    const fu = (x - style.u0) / style.step;
    const fv = (z - style.v0) / style.step;
    const i = Math.floor(fu);
    const j = Math.floor(fv);
    let sum = 0;
    let weight = 0;
    for (let b = 0; b < 2; b++) {
      for (let a = 0; a < 2; a++) {
        if (i + a < 0 || j + b < 0 || i + a >= style.nu || j + b >= style.nv) continue;
        const t = f.top[(j + b) * style.nu + i + a]!;
        if (!Number.isFinite(t)) continue;
        const w = (a === 0 ? 1 - (fu - i) : fu - i) * (b === 0 ? 1 - (fv - j) : fv - j);
        sum += t * w;
        weight += w;
      }
    }
    return weight > 0 ? sum / weight : NaN;
  }

  /**
   * Fits each pane's slab to its glass's corners `glass` (`glassCorners`: per pane, across 0 and 1 at the base, then at the top,
   * xyz each, as the body mesh has them), a corner taken down to the cage's top where the cage is under it (a crushed roof takes its
   * glass down): a cuboid on the glass's middle turned to its plane, `PANE_PAD` past its sides, `PANE_HALF` inside it (away from
   * the middle of all the glass), `step` / 2 out of the glass. Writes `panes`.
   */
  fitPanes(f: CageFields, style: CageStyle, glass: Float32Array): void {
    let mx = 0;
    let my = 0;
    let mz = 0;
    for (let k = 0; k < glass.length; k += 3) {
      mx += glass[k]!;
      my += glass[k + 1]!;
      mz += glass[k + 2]!;
    }
    mx /= glass.length / 3;
    my /= glass.length / 3;
    mz /= glass.length / 3;
    for (let p = 0; p < PANES; p++) {
      for (let k = 0; k < 4; k++) {
        const o = 12 * p + 3 * k;
        const top = this.topAt(f, style, glass[o]!, glass[o + 2]!);
        this.corner[3 * k] = glass[o]!;
        this.corner[3 * k + 1] = Number.isFinite(top) ? Math.min(glass[o + 1]!, top) : glass[o + 1]!;
        this.corner[3 * k + 2] = glass[o + 2]!;
      }
      this.paneSlab(p, mx, my, mz);
    }
  }

  /** Pane `p`'s slab from `corner` (its four corners), turned outward from (`mx`, `my`, `mz`). */
  private paneSlab(p: number, mx: number, my: number, mz: number): void {
    const k = this.corner;
    _x.set(k[3]! - k[0]! + k[9]! - k[6]!, k[4]! - k[1]! + k[10]! - k[7]!, k[5]! - k[2]! + k[11]! - k[8]!);
    _y.set(k[6]! - k[0]! + k[9]! - k[3]!, k[7]! - k[1]! + k[10]! - k[4]!, k[8]! - k[2]! + k[11]! - k[5]!);
    _u.copy(_y).normalize();
    const width = hypot3(k[3]! - k[0]!, k[4]! - k[1]!, k[5]! - k[2]!) + hypot3(k[9]! - k[6]!, k[10]! - k[7]!, k[11]! - k[8]!);
    const height = hypot3(k[6]! - k[0]!, k[7]! - k[1]!, k[8]! - k[2]!) + hypot3(k[9]! - k[3]!, k[10]! - k[4]!, k[11]! - k[5]!);
    const cx = (k[0]! + k[3]! + k[6]! + k[9]!) / 4;
    const cy = (k[1]! + k[4]! + k[7]! + k[10]!) / 4;
    const cz = (k[2]! + k[5]! + k[8]! + k[11]!) / 4;
    _z.crossVectors(_x, _y).normalize();
    if (_z.x * (cx - mx) + _z.y * (cy - my) + _z.z * (cz - mz) < 0) _z.negate();
    _x.normalize();
    _y.crossVectors(_z, _x);
    _q.setFromRotationMatrix(_basis.makeBasis(_x, _y, _z));
    // The slab stops `PANE_TOP_TRIM` short of the glass's top: its half length shrinks by half that and its middle moves toward the base by as much.
    const slide = PANE_TOP_TRIM / 2;
    this.setTurned(p, cx - _z.x * PANE_HALF - _u.x * slide, cy - _z.y * PANE_HALF - _u.y * slide, cz - _z.z * PANE_HALF - _u.z * slide, width / 4 + PANE_PAD, height / 4 - slide, PANE_HALF, _q.x, _q.y, _q.z, _q.w, this.panes);
  }
}
