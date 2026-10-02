import * as THREE from "three";
import { clamp } from "../kernel/scalar.ts";
import { SURFACE_IDS } from "../world/catalog.ts";
import { TILE } from "./prefabs.ts";
import { type Track, type TrackGround, type TrackPath } from "../world/track.ts";
import {
  BLACK, BLOCK, CELL, CHEQUER, FLAT_TOL, KERB_CURV, KERB_FILL, KERB_LIFT, KERB_WIDTH, MARK_LIFT, Mesher, mottle, PAVED,
  RED, RoadIndex, sampleAt, sampleStep, SKIRT_RADIUS, surfaceHex, surfY, texClass, WHITE,
} from "./track-mesh.ts";

/** Track art on the ground: terrain with its far skirt, road / runoff ribbons, markings and kerbs. */

export function buildTerrain(track: Track, ground: TrackGround, index: RoadIndex): THREE.BufferGeometry {
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
  addSkirt(m, ground, x0, z0, bx, bz, surfaceHex(terrain), tile);
  return m.geometry(false);
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

/** Ribbon meshers by kind and surface. */
export type Ribbons = Map<string, { kind: "road" | "runoff"; surface: number; m: Mesher }>;

/** Road and runoff strips of `p` (smooth along the path, one mesher per kind + surface). */
export function addRibbons(out: Ribbons, p: TrackPath, secs: readonly number[], ground: TrackGround, lift: number): void {
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
export class RibbonSurface {
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
export function addMarkings(m: Mesher, pi: number, rs: RibbonSurface, secs: readonly number[], index: RoadIndex): void {
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
export function addKerbs(m: Mesher, rs: RibbonSurface, index: RoadIndex): void {
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

