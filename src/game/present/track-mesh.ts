import * as THREE from "three";
import { hypot2, hypot3 } from "../kernel/physics-core.js";
import { clamp } from "../kernel/scalar.ts";
import { SURFACE_IDS, SURFACES } from "../world/catalog.ts";
import { blankSegment, segmentAt, type TrackPath } from "../world/track.ts";

/** Track art building blocks: sizes, colours, the `Mesher` vertex list, path sampling and the `RoadIndex` every piece shares. */

/** Terrain: 8 m blocks, split into 2 m cells near roads and wherever the ground is not flat. */
export const BLOCK = 8;
export const CELL = 2;
/** A block stays one quad when no cell height is further than this (m) from its corners' bilinear. */
export const FLAT_TOL = 0.06;
export const SKIRT_RADIUS = 900;
/** Lifts over the ground (m); `ground-stack.ts` orders overlapping layers by draw order, not by these. */
export const ROAD_LIFT = 0.015;
export const MARK_LIFT = 0.045;
export const KERB_LIFT = 0.06;
/** Kerbs go on the inside of turns tighter than 60 m. */
export const KERB_CURV = 1 / 60;
/** A kerb takes the strongest curvature within this many samples (≈ m), so spline ripple never gaps it. */
export const KERB_FILL = 6;
/** Shadow depth materials for the instanced props (`forDraw`): three's own one draws the plain casters. */
export const DEPTH_INSTANCED = new THREE.MeshDepthMaterial();
export const DEPTH_INSTANCED_COLOR = new THREE.MeshDepthMaterial();
export type DrawKind = "plain" | "instanced" | "instancedColour";
export const KERB_WIDTH = 1.1;
/** Start / finish chequer depth (m), centred on s = 0; lines stop short of it. */
export const CHEQUER = 2;
export const GANTRY_BEAM = 6.6;
export const DECK_THICK = 1.0;
/** Deck slab reach beyond the wall line (m): the wall's 0.6 m foot plus a lip. */
export const DECK_LIP = 0.75;
export const PILLAR_EVERY = 12;
export const PILLAR_R = 0.5;
/** Tunnel: inner face this far (m) outside the wall line, side height and shell thickness (m). */
export const TUNNEL_GAP = 0.8;
export const TUNNEL_SIDE = 4.4;
export const TUNNEL_SHELL = 0.7;
export const TUNNEL_LIGHT_EVERY = 10;
export const ARCH_STEPS = 6;

export const WHITE = 0xe8e6e0;
export const RED = 0xc8261c;
export const BLACK = 0x15161a;
export const CONCRETE = 0xc4bfb3;
export const CONCRETE_DARK = 0x9e998e;
export const DECK_COL = 0xb7b1a4;
export const TUNNEL_IN = 0x34353a;
export const TUNNEL_TILE = 0x6c6d70;
export const TUNNEL_LIGHT = 0xfff0c8;

/** Start-light colours (linear RGB): red, yellow, green; lit × LIGHT_ON (HDR, so bloom catches it), unlit × LIGHT_OFF. */
export const LIGHT_RGB: readonly (readonly [number, number, number])[] = [
  [1, 0.06, 0.03],
  [1, 0.72, 0.04],
  [0.12, 1, 0.25],
];
export const LIGHT_ON = 3;
export const LIGHT_OFF = 0.03;

export const PAVED = [SURFACE_IDS.indexOf("asphalt"), SURFACE_IDS.indexOf("concrete")];

/** Growing vertex list (position, normal, linear colour, uv) with triangle indices. */
export class Mesher {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly col: number[] = [];
  readonly uv: number[] = [];
  readonly idx: number[] = [];
  private readonly c = new THREE.Color();
  /** The colour `c` holds, so a run of vertices in one colour converts it once. */
  private hex = -1;

  v(x: number, y: number, z: number, hex: number, u = 0, w = 0, shade = 1): number {
    if (hex !== this.hex) {
      this.c.setHex(hex);
      this.hex = hex;
    }
    this.pos.push(x, y, z);
    this.nrm.push(0, 1, 0);
    this.col.push(this.c.r * shade, this.c.g * shade, this.c.b * shade);
    this.uv.push(u, w);
    return this.pos.length / 3 - 1;
  }

  normal(i: number, x: number, y: number, z: number): void {
    const l = hypot3(x, y, z) || 1;
    this.nrm[i * 3] = x / l;
    this.nrm[i * 3 + 1] = y / l;
    this.nrm[i * 3 + 2] = z / l;
  }

  /** Quad a→b at one section, c→d at the next; front faces up when b is left of a and c is ahead of a. */
  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, c, b, b, c, d);
  }

  get empty(): boolean {
    return this.idx.length === 0;
  }

  /** `smooth`: recompute normals from the triangles (shared vertices blend); otherwise keep the set ones. */
  geometry(smooth: boolean): THREE.BufferGeometry {
    const g = this.part(0, this.pos.length / 3, 0, this.idx.length);
    if (smooth) g.computeVertexNormals();
    return g;
  }

  /**
   * Vertices [v0, v1) and the triangle indices [i0, i1), which use only those vertices, as a geometry of their own
   * (normals as set), its bounds already read (three culls by them; a `BatchedMesh` takes them as given).
   */
  part(v0: number, v1: number, i0: number, i1: number): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos.slice(v0 * 3, v1 * 3), 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nrm.slice(v0 * 3, v1 * 3), 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col.slice(v0 * 3, v1 * 3), 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv.slice(v0 * 2, v1 * 2), 2));
    g.setIndex(this.idx.slice(i0, i1).map((i) => i - v0));
    g.computeBoundingSphere();
    return g;
  }
}

export function surfaceHex(index: number): number {
  return SURFACES[SURFACE_IDS[index]!].color;
}

/** Texture family of a surface: asphalt, concrete, or natural ground. */
export function texClass(index: number): "asphalt" | "concrete" | "detail" {
  const id = SURFACE_IDS[index]!;
  return id === "asphalt" ? "asphalt" : id === "concrete" ? "concrete" : "detail";
}

/** Deterministic 0..1 per (i, salt). */
export function hash01(i: number, salt: number): number {
  let x = Math.imul(i ^ Math.imul(salt + 1, 0x9e3779b9), 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** Low-frequency colour mottling: hash on the 8 m block lattice, bilinear between. */
export function mottle(x: number, z: number): number {
  const u = x / BLOCK;
  const v = z / BLOCK;
  const i = Math.floor(u);
  const j = Math.floor(v);
  const fu = u - i;
  const fv = v - j;
  const h = (a: number, b: number) => hash01(a * 7919 + b, 3);
  const a = h(i, j) + (h(i + 1, j) - h(i, j)) * fu;
  const b = h(i, j + 1) + (h(i + 1, j + 1) - h(i, j + 1)) * fu;
  return 0.9 + 0.2 * (a + (b - a) * fv);
}

/** Sample index at arc length s (wrapped on a loop, clamped on an open path). */
export function sampleAt(p: TrackPath, s: number): number {
  const segs = p.closed ? p.count : p.count - 1;
  const k = Math.floor((s / p.length) * segs);
  return p.closed ? ((k % p.count) + p.count) % p.count : clamp(k, 0, p.count - 1);
}

const IDX_CELL = 8;

/** Path segments by 8 m cell: which road covers a point, and whether a point lies on another road. */
export class RoadIndex {
  private readonly cells = new Map<number, number[]>();
  private readonly seg = blankSegment();
  private readonly paths: readonly TrackPath[];

  constructor(paths: readonly TrackPath[]) {
    this.paths = paths;
    for (const [pi, p] of paths.entries()) {
      const segs = p.closed ? p.count : p.count - 1;
      for (let k = 0; k < segs; k++) {
        const b = (k + 1) % p.count;
        const r = p.half[k]! + Math.max(p.runL[k]!, p.runR[k]!) + 3;
        const i0 = Math.floor((Math.min(p.x[k]!, p.x[b]!) - r) / IDX_CELL);
        const i1 = Math.floor((Math.max(p.x[k]!, p.x[b]!) + r) / IDX_CELL);
        const j0 = Math.floor((Math.min(p.z[k]!, p.z[b]!) - r) / IDX_CELL);
        const j1 = Math.floor((Math.max(p.z[k]!, p.z[b]!) + r) / IDX_CELL);
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const key = (i + 4096) * 8192 + (j + 4096);
            const list = this.cells.get(key);
            if (list) list.push(pi * 65536 + k);
            else this.cells.set(key, [pi * 65536 + k]);
          }
        }
      }
    }
  }

  private list(x: number, z: number): number[] | undefined {
    return this.cells.get((Math.floor(x / IDX_CELL) + 4096) * 8192 + (Math.floor(z / IDX_CELL) + 4096));
  }

  /**
   * Index of a path whose ribbon (bridge spans excluded) covers (x, z) at least `inset` m inside its
   * edge (negative: within that pad outside it), −1 when none. Open ends are cut square like the ribbon.
   */
  coveredBy(x: number, z: number, inset: number): number {
    const list = this.list(x, z);
    if (!list) return -1;
    for (const e of list) {
      const pi = e >>> 16;
      const k = e & 0xffff;
      const p = this.paths[pi]!;
      if (p.deck[k]) continue;
      const { ex, ez, len2, f } = segmentAt(p, k, x, z, this.seg);
      if (f < (!p.closed && k === 0 ? 0 : -0.1) || f > (!p.closed && k === p.count - 2 ? 1 : 1.1)) continue;
      const lat = ((x - p.x[k]!) * ez - (z - p.z[k]!) * ex) / Math.sqrt(len2);
      if (Math.abs(lat) <= p.half[k]! + (lat > 0 ? p.runL[k]! : p.runR[k]!) - inset) return pi;
    }
    return -1;
  }

  /** True when (x, z) at height y lies on the road or runoff (+ `pad`) of a path other than `self`, on that path's level. */
  onOther(self: number, x: number, z: number, y: number, pad: number): boolean {
    const list = this.list(x, z);
    if (!list) return false;
    for (const e of list) {
      const pi = e >>> 16;
      if (pi === self) continue;
      const k = e & 0xffff;
      const p = this.paths[pi]!;
      const { b, ex, ez, len2, f: along } = segmentAt(p, k, x, z, this.seg);
      const f = clamp(along, 0, 1);
      if (Math.abs(p.y[k]! + (p.y[b]! - p.y[k]!) * f - y) > 2.5) continue;
      const dx = x - p.x[k]! - ex * f;
      const dz = z - p.z[k]! - ez * f;
      const lat = (dx * ez - dz * ex) / Math.sqrt(len2);
      if (hypot2(dx, dz) <= p.half[k]! + (lat > 0 ? p.runL[k]! : p.runR[k]!) + pad) return true;
    }
    return false;
  }
}
