import * as THREE from "three";
import { prefabParts } from "../present/prefabs.ts";
import type { PrefabId } from "./catalog.ts";
import { propColliders, type PropCollider } from "./placements.ts";

/** `prefabParts` paints canvas textures: a stand-in that draws nothing. */
Object.defineProperty(globalThis, "document", {
  value: { createElement: () => ({ width: 0, height: 0, getContext: () => ({ createRadialGradient: () => ({ addColorStop() {} }), fillRect() {}, fillStyle: "" }) }) },
  configurable: true,
});

/** How high (m) over a prop's foot a car meets it: the faces above are not measured "out". */
export const BAND = 3;
/** Height step (m) at which drawn triangles are cut to read a shape's plan at each height. */
const SLICE = 0.05;
/** The lowest a sampled face point is taken (m over its prop's foot): a car's skirt, not the ground. */
const SKIRT = 0.2;
/** Triangles further than this (m) from a sampled point are not looked at: a point with none is `Infinity` off the drawn shape. */
const REACH = 3.5;

export type P3 = readonly [number, number, number];

/** Distance (m) from a point to a collider as a solid (0 inside): a yawed box or a circle, a prism from `base` to `top`. `cos`, `sin`: the collider's yaw's, for a caller measuring many points against one. */
export function gap(c: PropCollider, x: number, y: number, z: number, cos = Math.cos(c.yaw), sin = Math.sin(c.yaw)): number {
  const ex = x - c.x;
  const ez = z - c.z;
  const lx = ex * cos - ez * sin;
  const lz = ex * sin + ez * cos;
  const dy = Math.max(c.base - y, y - c.top, 0);
  if (c.kind === "circle") return Math.hypot(Math.max(Math.hypot(lx, lz) - c.hx, 0), dy);
  return Math.hypot(Math.max(Math.abs(lx) - c.hx, 0), Math.max(Math.abs(lz) - c.hz, 0), dy);
}

/** The triangles (9 floats each) of a geometry, world space. */
export function triangles(g: THREE.BufferGeometry): Float32Array {
  const pos = g.getAttribute("position");
  const idx = g.index;
  const n = idx ? idx.count : pos.count;
  const out = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) {
    const v = idx ? idx.getX(k) : k;
    out[k * 3] = pos.getX(v);
    out[k * 3 + 1] = pos.getY(v);
    out[k * 3 + 2] = pos.getZ(v);
  }
  return out;
}

/** Every vertex of `tris` and the points where every `SLICE`-spaced horizontal plane crosses its triangle edges: the shape's plan at each height. */
function drawnPoints(tris: Float32Array): P3[] {
  const out: P3[] = [];
  for (let i = 0; i < tris.length; i += 3) out.push([tris[i]!, tris[i + 1]!, tris[i + 2]!]);
  for (let t = 0; t + 8 < tris.length; t += 9) {
    for (const [a, b] of [[0, 3], [3, 6], [6, 0]] as const) {
      const ay = tris[t + a + 1]!;
      const by = tris[t + b + 1]!;
      if (ay === by) continue;
      const lo = Math.min(ay, by);
      const hi = Math.max(ay, by);
      for (let h = Math.ceil(lo / SLICE) * SLICE; h <= hi; h += SLICE) {
        const k = (h - ay) / (by - ay);
        out.push([tris[t + a]! + (tris[t + b]! - tris[t + a]!) * k, h, tris[t + a + 2]! + (tris[t + b + 2]! - tris[t + a + 2]!) * k]);
      }
    }
  }
  return out;
}

const _tri = new THREE.Triangle();
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();

/** Edge (m) of a cell of the plan-view grid `meshGap` looks triangles up in. */
const CELL = 4;

/** The plan-view grid of a triangle list: per cell, the triangles whose bounds touch it, so a query reads the few near it, not all. */
type TriangleGrid = Map<number, number[]>;
const cellKey = (ix: number, iz: number): number => (ix + 32768) * 65536 + (iz + 32768);
const grids = new WeakMap<Float32Array, TriangleGrid>();

function gridOf(tris: Float32Array): TriangleGrid {
  let grid = grids.get(tris);
  if (grid) return grid;
  grid = new Map();
  for (let t = 0; t + 8 < tris.length; t += 9) {
    const x0 = Math.min(tris[t]!, tris[t + 3]!, tris[t + 6]!);
    const x1 = Math.max(tris[t]!, tris[t + 3]!, tris[t + 6]!);
    const z0 = Math.min(tris[t + 2]!, tris[t + 5]!, tris[t + 8]!);
    const z1 = Math.max(tris[t + 2]!, tris[t + 5]!, tris[t + 8]!);
    for (let ix = Math.floor(x0 / CELL); ix <= Math.floor(x1 / CELL); ix++) {
      for (let iz = Math.floor(z0 / CELL); iz <= Math.floor(z1 / CELL); iz++) {
        const key = cellKey(ix, iz);
        const cell = grid.get(key);
        if (cell) cell.push(t);
        else grid.set(key, [t]);
      }
    }
  }
  grids.set(tris, grid);
  return grid;
}

/** Distance (m) from a point to the nearest of `tris` (9 floats each), skipping the ones whose bounds are further than `within`. */
export function meshGap(tris: Float32Array, x: number, y: number, z: number, within: number): number {
  const grid = gridOf(tris);
  let best = Infinity;
  _p.set(x, y, z);
  for (let ix = Math.floor((x - within) / CELL); ix <= Math.floor((x + within) / CELL); ix++) {
    for (let iz = Math.floor((z - within) / CELL); iz <= Math.floor((z + within) / CELL); iz++) {
      for (const t of grid.get(cellKey(ix, iz)) ?? []) {
        let ok = true;
        for (let a = 0; a < 3 && ok; a++) {
          const c = a === 0 ? x : a === 1 ? y : z;
          const lo = Math.min(tris[t + a]!, tris[t + 3 + a]!, tris[t + 6 + a]!);
          const hi = Math.max(tris[t + a]!, tris[t + 3 + a]!, tris[t + 6 + a]!);
          if (c < lo - within || c > hi + within) ok = false;
        }
        if (!ok) continue;
        _tri.a.set(tris[t]!, tris[t + 1]!, tris[t + 2]!);
        _tri.b.set(tris[t + 3]!, tris[t + 4]!, tris[t + 5]!);
        _tri.c.set(tris[t + 6]!, tris[t + 7]!, tris[t + 8]!);
        best = Math.min(best, _tri.closestPointToPoint(_p, _q).distanceTo(_p));
      }
    }
  }
  return best;
}

/** Edge (m) of a cell of the plan-view grid `pieceGrid` looks colliders up in. */
const PIECE_CELL = 8;

/** A plan-view grid of colliders: `near(x, z)` lists every piece whose circle (radius `r` plus `margin`) can reach that point, and some that cannot. */
export function pieceGrid(pieces: readonly PropCollider[], margin: number): (x: number, z: number) => readonly PropCollider[] {
  const grid = new Map<number, PropCollider[]>();
  for (const c of pieces) {
    const reach = c.r + margin;
    for (let ix = Math.floor((c.x - reach) / PIECE_CELL); ix <= Math.floor((c.x + reach) / PIECE_CELL); ix++) {
      for (let iz = Math.floor((c.z - reach) / PIECE_CELL); iz <= Math.floor((c.z + reach) / PIECE_CELL); iz++) {
        const key = cellKey(ix, iz);
        const cell = grid.get(key);
        if (cell) cell.push(c);
        else grid.set(key, [c]);
      }
    }
  }
  return (x, z) => grid.get(cellKey(Math.floor(x / PIECE_CELL), Math.floor(z / PIECE_CELL))) ?? [];
}

/** The farthest (m) of one kind, and where. */
export type Worst = { d: number; at: string };

/**
 * A prop's colliders against its drawn geometry, both ways, at scale 1 and yaw 0. `inward`: how far drawn points over the ground
 * stand out of the colliders (a part you drive into). `outward`: how far points over the faces of the collider pieces, up to `BAND`
 * over the foot, stand off the drawn shape (a wall you hit in the air); a point inside another piece of the prop is inside the
 * union and not a face of it.
 */
export function prefabGap(id: PrefabId): { pieces: number; inward: Worst; outward: Worst } {
  const pieces = propColliders([{ prefab: id, x: 0, y: 0, z: 0, yaw: 0, sx: 1, sy: 1, sz: 1 }]);
  const plain = new THREE.MeshBasicMaterial();
  const mats = { plain, concrete: plain, building: plain, billboard: plain, water: plain };
  // The art's own geometry: every part but a flat decal on the ground (a lamp's light pool).
  const parts = prefabParts(id, mats).map((p) => triangles(p.geometry));
  const solid = parts.filter((t) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 1; i < t.length; i += 3) {
      lo = Math.min(lo, t[i]!);
      hi = Math.max(hi, t[i]!);
    }
    return hi - lo >= SLICE;
  });
  const all = new Float32Array(solid.reduce((n, t) => n + t.length, 0));
  let at = 0;
  for (const t of solid) {
    all.set(t, at);
    at += t.length;
  }
  const cosines = pieces.map((c) => Math.cos(c.yaw));
  const sines = pieces.map((c) => Math.sin(c.yaw));
  /** Whether a piece other than `skip` lies within `limit` m of the point: only pieces whose circumscribed circle reaches it are measured (`r`, exact for a prop piece). */
  const pieceWithin = (x: number, y: number, z: number, limit: number, skip = -1): boolean => {
    for (let i = 0; i < pieces.length; i++) {
      const c = pieces[i]!;
      const reach = c.r + limit + 1e-6;
      if (i === skip || (x - c.x) ** 2 + (z - c.z) ** 2 > reach * reach) continue;
      if (gap(c, x, y, z, cosines[i], sines[i]) <= limit) return true;
    }
    return false;
  };
  const inward: Worst = { d: 0, at: "" };
  // Drawn points over the ground only: what stands under it is never seen or met.
  for (const [x, y, z] of drawnPoints(all)) {
    // A piece within the worst so far: this point is no worse than it.
    if (y < 0 || pieceWithin(x, y, z, inward.d)) continue;
    let d = Infinity;
    for (let i = 0; i < pieces.length; i++) d = Math.min(d, gap(pieces[i]!, x, y, z, cosines[i], sines[i]));
    if (d > inward.d) {
      inward.d = d;
      inward.at = `(${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`;
    }
  }
  const outward: Worst = { d: 0, at: "" };
  for (const [k, c] of pieces.entries()) {
    const sn = Math.sin(c.yaw);
    const cs = Math.cos(c.yaw);
    const ring: [number, number][] = [];
    if (c.kind === "circle") for (let a = 0; a < 24; a++) ring.push([c.hx * Math.cos((a * Math.PI) / 12), c.hx * Math.sin((a * Math.PI) / 12)]);
    else for (const u of [-1, 0, 1]) for (const w of [-1, 0, 1]) if (u || w) ring.push([u * c.hx, w * c.hz]);
    const low = Math.min(Math.max(c.base, SKIRT), c.top);
    const ys = [low, (low + c.top) / 2, c.top].filter((y) => y <= BAND);
    for (const [u, w] of ring) {
      const x = c.x + u * cs + w * sn;
      const z = c.z - u * sn + w * cs;
      for (const y of ys) {
        if (pieceWithin(x, y, z, 1e-9, k)) continue;
        const d = meshGap(all, x, y, z, REACH);
        if (d > outward.d) {
          outward.d = d;
          outward.at = `piece ${k} (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`;
        }
      }
    }
  }
  return { pieces: pieces.length, inward, outward };
}
