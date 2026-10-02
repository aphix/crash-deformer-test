import * as THREE from "three";
import { clamp } from "../scalar.ts";
import { applyMarkMap } from "../engine-marks.ts";
import { PREFABS, SURFACE_IDS, SURFACES, type PrefabId, type SurfaceId } from "./catalog.ts";
import type { Placed } from "./placements.ts";
import { TILE, box, makePrefabMaterials, makeRaceTextures, painted, prefabParts, type Piece, type RaceTextures } from "./prefabs.ts";
import { blankPoint, blankSegment, pointOn, segmentAt, type Track, type TrackGround, type TrackPath } from "./track.ts";

/**
 * The visible course: terrain (with a far skirt), road / runoff ribbons for the loop, shortcuts and
 * traffic routes, markings and kerbs, walls, bridge decks with pillars, tunnels, the start gantry and
 * every placed prop, in a few dozen draw calls. Heights come from `track.ground()` with the path's
 * own level as the layer hint, so a road under a bridge and the deck above it both sit right.
 */

export type RaceMeshKind = "road" | "runoff" | "terrain" | "wall" | "marking" | "kerb" | "deck" | "pillar" | "tunnel" | "prop";
export type RaceMeshTag = { kind: RaceMeshKind; surface?: SurfaceId; prefab?: PrefabId };

/** Terrain: 8 m blocks, split into 2 m cells near roads and wherever the ground is not flat. */
const BLOCK = 8;
const CELL = 2;
/** A block stays one quad when no cell height is further than this (m) from its corners' bilinear. */
const FLAT_TOL = 0.06;
const SKIRT_RADIUS = 900;
/** Lifts over the ground (m); the terrain is also pushed back with a polygon offset. */
const ROAD_LIFT = 0.015;
const SIDE_LIFT = 0.03;
const MARK_LIFT = 0.045;
const KERB_LIFT = 0.06;
/** Section spacing cap (m); bends get closer sections (chord sagitta ≤ 2 cm). */
const MAX_STEP = 4;
/** Wall stripe length (m). */
const WALL_PERIOD = 4;
/** Kerbs go on the inside of turns tighter than 60 m. */
const KERB_CURV = 1 / 60;
/** A kerb takes the strongest curvature within this many samples (≈ m), so spline ripple never gaps it. */
const KERB_FILL = 6;
/** Shadow depth materials for the instanced props (`forDraw`): three's own one draws the plain casters. */
const DEPTH_INSTANCED = new THREE.MeshDepthMaterial();
const DEPTH_INSTANCED_COLOR = new THREE.MeshDepthMaterial();
type DrawKind = "plain" | "instanced" | "instancedColour";
const KERB_WIDTH = 1.1;
/** Start / finish chequer depth (m), centred on s = 0; lines stop short of it. */
const CHEQUER = 2;
const GANTRY_BEAM = 6.6;
const DECK_THICK = 1.0;
/** Deck slab reach beyond the wall line (m): the wall's 0.6 m foot plus a lip. */
const DECK_LIP = 0.75;
const PILLAR_EVERY = 12;
const PILLAR_R = 0.5;
/** Tunnel: inner face this far (m) outside the wall line, side height and shell thickness (m). */
const TUNNEL_GAP = 0.8;
const TUNNEL_SIDE = 4.4;
const TUNNEL_SHELL = 0.7;
const TUNNEL_LIGHT_EVERY = 10;
const ARCH_STEPS = 6;
const GRAVITY = 9.81;

const WHITE = 0xe8e6e0;
const RED = 0xc8261c;
const BLACK = 0x15161a;
const CONCRETE = 0xc4bfb3;
const CONCRETE_DARK = 0x9e998e;
const DECK_COL = 0xb7b1a4;
const TUNNEL_IN = 0x34353a;
const TUNNEL_TILE = 0x6c6d70;
const TUNNEL_LIGHT = 0xfff0c8;

/** Wall cross-section (u outward from the wall line, v up), v > 0 as fractions of the wall height. */
const WALL_PROFILE: readonly (readonly [number, number])[] = [
  [0, -0.3],
  [0, 0.09],
  [0.14, 0.4],
  [0.21, 1],
  [0.39, 1],
  [0.46, 0.4],
  [0.6, 0.09],
  [0.6, -0.3],
];

/** Start-light colours (linear RGB): red, yellow, green; lit × LIGHT_ON (HDR, so bloom catches it), unlit × LIGHT_OFF. */
const LIGHT_RGB: readonly (readonly [number, number, number])[] = [
  [1, 0.06, 0.03],
  [1, 0.72, 0.04],
  [0.12, 1, 0.25],
];
const LIGHT_ON = 3;
const LIGHT_OFF = 0.03;

const PAVED = [SURFACE_IDS.indexOf("asphalt"), SURFACE_IDS.indexOf("concrete")];

/** Growing vertex list (position, normal, linear colour, uv) with triangle indices. */
class Mesher {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly col: number[] = [];
  readonly uv: number[] = [];
  readonly idx: number[] = [];
  private readonly c = new THREE.Color();

  v(x: number, y: number, z: number, hex: number, u = 0, w = 0, shade = 1): number {
    this.c.setHex(hex);
    this.pos.push(x, y, z);
    this.nrm.push(0, 1, 0);
    this.col.push(this.c.r * shade, this.c.g * shade, this.c.b * shade);
    this.uv.push(u, w);
    return this.pos.length / 3 - 1;
  }

  normal(i: number, x: number, y: number, z: number): void {
    const l = Math.hypot(x, y, z) || 1;
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
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    if (smooth) g.computeVertexNormals();
    return g;
  }
}

function surfaceHex(index: number): number {
  return SURFACES[SURFACE_IDS[index]!].color;
}

/** Texture family of a surface: asphalt, concrete, or natural ground. */
function texClass(index: number): "asphalt" | "concrete" | "detail" {
  const id = SURFACE_IDS[index]!;
  return id === "asphalt" ? "asphalt" : id === "concrete" ? "concrete" : "detail";
}

/** Deterministic 0..1 per (i, salt). */
function hash01(i: number, salt: number): number {
  let x = Math.imul(i ^ Math.imul(salt + 1, 0x9e3779b9), 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** Low-frequency colour mottling: hash on the 8 m block lattice, bilinear between. */
function mottle(x: number, z: number): number {
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

/** Path height at lateral `lat` of sample k (banked plane, flat beyond the road edge): the ground layer hint. */
function levelAt(p: TrackPath, k: number, lat: number): number {
  const h = p.half[k]!;
  return p.y[k]! - clamp(lat, -h, h) * Math.tan(p.bank[k]!);
}

/** Surface height at lateral `lat` of sample k: the analytic deck on a bridge span, else the ground at the path's level. */
function surfY(ground: TrackGround, p: TrackPath, k: number, lat: number): number {
  const y = levelAt(p, k, lat);
  return p.deck[k] ? y : ground.heightAt(p.x[k]! + p.tz[k]! * lat, p.z[k]! - p.tx[k]! * lat, y);
}

function sampleStep(p: TrackPath): number {
  return p.length / (p.closed ? p.count : p.count - 1);
}

/** Sample index at arc length s (wrapped on a loop, clamped on an open path). */
function sampleAt(p: TrackPath, s: number): number {
  const segs = p.closed ? p.count : p.count - 1;
  const k = Math.floor((s / p.length) * segs);
  return p.closed ? ((k % p.count) + p.count) % p.count : clamp(k, 0, p.count - 1);
}

/**
 * Sample indices to build sections at: every flag change (deck, tunnel, walls, surfaces), at most
 * MAX_STEP m apart, closer where the path bends or crests (chord sagitta ≤ 2 cm), and on every
 * multiple of `period` m when given. An open path ends on its last sample.
 */
function sections(p: TrackPath, period: number): number[] {
  const n = p.count;
  const ds = sampleStep(p);
  const out = [0];
  let run = 0;
  let bend = 0;
  for (let k = 1; k < n; k++) {
    run += ds;
    const a = k - 1;
    const b = p.closed ? (k + 1) % n : Math.min(n - 1, k + 1);
    const crest = Math.abs(p.y[b]! - 2 * p.y[k]! + p.y[a]!) / (ds * ds);
    bend = Math.max(bend, Math.abs(p.curv[a]!), Math.abs(p.curv[k]!), crest);
    const step = Math.min(MAX_STEP, Math.max(ds, Math.sqrt(0.16 / Math.max(bend, 1e-6))));
    const flag =
      p.deck[k] !== p.deck[a] ||
      p.tunnel[k] !== p.tunnel[a] ||
      p.wallL[k] !== p.wallL[a] ||
      p.wallR[k] !== p.wallR[a] ||
      p.surface[k] !== p.surface[a] ||
      p.runSurface[k] !== p.runSurface[a];
    const tick = period > 0 && Math.floor((k * ds) / period) !== Math.floor((a * ds) / period);
    if (flag || tick || run >= step - 1e-6 || (!p.closed && k === n - 1)) {
      out.push(k);
      run = 0;
      bend = 0;
    }
  }
  return out;
}

const IDX_CELL = 8;

/** Path segments by 8 m cell: which road covers a point, and whether a point lies on another road. */
class RoadIndex {
  private readonly cells = new Map<number, number[]>();
  private readonly seg = blankSegment();

  constructor(private readonly paths: readonly TrackPath[]) {
    paths.forEach((p, pi) => {
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
    });
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
      if (Math.hypot(dx, dz) <= p.half[k]! + (lat > 0 ? p.runL[k]! : p.runR[k]!) + pad) return true;
    }
    return false;
  }
}

function buildTerrain(track: Track, ground: TrackGround, index: RoadIndex): THREE.BufferGeometry {
  const m = new Mesher();
  const far = Math.max(60, ...track.json.scatter.map((s) => s.far));
  const margin = Math.max(80, far + 40);
  const b = track.bounds;
  const x0 = Math.floor((b.minX - margin) / BLOCK) * BLOCK;
  const z0 = Math.floor((b.minZ - margin) / BLOCK) * BLOCK;
  const bx = Math.ceil((b.maxX + margin - x0) / BLOCK);
  const bz = Math.ceil((b.maxZ + margin - z0) / BLOCK);
  const per = BLOCK / CELL;
  const nx = bx * per + 1;
  const nz = bz * per + 1;
  const terrain = SURFACE_IDS.indexOf(track.json.environment.terrain);
  const tile = TILE[texClass(terrain)];
  const h = new Float32Array(nx * nz);
  const surf = new Uint8Array(nx * nz);
  const cov = new Int16Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * CELL;
      const z = z0 + j * CELL;
      const c = j * nx + i;
      // The ground layer (−∞ hint): bridge decks are drawn as decks, the terrain stays under them.
      h[c] = ground.heightAt(x, z, -Infinity);
      surf[c] = ground.surfaceIndex(x, z, -Infinity);
      cov[c] = index.coveredBy(x, z, 0.5);
    }
  }
  const bare = (i: number, j: number) => i < 0 || j < 0 || i >= nx || j >= nz || surf[j * nx + i] === terrain;
  // Road / runoff patches shrink by one cell, so 2 m triangles never smear their colour past the
  // ribbons that cover them; uncovered patches (open shortcut ends) still show.
  const col = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      col[c] = bare(i - 1, j) || bare(i + 1, j) || bare(i, j - 1) || bare(i, j + 1) ? terrain : surf[c]!;
      if (surf[c] === terrain) continue;
      // Under a ribbon: the lowest ground within half a cell, so a triangle never bridges a crease (a banked road's edge) above the ribbon.
      const x = x0 + i * CELL;
      const z = z0 + j * CELL;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) h[c] = Math.min(h[c]!, ground.heightAt(x + dx * CELL * 0.5, z + dz * CELL * 0.5, -Infinity));
      }
    }
  }
  // A cell wholly under one path's ribbon is not drawn.
  const dropped = (i: number, j: number) => {
    const c = j * nx + i;
    const a = cov[c]!;
    return a >= 0 && cov[c + 1] === a && cov[c + nx] === a && cov[c + nx + 1] === a;
  };
  // Block kind: 0 hidden, 1 one quad, 2 split into cells.
  const kind = new Uint8Array(bx * bz);
  for (let bj = 0; bj < bz; bj++) {
    for (let bi = 0; bi < bx; bi++) {
      const i0 = bi * per;
      const j0 = bj * per;
      let drops = 0;
      for (let v = 0; v < per; v++) for (let u = 0; u < per; u++) if (dropped(i0 + u, j0 + v)) drops++;
      if (drops === per * per) continue;
      const h00 = h[j0 * nx + i0]!;
      const h10 = h[j0 * nx + i0 + per]!;
      const h01 = h[(j0 + per) * nx + i0]!;
      const h11 = h[(j0 + per) * nx + i0 + per]!;
      let simple = drops === 0;
      for (let v = 0; v <= per && simple; v++) {
        for (let u = 0; u <= per && simple; u++) {
          const c = (j0 + v) * nx + i0 + u;
          const a = h00 + (h10 - h00) * (u / per);
          const e = h01 + (h11 - h01) * (u / per);
          simple = col[c] === terrain && Math.abs(h[c]! - (a + (e - a) * (v / per))) <= FLAT_TOL;
        }
      }
      kind[bj * bx + bi] = simple ? 1 : 2;
    }
  }
  const n = new THREE.Vector3();
  const vert = (i: number, j: number, y: number) => {
    const x = x0 + i * CELL;
    const z = z0 + j * CELL;
    const id = m.v(x, y, z, surfaceHex(col[j * nx + i]!), x / tile, z / tile, mottle(x, z));
    ground.normalAt(x, z, n, -Infinity);
    m.normal(id, n.x, n.y, n.z);
    return id;
  };
  const coarse = (bi: number, bj: number) => bi >= 0 && bj >= 0 && bi < bx && bj < bz && kind[bj * bx + bi] === 1;
  const ids = new Int32Array((per + 1) * (per + 1));
  for (let bj = 0; bj < bz; bj++) {
    for (let bi = 0; bi < bx; bi++) {
      const k = kind[bj * bx + bi]!;
      if (k === 0) continue;
      const i0 = bi * per;
      const j0 = bj * per;
      if (k === 1) {
        const a = vert(i0, j0, h[j0 * nx + i0]!);
        const r = vert(i0 + per, j0, h[j0 * nx + i0 + per]!);
        const f = vert(i0, j0 + per, h[(j0 + per) * nx + i0]!);
        const d = vert(i0 + per, j0 + per, h[(j0 + per) * nx + i0 + per]!);
        // Rows run +z (ahead), columns +x: +x is left of +z, so the +x vertex is the left one.
        m.quad(a, r, f, d);
        continue;
      }
      for (let v = 0; v <= per; v++) {
        for (let u = 0; u <= per; u++) {
          const i = i0 + u;
          const j = j0 + v;
          let y = h[j * nx + i]!;
          // Edge shared with a one-quad block: take that quad's edge height, so no crack opens.
          const edgeU = u === 0 ? coarse(bi - 1, bj) : u === per ? coarse(bi + 1, bj) : false;
          const edgeV = v === 0 ? coarse(bi, bj - 1) : v === per ? coarse(bi, bj + 1) : false;
          if (edgeU && v !== 0 && v !== per) y = h[j0 * nx + i]! + (h[(j0 + per) * nx + i]! - h[j0 * nx + i]!) * (v / per);
          else if (edgeV && u !== 0 && u !== per) y = h[j * nx + i0]! + (h[j * nx + i0 + per]! - h[j * nx + i0]!) * (u / per);
          ids[v * (per + 1) + u] = vert(i, j, y);
        }
      }
      for (let v = 0; v < per; v++) {
        for (let u = 0; u < per; u++) {
          if (dropped(i0 + u, j0 + v)) continue;
          const a = v * (per + 1) + u;
          m.quad(ids[a]!, ids[a + 1]!, ids[a + per + 1]!, ids[a + per + 2]!);
        }
      }
    }
  }
  // Far skirt: an annulus under the grid's edge out to the horizon, just below the base terrain.
  const cx = x0 + (bx * BLOCK) / 2;
  const cz = z0 + (bz * BLOCK) / 2;
  const inner = (Math.min(bx, bz) * BLOCK) / 2;
  const rings = 10;
  const seg = 72;
  const hex = surfaceHex(terrain);
  const first = m.pos.length / 3;
  for (let r = 0; r <= rings; r++) {
    const rad = inner * Math.pow(SKIRT_RADIUS / inner, r / rings);
    for (let s = 0; s < seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      const x = cx + Math.sin(a) * rad;
      const z = cz + Math.cos(a) * rad;
      m.v(x, ground.base(x, z) - 0.25, z, hex, x / tile, z / tile, mottle(x, z));
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < seg; s++) {
      const a = first + r * seg + s;
      const b2 = first + r * seg + ((s + 1) % seg);
      // Outward is ahead; the next angle (+z turning to +x) lies to its left.
      m.quad(a, b2, a + seg, b2 + seg);
    }
  }
  return m.geometry(false);
}

/** Ribbon meshers by kind and surface. */
type Ribbons = Map<string, { kind: "road" | "runoff"; surface: number; m: Mesher }>;

/** Road and runoff strips of `p` (smooth along the path, one mesher per kind + surface). */
function addRibbons(out: Ribbons, p: TrackPath, secs: readonly number[], ground: TrackGround, lift: number): void {
  const n = secs.length;
  const last = p.closed ? n : n - 1;
  // Strip 0: road [−half, half]; 1: left runoff; 2: right runoff.
  const span = (strip: number, k: number): [number, number] => {
    const h = p.half[k]!;
    return strip === 0 ? [-h, h] : strip === 1 ? [h, h + p.runL[k]!] : [-h - p.runR[k]!, -h];
  };
  for (let strip = 0; strip < 3; strip++) {
    let prev = "";
    let pa = -1;
    let pb = -1;
    for (let i = 0; i < last; i++) {
      const k = secs[i]!;
      const k2 = secs[(i + 1) % n]!;
      const width = strip === 1 ? p.runL[k]! : strip === 2 ? p.runR[k]! : 1;
      if (width <= 0) {
        prev = "";
        continue;
      }
      const sid = strip === 0 ? p.surface[k]! : p.runSurface[k]!;
      const kind = strip === 0 ? "road" : "runoff";
      const key = `${kind}:${sid}`;
      let found = out.get(key);
      if (!found) {
        found = { kind, surface: sid, m: new Mesher() };
        out.set(key, found);
      }
      const r = found;
      const tile = TILE[texClass(sid)];
      const edge = (at: number): [number, number] => {
        const [l0, l1] = span(strip, at);
        const ids = [l0, l1].map((lat) => {
          const x = p.x[at]! + p.tz[at]! * lat;
          const z = p.z[at]! - p.tx[at]! * lat;
          return r.m.v(x, surfY(ground, p, at, lat) + lift, z, surfaceHex(sid), x / tile, z / tile);
        });
        return [ids[0]!, ids[1]!];
      };
      if (key !== prev) [pa, pb] = edge(k);
      const [ca, cb] = edge(k2);
      r.m.quad(pa, pb, ca, cb);
      pa = ca;
      pb = cb;
      prev = key;
    }
  }
}

/** One path's ribbon as built (its section samples), so markings lie exactly on it. */
class RibbonSurface {
  private readonly n: number;
  private readonly ds: number;

  constructor(
    readonly p: TrackPath,
    private readonly secs: readonly number[],
    private readonly ground: TrackGround,
  ) {
    this.n = p.count;
    this.ds = sampleStep(p);
  }

  /** Lateral edges [e0, e1] at sample k of the ribbon strip (road, left or right runoff) holding lateral `lat`. */
  private strip(k: number, lat: number): [number, number] {
    const p = this.p;
    const h = p.half[k]!;
    if (Math.abs(lat) <= h) return [-h, h];
    return lat > 0 ? [h, h + p.runL[k]!] : [-h - p.runR[k]!, -h];
  }

  /**
   * Vertex on the ribbon at arc length s, lateral l + edge × the half width, lifted by `lift`. The
   * height comes from the very triangle the ribbon draws there (quad a→b at section k0, c→d at k1,
   * split along b–c), so a mark never sinks into a twisted quad on a crest or a bend.
   */
  vertex(m: Mesher, s: number, l: number, edge: number, lift: number, hex: number): number {
    const { p, secs, n, ground } = this;
    const w0 = s / this.ds;
    const w = p.closed ? ((w0 % n) + n) % n : clamp(w0, 0, n - 1);
    let lo = 0;
    let hi = secs.length - 1;
    while (hi > lo) {
      const mid = (lo + hi + 1) >> 1;
      if (secs[mid]! <= w) lo = mid;
      else hi = mid - 1;
    }
    const k0 = secs[lo]!;
    const k1 = lo + 1 < secs.length ? secs[lo + 1]! : p.closed ? n : k0;
    const f = k1 > k0 ? (w - k0) / (k1 - k0) : 0;
    const kb = k1 % n;
    const la = l + edge * p.half[k0]!;
    const lb = l + edge * p.half[kb]!;
    const [a0, a1] = this.strip(k0, la);
    const [b0, b1] = this.strip(kb, lb);
    const u = a1 > a0 ? clamp((la - a0) / (a1 - a0), 0, 1) : 0;
    const ya = surfY(ground, p, k0, a0);
    const yb = surfY(ground, p, k0, a1);
    const yc = surfY(ground, p, kb, b0);
    const yd = surfY(ground, p, kb, b1);
    const y = u + f <= 1 ? ya + (yb - ya) * u + (yc - ya) * f : yd + (yc - yd) * (1 - u) + (yb - yd) * (1 - f);
    return m.v(
      p.x[k0]! + p.tz[k0]! * la + (p.x[kb]! + p.tz[kb]! * lb - p.x[k0]! - p.tz[k0]! * la) * f,
      y + lift,
      p.z[k0]! - p.tx[k0]! * la + (p.z[kb]! - p.tx[kb]! * lb - p.z[k0]! + p.tx[k0]! * la) * f,
      hex,
    );
  }

  /**
   * Arc lengths strictly between s0 and s1 (unwrapped on a loop), ascending, where a mark at
   * laterals `ls` (from `edge` × half width) must break to stay on the ribbon: every section, and
   * where each lateral crosses a ribbon quad's b–c diagonal (u + f = 1).
   */
  cuts(s0: number, s1: number, ls: readonly number[], edge: number): number[] {
    const { p, secs, n, ds } = this;
    const out: number[] = [];
    const L = n * ds;
    const last = p.closed ? secs.length : secs.length - 1;
    for (const off of p.closed ? [-L, 0, L] : [0]) {
      for (let i = 0; i < last; i++) {
        const k0 = secs[i]!;
        const k1 = i + 1 < secs.length ? secs[i + 1]! : n;
        const sa = k0 * ds + off;
        const sb = k1 * ds + off;
        if (sb <= s0 || sa >= s1) continue;
        if (sa > s0 + 1e-6) out.push(sa);
        for (const l of ls) {
          const lat = l + edge * p.half[k0]!;
          const [e0, e1] = this.strip(k0, lat);
          const u = e1 > e0 ? clamp((lat - e0) / (e1 - e0), 0, 1) : 0;
          const s = sa + (1 - u) * (sb - sa);
          if (s > s0 + 1e-6 && s < s1 - 1e-6) out.push(s);
        }
      }
    }
    return out.sort((a, b) => a - b);
  }
}

/**
 * Flat strip from arc length s0 to s1 on a ribbon; laterals l0 < l1 are measured from `edge` × the
 * half width (0 = centreline). Broken wherever the ribbon creases, so every piece lies on it; its
 * quads split the same way as the ribbon's (l1 at the start to l0 at the end).
 */
function addSpan(m: Mesher, rs: RibbonSurface, s0: number, s1: number, l0: number, l1: number, edge: number, lift: number, hex: number): void {
  let pa = -1;
  let pb = -1;
  for (const s of [s0, ...rs.cuts(s0, s1, [l0, l1], edge), s1]) {
    const a = rs.vertex(m, s, l0, edge, lift, hex);
    const b = rs.vertex(m, s, l1, edge, lift, hex);
    if (pa >= 0) m.quad(pa, pb, a, b);
    pa = a;
    pb = b;
  }
}

/** Edge lines and centre dashes on paved stretches, a chequered line on the loop; none where another road crosses. */
function addMarkings(m: Mesher, pi: number, rs: RibbonSurface, secs: readonly number[], index: RoadIndex): void {
  const p = rs.p;
  const n = secs.length;
  const last = p.closed ? n : n - 1;
  const main = pi === 0;
  const L = p.length;
  const ds = sampleStep(p);
  const clear = (k: number, lat: number) => !index.onOther(pi, p.x[k]! + p.tz[k]! * lat, p.z[k]! - p.tx[k]! * lat, p.y[k]!, 0.2);
  for (let i = 0; i < last; i++) {
    const k = secs[i]!;
    const k2 = secs[(i + 1) % n]!;
    if (!PAVED.includes(p.surface[k]!)) continue;
    // Clipped clear of the chequer on the loop (sections can sit a few metres either side of it).
    const sa = main ? Math.max(k * ds, CHEQUER / 2 + 0.3) : k * ds;
    const sb = main ? Math.min((k2 > k ? k2 : k2 + p.count) * ds, L - CHEQUER / 2 - 0.3) : k2 * ds;
    if (sb <= sa) continue;
    for (const side of [1, -1]) {
      if (clear(k, side * p.half[k]!) && clear(k2, side * p.half[k2]!)) {
        addSpan(m, rs, sa, sb, side > 0 ? -0.35 : 0.13, side > 0 ? -0.13 : 0.35, side, MARK_LIFT, WHITE);
      }
    }
  }
  for (let s = main ? 6 : 1.5; s + 3 <= L - (main ? 3 : 0); s += 9) {
    const k = sampleAt(p, s);
    const k2 = sampleAt(p, s + 3);
    if (!PAVED.includes(p.surface[k]!) || !clear(k, 0) || !clear(k2, 0)) continue;
    addSpan(m, rs, s, s + 3, -0.09, 0.09, 0, MARK_LIFT, WHITE);
  }
  if (!main) return;
  // Chequered start / finish band: ≈1 m squares across the road, two rows.
  const cols = Math.max(2, Math.round(p.half[0]! * 2));
  const rows = 2;
  for (let r = 0; r < rows; r++) {
    const s0 = -CHEQUER / 2 + (r * CHEQUER) / rows;
    const w = p.half[0]! * 2;
    for (let c = 0; c < cols; c++) {
      const l0 = -p.half[0]! + (c * w) / cols;
      addSpan(m, rs, s0, s0 + CHEQUER / rows, l0, l0 + w / cols, 0, MARK_LIFT, (r + c) % 2 ? BLACK : WHITE);
    }
  }
}

/** Red / white kerbs on the inside of the loop's tight turns (paved, not at crossings). */
function addKerbs(m: Mesher, rs: RibbonSurface, index: RoadIndex): void {
  const p = rs.p;
  for (let s = 0; s + 2 <= p.length; s += 2) {
    const k = sampleAt(p, s + 1);
    if (!PAVED.includes(p.surface[k]!)) continue;
    let c = 0;
    for (let d = -KERB_FILL; d <= KERB_FILL; d++) {
      const v = p.curv[(k + d + p.count) % p.count]!;
      if (Math.abs(v) > Math.abs(c)) c = v;
    }
    if (Math.abs(c) <= KERB_CURV) continue;
    const h = p.half[k]!;
    const lat = c > 0 ? h + KERB_WIDTH / 2 : -h - KERB_WIDTH / 2;
    if (index.onOther(0, p.x[k]! + p.tz[k]! * lat, p.z[k]! - p.tx[k]! * lat, p.y[k]!, 0.2)) continue;
    const hex = Math.floor(s / 2) % 2 ? RED : WHITE;
    if (c > 0) addSpan(m, rs, s, s + 2, -0.05, KERB_WIDTH, 1, KERB_LIFT, hex);
    else addSpan(m, rs, s, s + 2, -KERB_WIDTH, 0.05, -1, KERB_LIFT, hex);
  }
}

/** A section frame: centre, flat unit tangent, arc length. */
type Frame = { x: number; z: number; tx: number; tz: number; s: number };

function frameOf(p: TrackPath, k: number): Frame {
  return { x: p.x[k]!, z: p.z[k]!, tx: p.tx[k]!, tz: p.tz[k]!, s: k * sampleStep(p) };
}

/**
 * Quad strip for profile segment j..j+1 between sections A and B (profiles as (lateral + left, y)
 * pairs). Front faces follow the profile's left-hand normal: a profile running clockwise (seen
 * with + lateral to the right, y up) faces out of the solid it bounds.
 */
function stripJ(m: Mesher, fa: Frame, A: readonly number[], fb: Frame, B: readonly number[], j: number, hex: number, tile: number, v0: number): void {
  const ids: number[] = [];
  for (const [f, P] of [
    [fa, A],
    [fb, B],
  ] as const) {
    const dl = P[j * 2 + 2]! - P[j * 2]!;
    const dy = P[j * 2 + 3]! - P[j * 2 + 1]!;
    const len = Math.hypot(dl, dy) || 1;
    for (let q = 0; q < 2; q++) {
      const l = P[(j + q) * 2]!;
      const id = m.v(f.x + f.tz * l, P[(j + q) * 2 + 1]!, f.z - f.tx * l, hex, f.s / tile, (v0 + q * len) / tile);
      m.normal(id, (f.tz * -dy) / len, dl / len, (-f.tx * -dy) / len);
      ids.push(id);
    }
  }
  m.quad(ids[0]!, ids[1]!, ids[2]!, ids[3]!);
}

/** Flat polygon (convex, (lateral, y) pairs) in the section plane, facing +s (`facing` 1) or −s (−1). */
function face(m: Mesher, f: Frame, P: readonly number[], facing: number, hex: number, tile: number): void {
  const ids: number[] = [];
  for (let i = 0; i < P.length; i += 2) {
    const l = P[i]!;
    const id = m.v(f.x + f.tz * l, P[i + 1]!, f.z - f.tx * l, hex, l / tile, P[i + 1]! / tile);
    m.normal(id, f.tx * facing, 0, f.tz * facing);
    ids.push(id);
  }
  for (let i = 1; i + 1 < ids.length; i++) {
    // In (lateral, y), counter-clockwise faces +s (left × up = forward).
    const ax = P[i * 2]! - P[0]!;
    const ay = P[i * 2 + 1]! - P[1]!;
    const bx = P[i * 2 + 2]! - P[0]!;
    const by = P[i * 2 + 3]! - P[1]!;
    const ccw = ax * by - ay * bx > 0;
    if (ccw === facing > 0) m.idx.push(ids[0]!, ids[i]!, ids[i + 1]!);
    else m.idx.push(ids[0]!, ids[i + 1]!, ids[i]!);
  }
}

/** Runs [a, b] of section indices where `on(sample)` holds for the segment leaving each section. */
function runs(p: TrackPath, secs: readonly number[], on: (k: number) => boolean): [number, number][] {
  const out: [number, number][] = [];
  const n = secs.length;
  const last = p.closed ? n : n - 1;
  let start = -1;
  for (let i = 0; i < last; i++) {
    const inRun = on(secs[i]!);
    if (inRun && start < 0) start = i;
    if (!inRun && start >= 0) {
      out.push([start, i]);
      start = -1;
    }
  }
  if (start >= 0) {
    // A run reaching the loop's end continues into one starting at section 0.
    if (p.closed && out.length > 0 && out[0]![0] === 0) out[0] = [start, out[0]![1] + n];
    else out.push([start, last]);
  }
  return out;
}

/** Continuous jersey barrier on each walled side, broken (and capped) where the flag is off. */
function addWalls(m: Mesher, p: TrackPath, ground: TrackGround, wallHeight: number): void {
  const secs = sections(p, WALL_PERIOD);
  const n = secs.length;
  const prof = WALL_PROFILE.map(([u, v]) => [u, v > 0 ? v * wallHeight : v] as const);
  const vlen: number[] = [0];
  for (let j = 1; j < prof.length; j++) vlen.push(vlen[j - 1]! + Math.hypot(prof[j]![0] - prof[j - 1]![0], prof[j]![1] - prof[j - 1]![1]));
  const ds = sampleStep(p);
  for (const side of [1, -1]) {
    const flag = side > 0 ? p.wallL : p.wallR;
    // Left wall: the profile as written runs clockwise; the right wall is its mirror, so reversed.
    const order = side > 0 ? prof.map((_, j) => j) : prof.map((_, j) => prof.length - 1 - j);
    const at = (k: number): number[] => {
      const w = p.half[k]! + (side > 0 ? p.runL[k]! : p.runR[k]!);
      const y = surfY(ground, p, k, side * w);
      return order.flatMap((j) => [side * (w + prof[j]![0]), y + prof[j]![1]]);
    };
    for (const [a, b] of runs(p, secs, (k) => flag[k] === 1)) {
      for (let i = a; i < b; i++) {
        const k = secs[i % n]!;
        const k2 = secs[(i + 1) % n]!;
        const A = at(k);
        const B = at(k2);
        const fa = frameOf(p, k);
        const fb = frameOf(p, k2);
        const stripe = Math.floor((k * ds) / WALL_PERIOD) % 2 ? RED : WHITE;
        for (let q = 0; q < prof.length - 1; q++) {
          const j = side > 0 ? q : prof.length - 2 - q;
          const hex = j === 3 ? stripe : j < 3 ? CONCRETE : CONCRETE_DARK;
          stripJ(m, fa, A, fb, B, q, hex, TILE.concrete, side > 0 ? vlen[q]! : vlen[prof.length - 1]! - vlen[prof.length - 1 - q]!);
        }
      }
      face(m, frameOf(p, secs[a % n]!), at(secs[a % n]!), -1, CONCRETE_DARK, TILE.concrete);
      face(m, frameOf(p, secs[b % n]!), at(secs[b % n]!), 1, CONCRETE_DARK, TILE.concrete);
    }
  }
}

/** Bridge slabs under every deck span: lips beyond the walls, fascias, underside, end faces. */
function addDecks(m: Mesher, p: TrackPath, secs: readonly number[]): void {
  const n = secs.length;
  const slab = (k: number): number[] => {
    const hL = p.half[k]! + p.runL[k]!;
    const hR = p.half[k]! + p.runR[k]!;
    const L = hL + DECK_LIP;
    const R = -(hR + DECK_LIP);
    const top = (l: number) => levelAt(p, k, l);
    // Clockwise round the slab, open along the road (the ribbon is the top).
    return [hL, top(hL), L, top(L), L, top(L) - DECK_THICK, R, top(R) - DECK_THICK, R, top(R), -hR, top(-hR)];
  };
  for (const [a, b] of runs(p, secs, (k) => p.deck[k] === 1)) {
    for (let i = a; i < b; i++) {
      const k = secs[i % n]!;
      const k2 = secs[(i + 1) % n]!;
      const A = slab(k);
      const B = slab(k2);
      let v = 0;
      for (let j = 0; j < 5; j++) {
        stripJ(m, frameOf(p, k), A, frameOf(p, k2), B, j, j === 2 ? CONCRETE_DARK : DECK_COL, TILE.concrete, v);
        v += Math.hypot(A[j * 2 + 2]! - A[j * 2]!, A[j * 2 + 3]! - A[j * 2 + 1]!);
      }
    }
    for (const [i, facing] of [
      [a, -1],
      [b, 1],
    ] as const) {
      const k = secs[i % n]!;
      const S = slab(k);
      face(m, frameOf(p, k), [S[2]!, S[3]!, S[4]!, S[5]!, S[6]!, S[7]!, S[8]!, S[9]!], facing, CONCRETE_DARK, TILE.concrete);
    }
  }
}

/** Pillar bents every ≈12 m under deck spans, down to the ground below; none standing on a road. */
function pillarPieces(p: TrackPath, secs: readonly number[], ground: TrackGround, index: RoadIndex): Piece[] {
  const out: Piece[] = [];
  const n = secs.length;
  const ds = sampleStep(p);
  const pt = blankPoint();
  for (const [a, b] of runs(p, secs, (k) => p.deck[k] === 1)) {
    const s0 = secs[a % n]! * ds;
    let s1 = secs[b % n]! * ds;
    if (s1 <= s0) s1 += p.length;
    const count = Math.max(1, Math.round((s1 - s0) / PILLAR_EVERY));
    for (let c = 0; c < count; c++) {
      const s = s0 + ((c + 0.5) * (s1 - s0)) / count;
      pointOn(p, s, pt);
      const k = sampleAt(p, s);
      const lats = pt.half >= 6 ? [pt.half * 0.55, -pt.half * 0.55] : [0];
      const legs: { x: number; z: number; top: number; foot: number }[] = [];
      for (const lat of lats) {
        const x = pt.x + pt.tz * lat;
        const z = pt.z - pt.tx * lat;
        const top = pt.y - clamp(lat, -pt.half, pt.half) * Math.tan(p.bank[k]!) - DECK_THICK - 0.6;
        const foot = ground.heightAt(x, z, pt.y - 3);
        if (top - foot < 1.2 || index.coveredBy(x, z, -1.5) >= 0) break;
        legs.push({ x, z, top, foot });
      }
      if (legs.length !== lats.length) continue;
      const yaw = Math.atan2(pt.tx, pt.tz);
      for (const g of legs) {
        out.push([new THREE.CylinderGeometry(PILLAR_R, PILLAR_R * 1.15, g.top - g.foot + 0.3, 8, 1, true).translate(g.x, (g.top + g.foot - 0.3) / 2, g.z), DECK_COL]);
      }
      // Pier cap: 0.6 m deep, flush under the slab, across the bent.
      const capTop = Math.max(...legs.map((g) => g.top)) + 0.6;
      const span = lats.length > 1 ? Math.abs(lats[0]! - lats[1]!) : 0;
      const capGeo = box(span + PILLAR_R * 2 + 1.2, 0.6, 1.3, 0, 0, 0).rotateY(yaw).translate(pt.x, capTop - 0.3, pt.z);
      out.push([capGeo, CONCRETE_DARK]);
    }
  }
  return out;
}

/** Tunnel shells (dark inside, concrete outside), portals with headwalls, and ceiling light strips. */
function addTunnels(m: Mesher, lights: Mesher, p: TrackPath, secs: readonly number[], ground: TrackGround): void {
  const n = secs.length;
  const ds = sampleStep(p);
  const shape = (k: number, outer: boolean): number[] => {
    const WL = p.half[k]! + p.runL[k]! + TUNNEL_GAP + (outer ? TUNNEL_SHELL : 0);
    const WR = p.half[k]! + p.runR[k]! + TUNNEL_GAP + (outer ? TUNNEL_SHELL : 0);
    const y0 = surfY(ground, p, k, 0);
    const footL = surfY(ground, p, k, WL) - 0.4;
    const footR = surfY(ground, p, k, -WR) - 0.4;
    const top = y0 + TUNNEL_SIDE;
    const c = (WL - WR) / 2;
    const ra = (WL + WR) / 2;
    const rise = Math.min(3, ra * 0.3) + (outer ? TUNNEL_SHELL : 0);
    const arch: number[] = [];
    for (let i = 1; i < ARCH_STEPS; i++) {
      const t = (i / ARCH_STEPS) * Math.PI;
      arch.push(c + ra * Math.cos(t), top + rise * Math.sin(t));
    }
    // Inner: counter-clockwise round the road (faces in); outer: clockwise (faces out).
    const inner = [WL, footL, WL, top, ...arch, -WR, top, -WR, footR];
    if (!outer) return inner;
    const pts: number[] = [];
    for (let i = inner.length - 2; i >= 0; i -= 2) pts.push(inner[i]!, inner[i + 1]!);
    return pts;
  };
  const P = ARCH_STEPS + 3;
  for (const [a, b] of runs(p, secs, (k) => p.tunnel[k] === 1)) {
    for (let i = a; i < b; i++) {
      const k = secs[i % n]!;
      const k2 = secs[(i + 1) % n]!;
      const fa = frameOf(p, k);
      const fb = frameOf(p, k2);
      for (const outer of [false, true]) {
        const A = shape(k, outer);
        const B = shape(k2, outer);
        for (let j = 0; j < P - 1; j++) {
          const side = j === 0 || j === P - 2;
          stripJ(m, fa, A, fb, B, j, outer ? CONCRETE_DARK : side ? TUNNEL_TILE : TUNNEL_IN, TILE.concrete, j * 2);
        }
      }
    }
    for (const [i, facing] of [
      [a, -1],
      [b, 1],
    ] as const) {
      const k = secs[i % n]!;
      const f = frameOf(p, k);
      const I = shape(k, false);
      const O = shape(k, true);
      const crown = Math.max(...O.filter((_, q) => q % 2 === 1)) + 1.2;
      const wide = 2.5;
      for (let j = 0; j < P - 1; j++) {
        // Ring between the inner and outer shells (outer listed the other way round).
        const o0 = P - 1 - j;
        const o1 = P - 2 - j;
        const ring = [I[j * 2]!, I[j * 2 + 1]!, I[j * 2 + 2]!, I[j * 2 + 3]!, O[o1 * 2]!, O[o1 * 2 + 1]!, O[o0 * 2]!, O[o0 * 2 + 1]!];
        // Headwall: the outer shell out to a rectangle round the portal.
        const lift = (l: number, y: number, q: number) => (q === 0 || q === P - 1 ? [l + Math.sign(l) * wide, y] : [l + Math.sign(l) * wide * (Math.abs(l) / Math.max(1, Math.abs(O[0]!))), crown]);
        const head = [O[o0 * 2]!, O[o0 * 2 + 1]!, O[o1 * 2]!, O[o1 * 2 + 1]!, ...lift(O[o1 * 2]!, O[o1 * 2 + 1]!, o1), ...lift(O[o0 * 2]!, O[o0 * 2 + 1]!, o0)];
        for (const dir of [facing, -facing]) {
          face(m, f, ring, dir, CONCRETE, TILE.concrete);
          face(m, f, head, dir, CONCRETE, TILE.concrete);
        }
      }
    }
    // Ceiling light strips.
    const s0 = secs[a % n]! * ds;
    let s1 = secs[b % n]! * ds;
    if (s1 <= s0) s1 += p.length;
    const pt = blankPoint();
    for (let s = s0 + TUNNEL_LIGHT_EVERY / 2; s + 2.4 < s1; s += TUNNEL_LIGHT_EVERY) {
      const ids: number[] = [];
      for (const ss of [s, s + 2.4]) {
        pointOn(p, ss, pt);
        const k = sampleAt(p, ss);
        const I = shape(k, false);
        const apex = I[(1 + ARCH_STEPS / 2) * 2 + 1]! - 0.08;
        const c = (p.runL[k]! - p.runR[k]!) / 2;
        for (const lat of [c - 0.18, c + 0.18]) ids.push(lights.v(pt.x + pt.tz * lat, apex, pt.z - pt.tx * lat, TUNNEL_LIGHT));
      }
      lights.quad(ids[0]!, ids[1]!, ids[2]!, ids[3]!);
    }
  }
}

/** Knock state: in place, flying / tumbling, knocked and at rest. */
const AT_REST = 0;
const FLYING = 1;
const DOWN = 2;

export class TrackArt {
  readonly group = new THREE.Group();
  private readonly placed: readonly Placed[];
  private readonly ground: TrackGround;
  private readonly textures: RaceTextures;
  private readonly lamps: THREE.InstancedMesh;
  private readonly lampColour: number[] = [];
  private lights = -1;
  /** Per placement: instance slot in its prefab's meshes. */
  private readonly slot: Int32Array;
  private readonly meshes: Partial<Record<PrefabId, THREE.InstancedMesh[]>> = {};
  /** Scene-owned materials (lamp heads, light pools) that dispose() leaves alone. */
  private readonly shared: THREE.Material[] = [];
  /** `forDraw`: per source material, the material each draw kind uses (copies are disposed with the art). */
  private readonly byKind = new Map<THREE.Material, Partial<Record<DrawKind, THREE.Material>>>();
  private readonly state: Uint8Array;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly spin: Float32Array;
  private readonly rot: Float32Array;
  /** Indices of flying props: [0, flyingCount). */
  private readonly flying: Int32Array;
  private flyingCount = 0;
  private readonly m4 = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly dq = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly sc = new THREE.Vector3();
  private readonly axis = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly identity = new THREE.Quaternion();
  private readonly col = new THREE.Color();

  constructor(track: Track, placed: readonly Placed[]) {
    this.group.name = "track-art";
    this.placed = placed;
    this.ground = track.ground();
    const ground = this.ground;
    const tex = makeRaceTextures();
    this.textures = tex;
    const mats = makePrefabMaterials(tex);
    const paths = track.paths();
    const index = new RoadIndex(paths);
    const secs = paths.map((p) => sections(p, 0));
    const env = track.json.environment;
    // Ground materials (one per mesh) also darken under the tyre-mark map.
    const textured = (sid: number, extra: THREE.MeshStandardMaterialParameters = {}) => {
      const t = texClass(sid);
      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        map: t === "asphalt" ? tex.asphalt : t === "concrete" ? tex.concrete : tex.detail,
        color: t === "asphalt" ? tex.asphaltGain : t === "concrete" ? tex.concreteGain : tex.detailGain,
        roughness: t === "asphalt" ? 0.9 : 0.95,
        metalness: 0.02,
        ...extra,
      });
      applyMarkMap(mat);
      return mat;
    };

    const terrainSid = SURFACE_IDS.indexOf(env.terrain);
    this.add(
      new THREE.Mesh(buildTerrain(track, ground, index), textured(terrainSid, { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })),
      { kind: "terrain", surface: env.terrain },
      false,
    );

    const ribbons: Ribbons = new Map();
    paths.forEach((p, i) => addRibbons(ribbons, p, secs[i]!, ground, i === 0 ? ROAD_LIFT : SIDE_LIFT));
    for (const r of ribbons.values()) this.add(new THREE.Mesh(r.m.geometry(true), textured(r.surface)), { kind: r.kind, surface: SURFACE_IDS[r.surface]! }, false);

    const markMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
    const marks = new Mesher();
    paths.forEach((p, i) => addMarkings(marks, i, new RibbonSurface(p, secs[i]!, ground), secs[i]!, index));
    this.add(new THREE.Mesh(marks.geometry(true), markMat), { kind: "marking" }, false);
    const kerbs = new Mesher();
    addKerbs(kerbs, new RibbonSurface(paths[0]!, secs[0]!, ground), index);
    if (!kerbs.empty) this.add(new THREE.Mesh(kerbs.geometry(true), markMat), { kind: "kerb" }, false);

    const walls = new Mesher();
    const decks = new Mesher();
    const tunnels = new Mesher();
    const tunnelLights = new Mesher();
    const pillars: Piece[] = [];
    paths.forEach((p, i) => {
      if (p.wallL.includes(1) || p.wallR.includes(1)) addWalls(walls, p, ground, track.json.road.wallHeight);
      if (p.deck.includes(1)) {
        addDecks(decks, p, secs[i]!);
        pillars.push(...pillarPieces(p, secs[i]!, ground, index));
      }
      if (p.tunnel.includes(1)) addTunnels(tunnels, tunnelLights, p, secs[i]!, ground);
    });
    if (!walls.empty) this.add(new THREE.Mesh(walls.geometry(false), mats.concrete), { kind: "wall" }, true);
    if (!decks.empty) this.add(new THREE.Mesh(decks.geometry(false), mats.concrete), { kind: "deck" }, true);
    if (pillars.length > 0) this.add(new THREE.Mesh(painted(pillars), mats.concrete), { kind: "pillar" }, true);
    if (!tunnels.empty) this.add(new THREE.Mesh(tunnels.geometry(false), mats.concrete), { kind: "tunnel" }, true);
    if (!tunnelLights.empty) {
      const glow = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
      this.add(new THREE.Mesh(tunnelLights.geometry(false), glow), { kind: "tunnel" }, false);
    }

    // Start gantry, built in the line's frame: x = lateral (+ left), y up from the road, z forward.
    const pt = track.pointAt(0, blankPoint());
    const p = track.path;
    const roadY = ground.heightAt(pt.x, pt.z, pt.y);
    const frame = new THREE.Matrix4().makeRotationY(Math.atan2(pt.tx, pt.tz)).setPosition(pt.x, roadY, pt.z);
    const latL = pt.half + p.runL[0]! + 1.2;
    const latR = -(pt.half + p.runR[0]! + 1.2);
    const pieces: Piece[] = [];
    const pylon = prefabParts("gantry", mats)[0]!.geometry;
    for (const lat of [latL, latR]) {
      const foot = ground.heightAt(pt.x + pt.tz * lat, pt.z - pt.tx * lat, pt.y) - roadY;
      pieces.push([pylon.clone().scale(1, (GANTRY_BEAM - 0.4 - foot) / 6, 1).translate(lat, foot, 0), 0xc8cbd0]);
    }
    pylon.dispose();
    pieces.push([box(latL - latR + 1, 0.8, 0.9, (latL + latR) / 2, GANTRY_BEAM, 0), 0x2a2c32]);
    pieces.push([box(latL - latR + 1, 0.12, 0.92, (latL + latR) / 2, GANTRY_BEAM + 0.46, 0), RED]);
    const panelX = [pt.half * 0.45, -pt.half * 0.45];
    for (const x of panelX) pieces.push([box(3.3, 1.3, 0.3, x, GANTRY_BEAM - 1.05, 0), BLACK]);
    this.add(new THREE.Mesh(painted(pieces).applyMatrix4(frame), mats.plain), { kind: "prop", prefab: "gantry" }, true);

    const disc = new THREE.CircleGeometry(0.42, 20).rotateY(Math.PI);
    this.lamps = new THREE.InstancedMesh(disc, new THREE.MeshBasicMaterial({ toneMapped: false }), panelX.length * 3);
    let i = 0;
    for (const x of panelX) {
      for (let c = 0; c < 3; c++) {
        // Seen from the grid (looking +z), local +x is on the left: red left, green right.
        this.m4.makeTranslation(x + 1.05 - c * 1.05, GANTRY_BEAM - 1.05, -0.17).premultiply(frame);
        this.lamps.setMatrixAt(i, this.m4);
        this.lampColour.push(c);
        i++;
      }
    }
    this.add(this.lamps, { kind: "prop", prefab: "gantry" }, false);
    this.setLights(0);

    // Props: one InstancedMesh per prefab part.
    const byPrefab: Partial<Record<PrefabId, number[]>> = {};
    placed.forEach((pl, idx) => (byPrefab[pl.prefab] ??= []).push(idx));
    this.slot = new Int32Array(placed.length);
    for (const id of Object.keys(byPrefab) as PrefabId[]) {
      const list = byPrefab[id]!;
      const meshes = prefabParts(id, mats).map((part, pi) => {
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, list.length);
        if (part.shared) this.shared.push(part.material);
        // Knocked props leave the instances' original bounds.
        mesh.frustumCulled = PREFABS[id].body !== "knock";
        list.forEach((idx, s) => {
          this.slot[idx] = s;
          this.restMatrix(idx);
          mesh.setMatrixAt(s, this.m4);
          if (pi === 0 && this.tint(id, idx, this.col)) mesh.setColorAt(s, this.col);
        });
        mesh.computeBoundingSphere();
        // Lamp heads and light pools neither cast shadows nor need to.
        this.add(mesh, { kind: "prop", prefab: id }, !part.shared);
        return mesh;
      });
      this.meshes[id] = meshes;
    }
    this.state = new Uint8Array(placed.length);
    this.pos = new Float32Array(placed.length * 3);
    this.vel = new Float32Array(placed.length * 3);
    this.spin = new Float32Array(placed.length * 3);
    this.rot = new Float32Array(placed.length * 4);
    this.flying = new Int32Array(placed.length);
  }

  /** Start gantry: 0 off, 1 red, 2 yellow, 3 green. Cheap to call every frame (no-op when unchanged). */
  setLights(l: 0 | 1 | 2 | 3): void {
    if (l === this.lights) return;
    this.lights = l;
    for (let i = 0; i < this.lampColour.length; i++) {
      const c = this.lampColour[i]!;
      const k = c === l - 1 ? LIGHT_ON : LIGHT_OFF;
      const rgb = LIGHT_RGB[c]!;
      this.lamps.setColorAt(i, this.col.setRGB(rgb[0] * k, rgb[1] * k, rgb[2] * k, THREE.LinearSRGBColorSpace));
    }
    this.lamps.instanceColor!.needsUpdate = true;
  }

  /** Send knockable prop `index` (into `placed`) flying with velocity (vx, vy, vz) m/s; it tumbles and comes to rest on the ground. */
  knock(index: number, vx: number, vy: number, vz: number): void {
    const p = this.placed[index]!;
    if (PREFABS[p.prefab].body !== "knock") return;
    const size = PREFABS[p.prefab].size;
    const i3 = index * 3;
    if (this.state[index] === AT_REST) {
      const hy = size[1] * p.sy * 0.5;
      this.pos[i3] = p.x;
      this.pos[i3 + 1] = p.y + hy;
      this.pos[i3 + 2] = p.z;
      this.q.setFromAxisAngle(this.up, p.yaw).toArray(this.rot, index * 4);
    }
    if (this.state[index] !== FLYING) this.flying[this.flyingCount++] = index;
    this.state[index] = FLYING;
    this.vel[i3] = vx;
    this.vel[i3 + 1] = vy;
    this.vel[i3 + 2] = vz;
    // Roll about the horizontal axis across the motion, plus a deterministic twist.
    const r = Math.max(0.3, size[1] * p.sy * 0.5);
    const twist = (Math.imul(index + 1, 2654435761) >>> 0) / 4294967296 - 0.5;
    this.spin[i3] = (vz / r) * 0.6;
    this.spin[i3 + 1] = twist * 6;
    this.spin[i3 + 2] = (-vx / r) * 0.6;
  }

  /** Animate knocked props (no allocation). */
  update(dt: number): void {
    if (this.flyingCount === 0 || dt <= 0) return;
    const { pos, vel, spin, rot, q, dq, m4 } = this;
    for (let f = 0; f < this.flyingCount; f++) {
      const i = this.flying[f]!;
      const p = this.placed[i]!;
      const size = PREFABS[p.prefab].size;
      const hx = size[0] * p.sx * 0.5;
      const hy = size[1] * p.sy * 0.5;
      const hz = size[2] * p.sz * 0.5;
      const i3 = i * 3;
      vel[i3 + 1]! -= GRAVITY * dt;
      pos[i3]! += vel[i3]! * dt;
      pos[i3 + 1]! += vel[i3 + 1]! * dt;
      pos[i3 + 2]! += vel[i3 + 2]! * dt;
      q.fromArray(rot, i * 4);
      const w = Math.hypot(spin[i3]!, spin[i3 + 1]!, spin[i3 + 2]!);
      if (w > 1e-6) {
        this.axis.set(spin[i3]! / w, spin[i3 + 1]! / w, spin[i3 + 2]! / w);
        q.premultiply(dq.setFromAxisAngle(this.axis, w * dt));
      }
      m4.makeRotationFromQuaternion(q);
      const e = m4.elements;
      // Lowest point of the oriented box below its centre.
      const reach = Math.abs(e[1]!) * hx + Math.abs(e[5]!) * hy + Math.abs(e[9]!) * hz;
      // The surface at or just above the prop's own level: a bridge deck only when it is on it.
      const floor = this.ground.heightAt(pos[i3]!, pos[i3 + 2]!, pos[i3 + 1]! - reach);
      if (pos[i3 + 1]! - reach <= floor) {
        pos[i3 + 1] = floor + reach;
        if (vel[i3 + 1]! < 0) vel[i3 + 1] = vel[i3 + 1]! < -1.5 ? -vel[i3 + 1]! * 0.3 : 0;
        const slide = Math.max(0, 1 - 3 * dt);
        vel[i3]! *= slide;
        vel[i3 + 2]! *= slide;
        const roll = Math.max(0, 1 - 4 * dt);
        spin[i3]! *= roll;
        spin[i3 + 1]! *= roll;
        spin[i3 + 2]! *= roll;
        // Settle onto the box face nearest to down.
        let best = 0;
        for (let a = 1; a < 3; a++) if (Math.abs(e[a * 4 + 1]!) > Math.abs(e[best * 4 + 1]!)) best = a;
        const sign = e[best * 4 + 1]! < 0 ? -1 : 1;
        this.axis.set(e[best * 4]! * sign, e[best * 4 + 1]! * sign, e[best * 4 + 2]! * sign);
        dq.setFromUnitVectors(this.axis, this.up);
        q.premultiply(dq.slerp(this.identity, 1 - Math.min(1, 5 * dt)));
        const v2 = vel[i3]! ** 2 + vel[i3 + 1]! ** 2 + vel[i3 + 2]! ** 2;
        if (v2 < 0.04 && w < 0.3) {
          this.state[i] = DOWN;
          this.flying[f] = this.flying[--this.flyingCount]!;
          f--;
        }
      }
      q.toArray(rot, i * 4);
      m4.makeRotationFromQuaternion(q);
      this.v.set(pos[i3]! - e[4]! * hy, pos[i3 + 1]! - e[5]! * hy, pos[i3 + 2]! - e[6]! * hy);
      m4.compose(this.v, q, this.sc.set(p.sx, p.sy, p.sz));
      const meshes = this.meshes[p.prefab]!;
      for (let k = 0; k < meshes.length; k++) {
        meshes[k]!.setMatrixAt(this.slot[i]!, m4);
        meshes[k]!.instanceMatrix.needsUpdate = true;
      }
    }
  }

  /** Every knocked prop back in place (race restart). */
  reset(): void {
    for (let i = 0; i < this.placed.length; i++) {
      if (this.state[i] === AT_REST) continue;
      this.state[i] = AT_REST;
      this.restMatrix(i);
      for (const mesh of this.meshes[this.placed[i]!.prefab]!) {
        mesh.setMatrixAt(this.slot[i]!, this.m4);
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
    this.flyingCount = 0;
  }

  dispose(): void {
    const geos = new Set<THREE.BufferGeometry>();
    const mats = new Set<THREE.Material>();
    this.group.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      geos.add(o.geometry as THREE.BufferGeometry);
      mats.add(o.material as THREE.Material);
      if (o instanceof THREE.InstancedMesh) o.dispose();
    });
    for (const g of geos) g.dispose();
    for (const m of mats) if (!this.shared.includes(m)) m.dispose();
    const t = this.textures;
    for (const x of [t.asphalt, t.concrete, t.detail, t.windows, t.billboard]) x.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }

  /** Add a tagged mesh: everything receives shadows; `cast` for solid things above the ground. */
  private add(mesh: THREE.Mesh, tag: RaceMeshTag, cast: boolean): void {
    mesh.name = tag.prefab ? `${tag.kind}:${tag.prefab}` : tag.surface ? `${tag.kind}:${tag.surface}` : tag.kind;
    mesh.userData.race = tag;
    mesh.receiveShadow = true;
    mesh.castShadow = cast;
    if (!Array.isArray(mesh.material)) mesh.material = this.forDraw(mesh.material, mesh);
    if (cast && mesh instanceof THREE.InstancedMesh) mesh.customDepthMaterial = mesh.instanceColor ? DEPTH_INSTANCED_COLOR : DEPTH_INSTANCED;
    this.group.add(mesh);
  }

  /**
   * One material per draw kind (plain, instanced, instanced with colours), and the same for the shadow depth
   * material (above): when one material draws more than one kind, three reselects its program (`getProgram`,
   * an allocation) at every switch, 4–5 times a frame on a course. A copy links no new program.
   */
  private forDraw(m: THREE.Material, mesh: THREE.Mesh): THREE.Material {
    const kind: DrawKind = mesh instanceof THREE.InstancedMesh ? (mesh.instanceColor ? "instancedColour" : "instanced") : "plain";
    let copies = this.byKind.get(m);
    if (!copies) {
      copies = { [kind]: m };
      this.byKind.set(m, copies);
    }
    return (copies[kind] ??= m.clone());
  }

  /** Per-instance tint for natural / building variety (deterministic by placement index); false = none. */
  private tint(id: PrefabId, i: number, out: THREE.Color): boolean {
    const h = hash01(i, 11);
    const h2 = hash01(i, 12);
    if (id === "tree") {
      const k = 0.8 + 0.35 * h;
      out.setRGB(k * (1 + 0.24 * (h2 - 0.5)), k, k * (1 - 0.2 * (h2 - 0.5)), THREE.LinearSRGBColorSpace);
      return true;
    }
    if (id === "rock") {
      const k = 0.8 + 0.3 * h;
      out.setRGB(k, k, k, THREE.LinearSRGBColorSpace);
      return true;
    }
    if (id === "building") {
      out.setHex([0xffffff, 0xf2e3c6, 0xd5dde8, 0xeccbb6, 0xdcd8c4][Math.floor(h * 5)]!);
      return true;
    }
    return false;
  }

  /** Placement `i`'s standing matrix into `m4`. */
  private restMatrix(i: number): void {
    const p = this.placed[i]!;
    this.m4.compose(this.v.set(p.x, p.y, p.z), this.q.setFromAxisAngle(this.up, p.yaw), this.sc.set(p.sx, p.sy, p.sz));
  }
}
