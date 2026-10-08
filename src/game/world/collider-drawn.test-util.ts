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

/** Distance (m) from a point to a collider as a solid (0 inside): a yawed box or a circle, a prism from `base` to `top`. */
export function gap(c: PropCollider, x: number, y: number, z: number): number {
  const ex = x - c.x;
  const ez = z - c.z;
  const lx = ex * Math.cos(c.yaw) - ez * Math.sin(c.yaw);
  const lz = ex * Math.sin(c.yaw) + ez * Math.cos(c.yaw);
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

/** Distance (m) from a point to the nearest of `tris` (9 floats each), skipping the ones whose bounds are further than `within`. */
export function meshGap(tris: Float32Array, x: number, y: number, z: number, within: number): number {
  let best = Infinity;
  _p.set(x, y, z);
  for (let t = 0; t + 8 < tris.length; t += 9) {
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
  return best;
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
  const mats = { plain, concrete: plain, building: plain, billboard: plain };
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
  const inward: Worst = { d: 0, at: "" };
  // Drawn points over the ground only: what stands under it is never seen or met.
  for (const [x, y, z] of drawnPoints(all)) {
    if (y < 0) continue;
    let d = Infinity;
    for (const c of pieces) d = Math.min(d, gap(c, x, y, z));
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
        if (pieces.some((o, i) => i !== k && gap(o, x, y, z) < 1e-9)) continue;
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
