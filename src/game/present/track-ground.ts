import * as THREE from "three";
import { clamp } from "../kernel/scalar.ts";
import { SURFACE_IDS, type SurfaceId } from "../world/catalog.ts";
import { TILE } from "./prefabs.ts";
import { type Track, type TrackGround, type TrackPath } from "../world/track.ts";
import type { GroundLevel } from "../scenes/ground-stack.ts";
import {
  BLACK, BLOCK, CELL, CHEQUER, FLAT_TOL, KERB_CURV, KERB_FILL, KERB_LIFT, KERB_WIDTH, MARK_LIFT, Mesher, mottle, PAVED,
  RED, ROAD_LIFT, RoadIndex, sampleAt, sampleStep, SKIRT_RADIUS, surfaceHex, surfY, texClass, WHITE,
} from "./track-mesh.ts";

/** Track art on the ground: terrain with its far skirt, road / runoff ribbons, markings and kerbs. */

/** A deck span this far (m) over the terrain under it is clear of what it crosses; nearer the ground (its ramp ends) it is ground like any other. */
const BRIDGE_CLEAR = 2;
const bridges = new WeakMap<TrackPath, Uint8Array>();

/** Per sample of `p`: 1 where it is a bridge, a deck span at least `BRIDGE_CLEAR` over the terrain under it. */
function bridgeSamples(ground: TrackGround, p: TrackPath): Uint8Array {
  let b = bridges.get(p);
  if (!b) {
    b = new Uint8Array(p.count);
    for (let k = 0; k < p.count; k++) if (p.deck[k] && p.y[k]! - ground.heightAt(p.x[k]!, p.z[k]!, -Infinity) >= BRIDGE_CLEAR) b[k] = 1;
    bridges.set(p, b);
  }
  return b;
}

/** Chunk side in blocks (128 m): the terrain draws chunk by chunk (`TerrainBatch`), so three culls the ones out of view. */
const CHUNK = 16;
/** A chunk draws its far mesh past this flat distance (m) from the camera to its nearest point, its near one again FAR_HOLD m inside it. */
const FAR_RING = 240;
const FAR_HOLD = 16;
/** A far-mesh block's two triangles stay this close (m) to every cell height they cover: about a pixel at FAR_RING on a phone. */
const FAR_TOL = 0.2;

/** The terrain cut into square chunks of CHUNK blocks: each one's xz box and where it starts in the near and far meshes. */
type TerrainChunks = {
  /** The far mesh: the near one with every block clear of roads that fits within FAR_TOL drawn as one quad. */
  coarse: Mesher;
  /** minX, minZ, maxX, maxZ per chunk. */
  box: Float32Array;
  /**
   * First vertex and first index of chunk c at [2c] and [2c + 1], and one more entry closing the last chunk: in the near
   * mesh (the terrain layer's own, its far skirt after the chunks) and in `coarse`.
   */
  fineAt: Int32Array;
  coarseAt: Int32Array;
};

/** The terrain's cell grid over the course and its margin: its corner, size in blocks and cells, and per cell the height, the drawn surface and the path covering it. */
type TerrainGrid = {
  x0: number;
  z0: number;
  bx: number;
  bz: number;
  per: number;
  nx: number;
  terrain: number;
  tile: number;
  h: Float32Array;
  col: Uint8Array;
  cov: Int16Array;
};

function sampleTerrain(track: Track, ground: TrackGround, index: RoadIndex): TerrainGrid {
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
  return { x0, z0, bx, bz, per, nx, terrain, tile, h, col, cov };
}

/** A cell wholly under one path's ribbon is not drawn. */
function dropped(g: TerrainGrid, i: number, j: number): boolean {
  const c = j * g.nx + i;
  const a = g.cov[c]!;
  return a >= 0 && g.cov[c + 1] === a && g.cov[c + g.nx] === a && g.cov[c + g.nx + 1] === a;
}

/** Block kind: 0 hidden, 1 one quad, 2 split into cells. */
function blockKinds(g: TerrainGrid): Uint8Array {
  const { bx, bz, per, nx, terrain, h, col } = g;
  const kind = new Uint8Array(bx * bz);
  for (let bj = 0; bj < bz; bj++) {
    for (let bi = 0; bi < bx; bi++) {
      const i0 = bi * per;
      const j0 = bj * per;
      let drops = 0;
      for (let v = 0; v < per; v++) for (let u = 0; u < per; u++) if (dropped(g, i0 + u, j0 + v)) drops++;
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
  return kind;
}

function buildTerrain(track: Track, ground: TrackGround, index: RoadIndex): { m: Mesher; chunks: TerrainChunks } {
  const m = new Mesher();
  const g = sampleTerrain(track, ground, index);
  const { x0, z0, bx, bz, per, nx, terrain, tile, h, col } = g;
  const kind = blockKinds(g);
  /** Cells between a block's vertices, by kind: 0 hidden, 1 one quad, 2 split into cells, 3 split into 4 m cells (far mesh only). */
  const STEP = [0, per, 1, 2];
  /**
   * Height of the vertex at cell (u, v) of block (bi, bj) as `kinds` draws the blocks: on the edge it shares with a
   * coarser block, that block's edge height (linear between its vertices), so no crack opens.
   */
  const vertexY = (kinds: Uint8Array, bi: number, bj: number, u: number, v: number) => {
    const i = bi * per + u;
    const j = bj * per + v;
    const onU = (u === 0 || u === per) && v !== 0 && v !== per;
    const onV = (v === 0 || v === per) && u !== 0 && u !== per;
    const ni = onU ? bi + (u === 0 ? -1 : 1) : bi;
    const nj = onV ? bj + (v === 0 ? -1 : 1) : bj;
    const t = (onU || onV) && ni >= 0 && nj >= 0 && ni < bx && nj < bz ? STEP[kinds[nj * bx + ni]!]! : 0;
    const along = onU ? v : u;
    if (t <= 1 || along % t === 0) return h[j * nx + i]!;
    const a = along - (along % t);
    const ya = onU ? h[(j - along + a) * nx + i]! : h[j * nx + i - along + a]!;
    const yb = onU ? h[(j - along + a + t) * nx + i]! : h[j * nx + i - along + a + t]!;
    return ya + (yb - ya) * ((along - a) / t);
  };
  /** Whether block (bi, bj), drawn among `kinds` in quads `s` cells wide, stays within FAR_TOL of every cell height. */
  const fits = (kinds: Uint8Array, bi: number, bj: number, s: number) => {
    for (let v = 0; v <= per; v++) {
      for (let u = 0; u <= per; u++) {
        // The quad holding (u, v); its triangles meet on the diagonal from its (s, 0) corner to its (0, s) one (`Mesher.quad`).
        const qu = Math.min(u - (u % s), per - s);
        const qv = Math.min(v - (v % s), per - s);
        const fu = u - qu;
        const fv = v - qv;
        const y00 = vertexY(kinds, bi, bj, qu, qv);
        const y10 = vertexY(kinds, bi, bj, qu + s, qv);
        const y01 = vertexY(kinds, bi, bj, qu, qv + s);
        const y11 = vertexY(kinds, bi, bj, qu + s, qv + s);
        const y = fu + fv <= s ? y00 + ((y10 - y00) * fu + (y01 - y00) * fv) / s : y11 + ((y01 - y11) * (s - fu) + (y10 - y11) * (s - fv)) / s;
        if (Math.abs(h[(bj * per + v) * nx + bi * per + u]! - y) > FAR_TOL) return false;
      }
    }
    return true;
  };
  /** Whether no road is on or near block (bi, bj): one colour all over and no ribbon within a cell of it. */
  const clear = (bi: number, bj: number) => {
    const i0 = bi * per;
    const j0 = bj * per;
    for (let v = 0; v <= per; v++) {
      for (let u = 0; u <= per; u++) {
        if (col[(j0 + v) * nx + i0 + u] !== col[j0 * nx + i0]) return false;
        if (index.coveredBy(x0 + (i0 + u) * CELL, z0 + (j0 + v) * CELL, -CELL) >= 0) return false;
      }
    }
    return true;
  };
  // The far mesh: a split block clear of roads draws as one quad, or else in 4 m cells, when that stays within
  // FAR_TOL of every cell height. Blocks on a chunk's edge keep their kind, so both meshes draw a chunk's seam alike
  // and a near chunk never cracks against a far neighbour. A 4 m block's fit reads its one-quad neighbours' edges.
  const farKind = kind.slice();
  for (let bj = 0; bj < bz; bj++) {
    for (let bi = 0; bi < bx; bi++) {
      const edge = bi % CHUNK === 0 || bj % CHUNK === 0 || bi % CHUNK === CHUNK - 1 || bj % CHUNK === CHUNK - 1;
      if (edge || kind[bj * bx + bi] !== 2 || !clear(bi, bj)) continue;
      farKind[bj * bx + bi] = fits(farKind, bi, bj, per) ? 1 : 3;
    }
  }
  for (let b = 0; b < bx * bz; b++) {
    if (farKind[b] === 3 && !fits(farKind, b % bx, Math.floor(b / bx), 2)) farKind[b] = 2;
  }
  const n = new THREE.Vector3();
  const vert = (out: Mesher, i: number, j: number, y: number) => {
    const x = x0 + i * CELL;
    const z = z0 + j * CELL;
    const id = out.v(x, y, z, surfaceHex(col[j * nx + i]!), x / tile, z / tile, mottle(x, z));
    ground.normalAt(x, z, n, -Infinity);
    out.normal(id, n.x, n.y, n.z);
    return id;
  };
  const ids = new Int32Array((per + 1) * (per + 1));
  /** Block (bi, bj) into `out` as `kinds` has it: hidden, or quads STEP cells wide (a split block leaves out its dropped cells). */
  const addBlock = (out: Mesher, kinds: Uint8Array, bi: number, bj: number) => {
    const s = STEP[kinds[bj * bx + bi]!]!;
    if (s === 0) return;
    const i0 = bi * per;
    const j0 = bj * per;
    const row = per / s + 1;
    for (let v = 0; v <= per; v += s) {
      for (let u = 0; u <= per; u += s) ids[(v / s) * row + u / s] = vert(out, i0 + u, j0 + v, vertexY(kinds, bi, bj, u, v));
    }
    for (let v = 0; v < per; v += s) {
      for (let u = 0; u < per; u += s) {
        if (dropped(g, i0 + u, j0 + v)) continue;
        const a = (v / s) * row + u / s;
        // Rows run +z (ahead), columns +x: +x is left of +z, so the +x vertex is the left one.
        out.quad(ids[a]!, ids[a + 1]!, ids[a + row]!, ids[a + row + 1]!);
      }
    }
  };
  const coarse = new Mesher();
  const cx = Math.ceil(bx / CHUNK);
  const cz = Math.ceil(bz / CHUNK);
  const box = new Float32Array(cx * cz * 4);
  const fineAt = new Int32Array(cx * cz * 2 + 2);
  const coarseAt = new Int32Array(cx * cz * 2 + 2);
  const mark = (c: number) => {
    fineAt[c * 2] = m.pos.length / 3;
    fineAt[c * 2 + 1] = m.idx.length;
    coarseAt[c * 2] = coarse.pos.length / 3;
    coarseAt[c * 2 + 1] = coarse.idx.length;
  };
  for (let c = 0; c < cx * cz; c++) {
    mark(c);
    const ci = c % cx;
    const cj = Math.floor(c / cx);
    const bi1 = Math.min(bx, (ci + 1) * CHUNK);
    const bj1 = Math.min(bz, (cj + 1) * CHUNK);
    box.set([x0 + ci * CHUNK * BLOCK, z0 + cj * CHUNK * BLOCK, x0 + bi1 * BLOCK, z0 + bj1 * BLOCK], c * 4);
    for (let bj = cj * CHUNK; bj < bj1; bj++) {
      for (let bi = ci * CHUNK; bi < bi1; bi++) {
        addBlock(m, kind, bi, bj);
        addBlock(coarse, farKind, bi, bj);
      }
    }
  }
  mark(cx * cz);
  addSkirt(m, ground, x0, z0, bx, bz, surfaceHex(terrain), tile);
  return { m, chunks: { coarse, box, fineAt, coarseAt } };
}

/** Far skirt: an annulus under the terrain grid's edge out to the horizon, just below the base terrain. */
function addSkirt(m: Mesher, ground: TrackGround, x0: number, z0: number, bx: number, bz: number, hex: number, tile: number): void {
  const cx = x0 + (bx * BLOCK) / 2;
  const cz = z0 + (bz * BLOCK) / 2;
  const inner = (Math.min(bx, bz) * BLOCK) / 2;
  const rings = 10;
  const seg = 72;
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
}

/** Ribbon meshers by kind, surface and whether the section is on a bridge deck (a deck's top is its own base-level mesh). */
type Ribbons = Map<string, { kind: "road" | "runoff"; surface: number; deck: boolean; m: Mesher }>;

/** Road and runoff strips of `p` (smooth along the path, one mesher per kind + surface). */
function addRibbons(out: Ribbons, p: TrackPath, secs: readonly number[], ground: TrackGround, lift: number): void {
  const n = secs.length;
  const last = p.closed ? n : n - 1;
  const bridge = bridgeSamples(ground, p);
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
      const deck = bridge[k] === 1;
      const key = `${kind}:${sid}:${deck ? "deck" : ""}`;
      let found = out.get(key);
      if (!found) {
        found = { kind, surface: sid, deck, m: new Mesher() };
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
  readonly p: TrackPath;
  private readonly secs: readonly number[];
  private readonly ground: TrackGround;
  private readonly n: number;
  private readonly ds: number;
  /** 1 per sample where this path is a bridge (`bridgeSamples`). */
  readonly bridge: Uint8Array;

  constructor(p: TrackPath, secs: readonly number[], ground: TrackGround) {
    this.p = p;
    this.secs = secs;
    this.ground = ground;
    this.n = p.count;
    this.ds = sampleStep(p);
    this.bridge = bridgeSamples(ground, p);
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

/** Edge lines and centre dashes on paved stretches (a bridge's go to `deck`), a chequered line on the loop; none where another road crosses. */
function addMarkings(m: Mesher, deck: Mesher, pi: number, rs: RibbonSurface, secs: readonly number[], index: RoadIndex): void {
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
        addSpan(rs.bridge[k] ? deck : m, rs, sa, sb, side > 0 ? -0.35 : 0.13, side > 0 ? -0.13 : 0.35, side, MARK_LIFT, WHITE);
      }
    }
  }
  for (let s = main ? 6 : 1.5; s + 3 <= L - (main ? 3 : 0); s += 9) {
    const k = sampleAt(p, s);
    const k2 = sampleAt(p, s + 3);
    if (!PAVED.includes(p.surface[k]!) || !clear(k, 0) || !clear(k2, 0)) continue;
    addSpan(rs.bridge[k] ? deck : m, rs, s, s + 3, -0.09, 0.09, 0, MARK_LIFT, WHITE);
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

/** Red / white kerbs on the inside of the loop's tight turns (paved, not at crossings; a bridge's go to `deck`). */
function addKerbs(m: Mesher, deck: Mesher, rs: RibbonSurface, index: RoadIndex): void {
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
    addSpan(rs.bridge[k] ? deck : m, rs, s, s + 2, c > 0 ? -0.05 : -KERB_WIDTH, c > 0 ? KERB_WIDTH : 0.05, c > 0 ? 1 : -1, KERB_LIFT, hex);
  }
}


/**
 * One ground mesh of a course: what it is, the surface it shows, its level in the stack (`ground-stack.ts`) and its
 * geometry; the terrain's also comes in chunks with a far mesh (`TerrainBatch`).
 */
type GroundLayer = { kind: "terrain" | "runoff" | "road" | "marking" | "kerb"; surface: SurfaceId | null; level: GroundLevel; m: Mesher; smooth: boolean; chunks: TerrainChunks | null };

/**
 * Every ground mesh of a course, bottom of the stack up: the terrain, the road and runoff ribbons (one per kind and
 * surface, all paths together), markings, kerbs. The ribbons all lift by `ROAD_LIFT`; their level orders them. What lies
 * on a bridge deck is split off into "deck" level meshes (depth-written, ordered by height), after the ground ones.
 */
export function buildGroundLayers(track: Track, ground: TrackGround, index: RoadIndex, paths: readonly TrackPath[], secs: readonly (readonly number[])[]): GroundLayer[] {
  const terrain = buildTerrain(track, ground, index);
  const out: GroundLayer[] = [{ kind: "terrain", surface: track.json.environment.terrain, level: "terrain", m: terrain.m, smooth: false, chunks: terrain.chunks }];
  const ribbons: Ribbons = new Map();
  for (const [i, p] of paths.entries()) addRibbons(ribbons, p, secs[i]!, ground, ROAD_LIFT);
  for (const r of ribbons.values()) {
    const surface = SURFACE_IDS[r.surface]!;
    out.push({ kind: r.kind, surface, level: r.deck ? "deck" : r.kind === "road" ? surface : "runoff", m: r.m, smooth: true, chunks: null });
  }
  const marks = new Mesher();
  const deckMarks = new Mesher();
  for (const [i, p] of paths.entries()) addMarkings(marks, deckMarks, i, new RibbonSurface(p, secs[i]!, ground), secs[i]!, index);
  out.push({ kind: "marking", surface: null, level: "marking", m: marks, smooth: true, chunks: null });
  if (!deckMarks.empty) out.push({ kind: "marking", surface: null, level: "deck", m: deckMarks, smooth: true, chunks: null });
  const kerbs = new Mesher();
  const deckKerbs = new Mesher();
  addKerbs(kerbs, deckKerbs, new RibbonSurface(paths[0]!, secs[0]!, ground), index);
  if (!kerbs.empty) out.push({ kind: "kerb", surface: null, level: "kerb", m: kerbs, smooth: true, chunks: null });
  if (!deckKerbs.empty) out.push({ kind: "kerb", surface: null, level: "deck", m: deckKerbs, smooth: true, chunks: null });
  return out;
}

/**
 * The terrain in one draw call: its chunks in a batch. Each render, a chunk whose bounds leave the camera's view is
 * left out, and a chunk draws its near mesh while the camera is within FAR_RING m of it (flat distance to its nearest
 * point), its far mesh beyond, and its near one again only FAR_HOLD m inside the ring, so a camera on the ring never
 * flips it frame to frame. The batch re-sends its draw list only on a frame where a chunk changed (three culls nothing
 * itself). The far skirt is always drawn.
 */
export class TerrainBatch extends THREE.BatchedMesh {
  /** minX, minZ, maxX, maxZ per drawn chunk (the batch's instance with the same index; chunks with no triangles are left out). */
  readonly box: Float32Array;
  /** 1 while a drawn chunk draws its far mesh. */
  readonly far: Uint8Array;
  /** Near and far geometry ids per drawn chunk. */
  private readonly lods: Int32Array;
  /** Per drawn chunk, its near and far meshes' bounds together: what the view is tested against. */
  private readonly bounds: THREE.Box3[];
  private readonly frustum = new THREE.Frustum();
  private readonly viewProjection = new THREE.Matrix4();

  constructor(m: Mesher, t: TerrainChunks, material: THREE.Material) {
    const chunks = t.box.length / 4;
    super(chunks + 1, m.pos.length / 3 + t.coarse.pos.length / 3, m.idx.length + t.coarse.idx.length, material);
    this.sortObjects = false;
    this.perObjectFrustumCulled = false;
    let drawn = 0;
    for (let c = 0; c < chunks; c++) drawn += t.fineAt[c * 2 + 3]! > t.fineAt[c * 2 + 1]! ? 1 : 0;
    this.box = new Float32Array(drawn * 4);
    this.far = new Uint8Array(drawn);
    this.lods = new Int32Array(drawn * 2);
    this.bounds = new Array<THREE.Box3>(drawn);
    for (let c = 0, k = 0; c < chunks; c++) {
      const f = t.fineAt;
      const g = t.coarseAt;
      if (f[c * 2 + 3]! === f[c * 2 + 1]!) continue;
      const near = m.part(f[c * 2]!, f[c * 2 + 2]!, f[c * 2 + 1]!, f[c * 2 + 3]!);
      const far = t.coarse.part(g[c * 2]!, g[c * 2 + 2]!, g[c * 2 + 1]!, g[c * 2 + 3]!);
      near.computeBoundingBox();
      far.computeBoundingBox();
      this.bounds[k] = near.boundingBox!.clone().union(far.boundingBox!);
      this.lods[k * 2] = this.addGeometry(near);
      this.lods[k * 2 + 1] = this.addGeometry(far);
      this.addInstance(this.lods[k * 2]!);
      this.box.set(t.box.subarray(c * 4, c * 4 + 4), k * 4);
      k++;
    }
    this.addInstance(this.addGeometry(m.part(t.fineAt[chunks * 2]!, m.pos.length / 3, t.fineAt[chunks * 2 + 1]!, m.idx.length)));
  }

  override onBeforeRender(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, geometry: THREE.BufferGeometry, material: THREE.Material, group: THREE.Group): void {
    this.view(camera);
    super.onBeforeRender(renderer, scene, camera, geometry, material, group);
  }

  /** Which chunks `camera` sees, and the near or far mesh for each (no allocation). */
  view(camera: THREE.Camera): void {
    this.frustum.setFromProjectionMatrix(this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse), camera.coordinateSystem, camera.reversedDepth);
    const e = camera.matrixWorld.elements;
    const x = e[12]!;
    const z = e[14]!;
    const box = this.box;
    for (let k = 0; k < this.far.length; k++) {
      this.setVisibleAt(k, this.frustum.intersectsBox(this.bounds[k]!));
      const dx = Math.max(box[k * 4]! - x, x - box[k * 4 + 2]!, 0);
      const dz = Math.max(box[k * 4 + 1]! - z, z - box[k * 4 + 3]!, 0);
      const ring = this.far[k] === 1 ? FAR_RING - FAR_HOLD : FAR_RING;
      const far = dx * dx + dz * dz > ring * ring ? 1 : 0;
      if (far === this.far[k]) continue;
      this.far[k] = far;
      this.setGeometryIdAt(k, this.lods[k * 2 + far]!);
    }
  }
}
