import { IMPRINT_NONE } from "../deform/load-crush.ts";
import { INF_K } from "../deform/deform-build.ts";
import { cageAxis } from "../deform/deform-state.ts";
import { RES_SLOTS, SKIN_K } from "../deform/deform-rig.ts";
import { interiorPose } from "./part-pose.ts";

/**
 * The car's contact shape is its drawn body (docs/UNIFIED_CONTACT.md stage 3): the cage.
 *
 * About a hundred of the drawn body mesh's own vertices (`decimate`, once per style), each skinned from the car's 20 masses
 * and 16 cluster maps by the weights the drawn mesh uses (`skinCage`: the skin's shape-mode loop over those vertices, in
 * the same order of operations, less the accordion folds, which are `Math.sin`/`Math.exp` and visual), joined by the
 * decimated mesh's 150-330 triangles. Fitted in the body's own frame on every slice the masses moved (`refitCage`), the
 * cage is three fields on a lattice of nodes (`CAGE_STEP`, the grid `Surface.setGridData` takes): the highest and the
 * lowest drawn height over each node (NaN where the cage has none) and the signed plan distance to its outline. The
 * vertices are the rigid step's hull points. Heights are in the body mesh's frame: the class's body lift (a plain y offset)
 * goes on at the car's frame, as `CarSurfaces.sync` adds it today.
 *
 * A pristine car shares its style's fields (one build per style); a car that has crushed owns its own, allocated once, and
 * refitted into in place: a refit allocates nothing. Nothing here knows a car, a world or a pose.
 *
 * @internal Imported by nothing until the Stage 3 lane wires it in (`armTops`, `HULL`, `satCars`, the ragdoll proxies).
 */

/** The lattice's half width (m) along x and along z: the body (x ±0.91, z ±2.11) and the skin's 1.35 m travel cap, trimmed. */
const HALF_X = 1.2;
const HALF_Z = 2.4;
/** Node spacing (m) of the fields. */
export const CAGE_STEP = 0.05;
/** The decimation's vertex target: the body and its panels (lids, glass), which keeps the cage near 300 triangles (see docs in the handoff for the fit measured at each). */
export const CAGE_VERTICES = 200;
/** The interior's vertex target: what shows through a gone pane (the dash, the headliner, the seats), a few boxes. */
const INTERIOR_VERTICES = 32;
/** A node this far (in steps) outside a triangle still takes its height (clamped to the triangle's), so an edge never leaves a gap. */
const EXPAND = 0.5;

/** `SkinDynamic.params` slots the shape-mode skin reads that the cage honours (kernels/skin/src/lib.rs, streamed-deform.ts `skin`). */
export const P_CAP = 3;
export const P_ROOF_CLAMP = 4;
export const P_CUT_Y = 9;
export const P_CUT_X = 10;
export const P_CUT_Z = 11;
/** The skin's roof clamp: a vertex of the rest roof (over this height) rises at most `ROOF_UP` and sinks at most `ROOF_DOWN` (streamed-deform.ts `skin`). */
const ROOF_CLAMP_Y = 1.05;
const ROOF_DOWN = 0.1;
const ROOF_UP = 0.08;
/** The wheel arch's share of the hub's own offset it plants the paint at, with the wheel on and off (streamed-deform.ts `skin`). */
const ARCH_ON = 0.82;
const ARCH_OFF = 0.15;
/** `SkinDynamic.hubs`: 5 numbers per mass. */
const HUB_STRIDE = 5;

/** What the rig hands the cage once per style: the drawn body's rest mesh and the skin's rest-only tables over it. */
export interface CageSource {
  /** The body mesh's rest positions, x, y, z per vertex, and its triangle indices. */
  readonly rest: Float32Array;
  readonly index: ArrayLike<number>;
  /** Per vertex: cluster count, `clusterXf` offsets and weights (`SKIN_K` each); parent masses (`RES_SLOTS` each: offsets into `massPos`, weights) and their rest centroid; the hub mass planting an arch vertex (-1 none). */
  readonly skinN: Uint8Array;
  readonly skinXf: Int32Array;
  readonly skinW: Float64Array;
  readonly resJ: Int32Array;
  readonly resW: Float64Array;
  readonly resC: Float64Array;
  readonly skinHub: Int32Array;
  /** The masses' rest positions, x, y, z each, and the cluster count: the inputs of a pristine car. */
  readonly massRest: Float64Array;
  readonly clusterCount: number;
  /** `cageCoeffs` of the cages at rest. */
  readonly restCo: Float64Array;
  /** Per vertex: cage influences (`INF_K` each): count, `cageCo` offset, (u, v, w, weight). */
  readonly infN: Uint8Array;
  readonly infCo: Int32Array;
  readonly infUvw: Float64Array;
  /** Per source vertex: 0 the body mesh, k + 1 panel k; and the number of panels (at most 255). */
  readonly group: Uint8Array;
  readonly panelCount: number;
  /** Per panel, the origin its mesh is skinned about (`skinPanel`'s), x, y, z. */
  readonly panelOrigin: Float64Array;
  /** Per panel: 1 for a glass pane, 0 for a lid or the light bar. */
  readonly panelGlass: Uint8Array;
  /** The interior mesh's rest positions (x, y, z per vertex) and triangle indices: seen through a gone pane, so part of the body drawn. */
  readonly interiorRest: Float32Array;
  readonly interiorIndex: ArrayLike<number>;
  /** Offsets into `massPos` (3 each) of the masses `fitInterior` places it by: `INTERIOR_MASSES`, in that order. */
  readonly interiorMass: Int32Array;
}

/** What a fit reads of the car now: a `SkinDynamic`, less its lattice coefficients (the cage is the shape-mode skin). */
export interface CageLive {
  /** Per cluster, its skin map (row-major 9): `StreamedDeformation.clusterXf`. */
  readonly X: Float64Array;
  /** Per mass, its particle in the body frame as of the last skin bake (x, y, z): `massPos`. */
  readonly pos: Float64Array;
  /** Per mass: popped (0/1), local x, rest x, local z, rest z. */
  readonly hubs: Float64Array;
  /** `SkinDynamic.params` (12). */
  readonly params: Float64Array;
  /** `cageCoeffs` of every cage (24 each): the cages the lattice vertices ride. */
  readonly co: Float64Array;
  /** Per panel: 1 while its mesh is on the car (a torn-off hood or a shattered pane is not drawn, so it is not the cage). */
  readonly panelOn: Uint8Array;
  /** 1 for a crashed car, whose panels follow the cage (`skinPanels` runs only then); 0 for a car whose panels stand at rest. */
  panelsFollow: number;
  /** Per panel, where its mesh stands: position (x, y, z), then rotation (x, y, z, w) about it (a bonnet's hinge). */
  readonly panelPose: Float64Array;
}

/** One fit's results: what a pristine style shares among its cars and a crushed car owns. */
export interface CageFields {
  /** The vertices in the body frame, x, y, z each: the rigid step's hull points. */
  readonly pos: Float64Array;
  /** Per vertex: its height before the roof imprint's cut (the cut is laid over the nodes by `rasterise`; `pos` carries it for the hull points). */
  readonly rawY: Float64Array;
  /** Per node (row-major, `nu` × `nv`): the highest and the lowest height of the cage over it, NaN where it has none. */
  readonly top: Float32Array;
  readonly bottom: Float32Array;
  /** Per node: 1 where the cage's plan strictly covers it. */
  readonly covered: Uint8Array;
  /** Per node: signed distance (m) to the plan outline, negative inside. Current only while `planFresh` (`CarCage.planField` makes it so). */
  readonly plan: Float32Array;
  planFresh: boolean;
  /** The drawn triangles' bounds in the body frame: x min, x max, z min, z max (m): the plan extent every box-shaped reader of a car (a prop's footprint, a ramp's width, the lab) takes. */
  readonly planBox: Float64Array;
  /** Bounds on |top| and |bottom| (m): what `Surface.setGridData` takes as `hmax`. */
  heightMax: number;
  /** Per panel (`CageStyle.vertexGroup` k + 1): 1 while its mesh is on the car as of the fit; a torn-off or shattered panel's vertices stay in `pos` but are no part of the drawn body. */
  readonly panelOn: Uint8Array;
}

/** A style's cage: built once from the rig, never changes. */
export interface CageStyle {
  readonly step: number;
  readonly nu: number;
  readonly nv: number;
  /** Frame x and z of node (0, 0). */
  readonly u0: number;
  readonly v0: number;
  readonly vertexCount: number;
  readonly triCount: number;
  /** The drawn mesh's vertex each cage vertex is. */
  readonly source: Int32Array;
  /** Triangles, three vertex indices each. */
  readonly tris: Uint16Array;
  readonly rest: Float64Array;
  readonly skinN: Uint8Array;
  readonly skinXf: Int32Array;
  readonly skinW: Float64Array;
  readonly resJ: Int32Array;
  readonly resW: Float64Array;
  readonly resC: Float64Array;
  readonly skinHub: Int32Array;
  /** Per vertex: cage influences (`INF_K` each): count, `cageCo` offset, (u, v, w, weight): the skin of a vertex no cluster holds. */
  readonly infN: Uint8Array;
  readonly infCo: Int32Array;
  readonly infUvw: Float64Array;
  /** The rig's mass and cluster counts (the layout of `Fit.last`). */
  readonly massCount: number;
  readonly clusterCount: number;
  /** The inputs of a pristine car, laid out as `Fit.last`: masses, clusters, hubs. */
  readonly restInputs: Float64Array;
  /** Per triangle: 0 the body, k + 1 panel k (a hood, a boot lid, a glass pane: a mesh of its own over the body). */
  readonly triGroup: Uint8Array;
  /** Per cage vertex: 0 the body, k + 1 panel k. */
  readonly vertexGroup: Uint8Array;
  readonly panelCount: number;
  /** Per panel, the origin its mesh is skinned about (`skinPanel`'s), x, y, z. */
  readonly panelOrigin: Float64Array;
  /** Every panel on, the fit of a pristine car. */
  readonly panelsOn: Uint8Array;
  /** Per panel: 1 for a glass pane, 0 for a lid (`CageSource.panelGlass`). */
  readonly panelGlass: Uint8Array;
  /** The interior's vertices follow the body's in `pos` (`vertexCount` is the body's alone: the rigid step's hull points are those), and its triangles the body's, in group `panelCount + 1`: never a lid, never cut by the roof imprint. */
  readonly interiorCount: number;
  /** The interior's rest positions as `fitInterior` places them with the masses at rest, x, y, z each. */
  readonly interiorRest: Float32Array;
  readonly interiorMass: Int32Array;
  /** The fields of a pristine car, shared by every car of the style. */
  readonly pristine: CageFields;
}

// ---- the cage's mesh -----------------------------------------------------------------------------------------------

const QUADRIC = 10;

/** Adds `weight` × (n, d)(n, d)ᵀ (the plane n·p + d = 0, n unit) to quadric `q` at offset `o`. */
function addPlane(q: Float64Array, o: number, nx: number, ny: number, nz: number, d: number, weight: number): void {
  q[o] += weight * nx * nx;
  q[o + 1] += weight * nx * ny;
  q[o + 2] += weight * nx * nz;
  q[o + 3] += weight * nx * d;
  q[o + 4] += weight * ny * ny;
  q[o + 5] += weight * ny * nz;
  q[o + 6] += weight * ny * d;
  q[o + 7] += weight * nz * nz;
  q[o + 8] += weight * nz * d;
  q[o + 9] += weight * d * d;
}

function quadricError(q: Float64Array, o: number, x: number, y: number, z: number): number {
  return (
    q[o]! * x * x + 2 * q[o + 1]! * x * y + 2 * q[o + 2]! * x * z + 2 * q[o + 3]! * x +
    q[o + 4]! * y * y + 2 * q[o + 5]! * y * z + 2 * q[o + 6]! * y +
    q[o + 7]! * z * z + 2 * q[o + 8]! * z + q[o + 9]!
  );
}

/** Folded-over triangles stay out: a collapse may not turn a neighbouring triangle's normal below this cosine. */
const MIN_COS = 0.2;
/** Boundary edges are held in place by a plane of this weight per m² of edge. */
const BOUNDARY_WEIGHT = 100;

/**
 * The drawn mesh's vertices that stay and the triangles between them: edge-collapse decimation by quadric error (Garland
 * and Heckbert 1997), each collapse moving one end onto the other (never to a new place), so every cage vertex is a
 * vertex of the drawn mesh and takes that vertex's skin weights as they are. Vertices at one rest position are one
 * (the mesh splits them for its normals). Build-time only: allocates freely, runs once per style.
 */
function decimate(rest: Float32Array, index: ArrayLike<number>, group: Uint8Array, target: number): { source: Int32Array; tris: Uint16Array; triGroup: Uint8Array } {
  const meshVertices = rest.length / 3;
  // Weld by rest position, within one mesh (a panel's vertex at the body's is not the body's).
  const weld = new Int32Array(meshVertices);
  const keys = new Map<string, number>();
  const reps: number[] = [];
  for (let i = 0; i < meshVertices; i++) {
    const key = `${group[i]!}|${Math.round(rest[i * 3]! * 1e4)},${Math.round(rest[i * 3 + 1]! * 1e4)},${Math.round(rest[i * 3 + 2]! * 1e4)}`;
    let id = keys.get(key);
    if (id === undefined) {
      id = reps.length;
      keys.set(key, id);
      reps.push(i);
    }
    weld[i] = id;
  }
  const nv = reps.length;
  const px = new Float64Array(nv);
  const py = new Float64Array(nv);
  const pz = new Float64Array(nv);
  for (let v = 0; v < nv; v++) {
    px[v] = rest[reps[v]! * 3]!;
    py[v] = rest[reps[v]! * 3 + 1]!;
    pz[v] = rest[reps[v]! * 3 + 2]!;
  }
  // Welded triangles, without degenerate or repeated ones.
  const triList: number[] = [];
  const seen = new Set<string>();
  for (let t = 0; t + 2 < index.length; t += 3) {
    const a = weld[index[t]!]!;
    const b = weld[index[t + 1]!]!;
    const c = weld[index[t + 2]!]!;
    if (a === b || b === c || a === c) continue;
    const key = [a, b, c].sort((p, q) => p - q).join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    triList.push(a, b, c);
  }
  const nt = triList.length / 3;
  const tv = Int32Array.from(triList);
  const alive = new Uint8Array(nt).fill(1);
  const vertexAlive = new Uint8Array(nv).fill(1);
  const incident: number[][] = Array.from({ length: nv }, () => []);
  const neighbours: Set<number>[] = Array.from({ length: nv }, () => new Set<number>());
  const Q = new Float64Array(nv * QUADRIC);
  const edgeTris = new Map<number, number>();
  const edgeKey = (a: number, b: number): number => (a < b ? a * nv + b : b * nv + a);
  for (let t = 0; t < nt; t++) {
    const a = tv[t * 3]!;
    const b = tv[t * 3 + 1]!;
    const c = tv[t * 3 + 2]!;
    incident[a]!.push(t);
    incident[b]!.push(t);
    incident[c]!.push(t);
    neighbours[a]!.add(b).add(c);
    neighbours[b]!.add(a).add(c);
    neighbours[c]!.add(a).add(b);
    for (const k of [edgeKey(a, b), edgeKey(b, c), edgeKey(a, c)]) edgeTris.set(k, (edgeTris.get(k) ?? 0) + 1);
    const ux = px[b]! - px[a]!;
    const uy = py[b]! - py[a]!;
    const uz = pz[b]! - pz[a]!;
    const wx = px[c]! - px[a]!;
    const wy = py[c]! - py[a]!;
    const wz = pz[c]! - pz[a]!;
    let nx = uy * wz - uz * wy;
    let ny = uz * wx - ux * wz;
    let nz = ux * wy - uy * wx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len < 1e-12) continue;
    nx /= len;
    ny /= len;
    nz /= len;
    const d = -(nx * px[a]! + ny * py[a]! + nz * pz[a]!);
    const area = len / 2;
    for (const v of [a, b, c]) addPlane(Q, v * QUADRIC, nx, ny, nz, d, area);
  }
  // Boundary edges (one triangle): a plane through the edge, square to its triangle.
  for (let t = 0; t < nt; t++) {
    for (let e = 0; e < 3; e++) {
      const a = tv[t * 3 + e]!;
      const b = tv[t * 3 + ((e + 1) % 3)]!;
      if (edgeTris.get(edgeKey(a, b)) !== 1) continue;
      const c = tv[t * 3 + ((e + 2) % 3)]!;
      const ex = px[b]! - px[a]!;
      const ey = py[b]! - py[a]!;
      const ez = pz[b]! - pz[a]!;
      const wx = px[c]! - px[a]!;
      const wy = py[c]! - py[a]!;
      const wz = pz[c]! - pz[a]!;
      const fx = ey * wz - ez * wy;
      const fy = ez * wx - ex * wz;
      const fz = ex * wy - ey * wx;
      let nx = ey * fz - ez * fy;
      let ny = ez * fx - ex * fz;
      let nz = ex * fy - ey * fx;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const edgeLength = Math.sqrt(ex * ex + ey * ey + ez * ez);
      if (len < 1e-12) continue;
      nx /= len;
      ny /= len;
      nz /= len;
      const d = -(nx * px[a]! + ny * py[a]! + nz * pz[a]!);
      for (const v of [a, b]) addPlane(Q, v * QUADRIC, nx, ny, nz, d, BOUNDARY_WEIGHT * edgeLength * edgeLength);
    }
  }

  const tmp = new Float64Array(QUADRIC);
  /** Cost of moving `from` onto `to`: the merged quadric at `to`'s place; Infinity when a neighbouring triangle would fold over. */
  const cost = (from: number, to: number): number => {
    for (const t of incident[from]!) {
      if (!alive[t]) continue;
      const a = tv[t * 3]!;
      const b = tv[t * 3 + 1]!;
      const c = tv[t * 3 + 2]!;
      if (a === to || b === to || c === to) continue;
      const ax = px[a]!;
      const ay = py[a]!;
      const az = pz[a]!;
      const bx = px[b]!;
      const by = py[b]!;
      const bz = pz[b]!;
      const cx = px[c]!;
      const cy = py[c]!;
      const cz = pz[c]!;
      const n0x = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      const n0y = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      const n0z = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const fa = a === from;
      const fb = b === from;
      const fc = c === from;
      const ax1 = fa ? px[to]! : ax;
      const ay1 = fa ? py[to]! : ay;
      const az1 = fa ? pz[to]! : az;
      const bx1 = fb ? px[to]! : bx;
      const by1 = fb ? py[to]! : by;
      const bz1 = fb ? pz[to]! : bz;
      const cx1 = fc ? px[to]! : cx;
      const cy1 = fc ? py[to]! : cy;
      const cz1 = fc ? pz[to]! : cz;
      const n1x = (by1 - ay1) * (cz1 - az1) - (bz1 - az1) * (cy1 - ay1);
      const n1y = (bz1 - az1) * (cx1 - ax1) - (bx1 - ax1) * (cz1 - az1);
      const n1z = (bx1 - ax1) * (cy1 - ay1) - (by1 - ay1) * (cx1 - ax1);
      const l0 = Math.sqrt(n0x * n0x + n0y * n0y + n0z * n0z);
      const l1 = Math.sqrt(n1x * n1x + n1y * n1y + n1z * n1z);
      if (l0 < 1e-12) continue;
      if (l1 < 1e-12 || (n0x * n1x + n0y * n1y + n0z * n1z) / (l0 * l1) < MIN_COS) return Infinity;
    }
    for (let k = 0; k < QUADRIC; k++) tmp[k] = Q[from * QUADRIC + k]! + Q[to * QUADRIC + k]!;
    return quadricError(tmp, 0, px[to]!, py[to]!, pz[to]!);
  };

  // The body is mirror-symmetric (x to -x): a collapse is made on both sides at once, and a vertex on the mirror plane never collapses
  // onto one off it, so the cage's vertices are a mirror-symmetric set and a car's reflection is its mirror image to float error.
  const mirror = new Int32Array(nv).fill(-1);
  const placeOf = (v: number, x: number): string => `${group[reps[v]!]!}|${Math.round(x * 1e4) + 0},${Math.round(py[v]! * 1e4)},${Math.round(pz[v]! * 1e4)}`;
  const byPlace = new Map<string, number>();
  for (let v = 0; v < nv; v++) byPlace.set(placeOf(v, px[v]!), v);
  for (let v = 0; v < nv; v++) mirror[v] = byPlace.get(placeOf(v, -px[v]!)) ?? -1;

  /** Moves `from` onto `to`: its quadric, its triangles and its neighbours go to `to`. */
  const collapse = (from: number, to: number): void => {
    for (let k = 0; k < QUADRIC; k++) Q[to * QUADRIC + k] += Q[from * QUADRIC + k]!;
    for (const t of incident[from]!) {
      if (!alive[t]) continue;
      const a = tv[t * 3]!;
      const b = tv[t * 3 + 1]!;
      const c = tv[t * 3 + 2]!;
      if (a === to || b === to || c === to) {
        alive[t] = 0;
        continue;
      }
      for (let k = 0; k < 3; k++) if (tv[t * 3 + k] === from) tv[t * 3 + k] = to;
      incident[to]!.push(t);
    }
    for (const w of neighbours[from]!) {
      neighbours[w]!.delete(from);
      if (w !== to) {
        neighbours[w]!.add(to);
        neighbours[to]!.add(w);
      }
    }
    neighbours[from]!.clear();
    vertexAlive[from] = 0;
  };

  let remaining = nv;
  while (remaining > target) {
    let best = Infinity;
    let bestFrom = -1;
    let bestTo = -1;
    for (let u = 0; u < nv; u++) {
      if (!vertexAlive[u]) continue;
      const onPlane = mirror[u] === u;
      const twin = mirror[u]!;
      for (const v of neighbours[u]!) {
        if (onPlane && mirror[v] !== v) continue;
        if (twin >= 0 && !onPlane && (v === twin || mirror[v]! < 0 || !vertexAlive[twin] || !neighbours[twin]!.has(mirror[v]!))) continue;
        const c = cost(u, v);
        if (c < best) {
          best = c;
          bestFrom = u;
          bestTo = v;
        }
      }
    }
    if (bestFrom < 0) break;
    const twinFrom = mirror[bestFrom]!;
    const twinTo = mirror[bestTo]!;
    collapse(bestFrom, bestTo);
    remaining--;
    if (twinFrom >= 0 && twinFrom !== bestFrom && twinTo >= 0 && twinFrom !== twinTo && vertexAlive[twinFrom] && vertexAlive[twinTo] && neighbours[twinFrom]!.has(twinTo)) {
      collapse(twinFrom, twinTo);
      remaining--;
    }
  }

  const slot = new Int32Array(nv).fill(-1);
  const source: number[] = [];
  for (let v = 0; v < nv; v++) {
    if (!vertexAlive[v]) continue;
    slot[v] = source.length;
    source.push(reps[v]!);
  }
  const out: number[] = [];
  const outGroup: number[] = [];
  for (let t = 0; t < nt; t++) {
    if (!alive[t]) continue;
    const a = slot[tv[t * 3]!]!;
    const b = slot[tv[t * 3 + 1]!]!;
    const c = slot[tv[t * 3 + 2]!]!;
    if (a < 0 || b < 0 || c < 0 || a === b || b === c || a === c) continue;
    out.push(a, b, c);
    outGroup.push(group[reps[tv[t * 3]!]!]!);
  }
  return { source: Int32Array.from(source), tris: Uint16Array.from(out), triGroup: Uint8Array.from(outGroup) };
}

// ---- the skin over the cage's vertices -----------------------------------------------------------------------------

/**
 * The cage's vertices skinned from `live` into `out` (x, y, z each): `StreamedDeformation.skin`'s shape-mode loop over these
 * vertices (parents' particles plus the clusters' maps on the offset from their rest centroid; the travel cap, the roof
 * clamp, the imprint's cut, the wheel arch), in its order of operations, so a vertex lands where the drawn mesh puts it.
 * The accordion folds (sin/exp, visual) are not here: a fold is at most `extraCap` (0.11 m) of drawn paint, not a shape.
 */
function skinCage(style: CageStyle, live: CageLive, out: CageFields): void {
  const { rest, skinN, skinXf, skinW, resJ, resW, resC, skinHub, infN, infCo, infUvw, vertexGroup } = style;
  const X = live.X;
  const co = live.co;
  const pos = live.pos;
  const hubs = live.hubs;
  const cap = live.params[P_CAP]!;
  const roofClamp = live.params[P_ROOF_CLAMP]! !== 0;
  const cutY = live.params[P_CUT_Y]!;
  const cutX = live.params[P_CUT_X]!;
  const cutZ = live.params[P_CUT_Z]!;
  const follow = live.panelsFollow !== 0;
  const panelOrigin = style.panelOrigin;
  for (let i = 0, r = 0; i < style.vertexCount; i++, r += 3) {
    const rx = rest[r]!;
    const ry = rest[r + 1]!;
    const rz = rest[r + 2]!;
    let px = 0;
    let py = 0;
    let pz = 0;
    const dx = rx - resC[r]!;
    const dy = ry - resC[r + 1]!;
    const dz = rz - resC[r + 2]!;
    if (skinN[i]! > 0) {
      for (let k = i * SKIN_K, e = k + skinN[i]!; k < e; k++) {
        const o = skinXf[k]!;
        const w = skinW[k]!;
        px += (X[o]! * dx + X[o + 1]! * dy + X[o + 2]! * dz) * w;
        py += (X[o + 3]! * dx + X[o + 4]! * dy + X[o + 5]! * dz) * w;
        pz += (X[o + 6]! * dx + X[o + 7]! * dy + X[o + 8]! * dz) * w;
      }
      for (let k = i * RES_SLOTS, e = k + RES_SLOTS; k < e; k++) {
        const j = resJ[k]!;
        const w = resW[k]!;
        px += pos[j]! * w;
        py += pos[j + 1]! * w;
        pz += pos[j + 2]! * w;
      }
    } else {
      for (let k = i * INF_K, e = k + infN[i]!; k < e; k++) {
        const o = infCo[k]!;
        const u = infUvw[k * 4]!;
        const v = infUvw[k * 4 + 1]!;
        const w = infUvw[k * 4 + 2]!;
        const wt = infUvw[k * 4 + 3]!;
        px += cageAxis(co, o, u, v, w) * wt;
        py += cageAxis(co, o + 8, u, v, w) * wt;
        pz += cageAxis(co, o + 16, u, v, w) * wt;
      }
    }
    const g = vertexGroup[i]!;
    if (g > 0) {
      // A torn-off lid's mesh is gone and flies as a part of its own: its vertices stay where it sat at rest on the body (the cage's
      // points are the body's, never a part's pose). A shattered pane's vertices stay where the frame holds its opening.
      if (live.panelOn[g - 1] === 0 && style.panelGlass[g - 1] === 0) {
        out.pos[r] = rx;
        out.pos[r + 1] = ry;
        out.pos[r + 2] = rz;
        out.rawY[i] = ry;
        continue;
      }
      // A panel's skin (`skinPanel`) is its lattice alone, and runs only for a crashed car (the cap, the clamp and the cut are the
      // body's); the mesh then stands where its own pose puts it (a bonnet's hinge): that pose about the panel's origin.
      const o = (g - 1) * 7;
      const pose = live.panelPose;
      const pivot = (g - 1) * 3;
      const lx = (follow ? px : rx) - panelOrigin[pivot]!;
      const ly = (follow ? py : ry) - panelOrigin[pivot + 1]!;
      const lz = (follow ? pz : rz) - panelOrigin[pivot + 2]!;
      const qx = pose[o + 3]!;
      const qy = pose[o + 4]!;
      const qz = pose[o + 5]!;
      const qw = pose[o + 6]!;
      const cx = qy * lz - qz * ly;
      const cy = qz * lx - qx * lz;
      const cz = qx * ly - qy * lx;
      out.pos[r] = pose[o]! + lx + 2 * (qw * cx + qy * cz - qz * cy);
      out.pos[r + 1] = pose[o + 1]! + ly + 2 * (qw * cy + qz * cx - qx * cz);
      out.pos[r + 2] = pose[o + 2]! + lz + 2 * (qw * cz + qx * cy - qy * cx);
      out.rawY[i] = out.pos[r + 1]!;
      continue;
    }
    const tx = px - rx;
    const ty = py - ry;
    const tz = pz - rz;
    const travel2 = tx * tx + ty * ty + tz * tz;
    if (travel2 > cap * cap) {
      const t = cap / Math.sqrt(travel2);
      px = rx + tx * t;
      py = ry + ty * t;
      pz = rz + tz * t;
    }
    if (roofClamp && ry > ROOF_CLAMP_Y) py = Math.min(Math.max(py, ry - ROOF_DOWN), ry + ROOF_UP);
    const rawHeight = py;
    const cut = cutY + cutX * px + cutZ * pz;
    if (py > cut) py = cut;
    const h = skinHub[i]!;
    if (h >= 0) {
      const o = h * HUB_STRIDE;
      const popped = hubs[o]! !== 0;
      const keep = popped ? ARCH_OFF : ARCH_ON;
      const hx = popped ? rx + hubs[o + 1]! - hubs[o + 2]! : rx;
      const hz = popped ? rz + hubs[o + 3]! - hubs[o + 4]! : rz;
      px = px * (1 - keep) + hx * keep;
      pz = pz * (1 - keep) + hz * keep;
    }
    out.pos[r] = px;
    out.pos[r + 1] = py;
    out.pos[r + 2] = pz;
    out.rawY[i] = rawHeight;
  }
  placeInterior(style, pos, out);
}

const _pose = new Float64Array(4);

/** The interior's vertices placed into `out` by the masses `massPos` (`interiorPose`: where the drawn interior stands). Not cut by the roof imprint, never a lid. */
function placeInterior(style: CageStyle, massPos: ArrayLike<number>, out: CageFields): void {
  const { interiorMass, interiorRest, interiorCount, vertexCount } = style;
  interiorPose(massPos[interiorMass[0]!]!, massPos[interiorMass[1]!]!, massPos[interiorMass[2]! + 1]!, massPos[interiorMass[2]! + 2]!, _pose);
  for (let i = 0, r = vertexCount * 3; i < interiorCount; i++, r += 3) {
    out.pos[r] = interiorRest[i * 3]! * _pose[0]! + _pose[1]!;
    out.pos[r + 1] = interiorRest[i * 3 + 1]! + _pose[2]!;
    out.pos[r + 2] = interiorRest[i * 3 + 2]! + _pose[3]!;
    out.rawY[vertexCount + i] = out.pos[r + 1]!;
  }
}

// ---- the fields ----------------------------------------------------------------------------------------------------

/** Empty fields over `style`'s lattice. */
function allocateFields(vertexCount: number, nu: number, nv: number, panelCount: number): CageFields {
  return {
    pos: new Float64Array(vertexCount * 3),
    rawY: new Float64Array(vertexCount),
    top: new Float32Array(nu * nv),
    bottom: new Float32Array(nu * nv),
    covered: new Uint8Array(nu * nv),
    plan: new Float32Array(nu * nv),
    planFresh: false,
    planBox: new Float64Array(4),
    heightMax: 0,
    panelOn: new Uint8Array(panelCount),
  };
}

/**
 * The plan boxes (x min, x max, z min, z max) of the glass panes that are gone, into `_open`: how many. A shattered pane's mesh is
 * not drawn, but its vertices are skinned where the frame holds it (`skinCage`), so the box is its opening as the crushed body has it.
 */
function gonePanes(style: CageStyle, f: CageFields, panelOn: Uint8Array): number {
  const { panelCount, panelGlass, vertexCount, vertexGroup } = style;
  let n = 0;
  for (let k = 0; k < panelCount && n < OPEN_MAX; k++) {
    if (panelOn[k] !== 0 || panelGlass[k] === 0) continue;
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (let i = 0; i < vertexCount; i++) {
      if (vertexGroup[i] !== k + 1) continue;
      x0 = Math.min(x0, f.pos[i * 3]!);
      x1 = Math.max(x1, f.pos[i * 3]!);
      z0 = Math.min(z0, f.pos[i * 3 + 2]!);
      z1 = Math.max(z1, f.pos[i * 3 + 2]!);
    }
    _open[n * 4] = x0;
    _open[n * 4 + 1] = x1;
    _open[n * 4 + 2] = z0;
    _open[n * 4 + 3] = z1;
    n++;
  }
  return n;
}

/** Whether plan point (`x`, `z`) lies within `margin` of one of the first `n` openings of `gonePanes`. */
function inOpening(n: number, x: number, z: number, margin: number): boolean {
  for (let o = 0; o < n * 4; o += 4) if (x >= _open[o]! - margin && x <= _open[o + 1]! + margin && z >= _open[o + 2]! - margin && z <= _open[o + 3]! + margin) return true;
  return false;
}

/** The most gone glass panes a cage reads openings for (a car has a windscreen and a rear screen). */
const OPEN_MAX = 4;
const _open = new Float64Array(OPEN_MAX * 4);

/**
 * The top, bottom and coverage fields from `f.pos` and `f.rawY`: every triangle lays its plane's height over the nodes within
 * `EXPAND` steps of it (clamped to the triangle's own heights, so a steep one never throws a node far off), the field taking the
 * highest and the lowest; a node strictly inside a triangle is covered. A triangle with no plan area (a wall seen edge on) is a
 * line the neighbours already cover. The roof imprint's plane (`cutY + cutX x + cutZ z`) cuts the body's heights here, per node,
 * as it cuts every vertex of the drawn mesh: a coarse cage's clipped vertex is not where the drawn mesh's clipped edge runs.
 * A gone pane's opening shows the interior: its triangles lay heights over the opening's plan box only (everywhere else it is
 * inside the body, and a roof the load crushes below it is the load law's to stop, not a prop's).
 */
function rasterise(style: CageStyle, f: CageFields, panelOn: Uint8Array, cutY: number, cutX: number, cutZ: number): void {
  const { nu, nv, step, u0, v0, tris, triGroup } = style;
  const pos = f.pos;
  const rawY = f.rawY;
  const top = f.top;
  const bottom = f.bottom;
  const covered = f.covered;
  top.fill(NaN);
  bottom.fill(NaN);
  covered.fill(0);
  const margin = EXPAND * step;
  const interiorGroup = style.panelCount + 1;
  const opens = gonePanes(style, f, panelOn);
  let heightMax = 0;
  let xMin = Infinity;
  let xMax = -Infinity;
  let zMin = Infinity;
  let zMax = -Infinity;
  for (let t = 0; t < style.triCount * 3; t += 3) {
    const group = triGroup[t / 3]!;
    if (group === interiorGroup ? opens === 0 : group > 0 && panelOn[group - 1] === 0) continue;
    const a = tris[t]! * 3;
    const b = tris[t + 1]! * 3;
    const c = tris[t + 2]! * 3;
    const ax = pos[a]!;
    const ay = rawY[a / 3]!;
    const az = pos[a + 2]!;
    const bx = pos[b]!;
    const by = rawY[b / 3]!;
    const bz = pos[b + 2]!;
    const cx = pos[c]!;
    const cy = rawY[c / 3]!;
    const cz = pos[c + 2]!;
    const area2 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
    if (Math.abs(area2) < 1e-9) continue;
    const sign = area2 > 0 ? 1 : -1;
    const lenAB = Math.sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az));
    const lenBC = Math.sqrt((cx - bx) * (cx - bx) + (cz - bz) * (cz - bz));
    const lenCA = Math.sqrt((ax - cx) * (ax - cx) + (az - cz) * (az - cz));
    if (lenAB < 1e-9 || lenBC < 1e-9 || lenCA < 1e-9) continue;
    const yLow = Math.min(ay, by, cy);
    const yHigh = Math.max(ay, by, cy);
    xMin = Math.min(xMin, ax, bx, cx);
    xMax = Math.max(xMax, ax, bx, cx);
    zMin = Math.min(zMin, az, bz, cz);
    zMax = Math.max(zMax, az, bz, cz);
    const xLow = Math.min(ax, bx, cx) - margin;
    const xHigh = Math.max(ax, bx, cx) + margin;
    const zLow = Math.min(az, bz, cz) - margin;
    const zHigh = Math.max(az, bz, cz) + margin;
    const i0 = Math.max(0, Math.ceil((xLow - u0) / step));
    const i1 = Math.min(nu - 1, Math.floor((xHigh - u0) / step));
    const j0 = Math.max(0, Math.ceil((zLow - v0) / step));
    const j1 = Math.min(nv - 1, Math.floor((zHigh - v0) / step));
    // Each edge's signed distance (inside +) is linear in the node: e = nx x + nz z + k, and the barycentric weight of the corner
    // opposite an edge is that distance times the edge's length over the triangle's doubled area.
    const nxAB = (-(bz - az) * sign) / lenAB;
    const nzAB = ((bx - ax) * sign) / lenAB;
    const kAB = -(nxAB * ax + nzAB * az);
    const nxBC = (-(cz - bz) * sign) / lenBC;
    const nzBC = ((cx - bx) * sign) / lenBC;
    const kBC = -(nxBC * bx + nzBC * bz);
    const nxCA = (-(az - cz) * sign) / lenCA;
    const nzCA = ((ax - cx) * sign) / lenCA;
    const kCA = -(nxCA * cx + nzCA * cz);
    const scale = 1 / Math.abs(area2);
    const wA = lenBC * scale;
    const wB = lenCA * scale;
    const wC = lenAB * scale;
    for (let j = j0; j <= j1; j++) {
      const z = v0 + j * step;
      const rowAB = nzAB * z + kAB;
      const rowBC = nzBC * z + kBC;
      const rowCA = nzCA * z + kCA;
      for (let i = i0; i <= i1; i++) {
        const x = u0 + i * step;
        const eAB = nxAB * x + rowAB;
        const eBC = nxBC * x + rowBC;
        const eCA = nxCA * x + rowCA;
        if (eAB < -margin || eBC < -margin || eCA < -margin) continue;
        if (group === interiorGroup && !inOpening(opens, x, z, margin)) continue;
        let y = eBC * wA * ay + eCA * wB * by + eAB * wC * cy;
        if (y < yLow) y = yLow;
        else if (y > yHigh) y = yHigh;
        if (group === 0) y = Math.min(y, cutY + cutX * x + cutZ * z);
        const k = j * nu + i;
        if (!(top[k]! >= y)) top[k] = y;
        if (!(bottom[k]! <= y)) bottom[k] = y;
        if (eAB >= 0 && eBC >= 0 && eCA >= 0) covered[k] = 1;
      }
    }
    heightMax = Math.max(heightMax, Math.abs(yLow), Math.abs(yHigh));
  }
  f.heightMax = heightMax;
  f.planFresh = false;
  f.planBox[0] = xMin;
  f.planBox[1] = xMax;
  f.planBox[2] = zMin;
  f.planBox[3] = zMax;
}

/** Stand-in squared distance of a node with none to measure from (no covered node, or none uncovered). */
const FAR2 = 1e12;
const scratch = { n: 0, f: new Float64Array(0), d: new Float64Array(0), v: new Int32Array(0), z: new Float64Array(0), a: new Float64Array(0), b: new Float64Array(0) };

/** One line of the exact squared-distance transform (Felzenszwalb and Huttenlocher 2012): `d` ← min over q of (p - q)² + f[q]. */
function transformLine(n: number, f: Float64Array, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -FAR2;
  z[1] = FAR2;
  for (let q = 1; q < n; q++) {
    let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) {
      k--;
      s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = FAR2;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const dq = q - v[k]!;
    d[q] = dq * dq + f[v[k]!]!;
  }
}

/** `g` (nu × nv, squared distances in steps, zero at the seeds, `FAR2` elsewhere) transformed in place. */
function transformGrid(nu: number, nv: number, g: Float64Array, s: typeof scratch): void {
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) s.f[j] = g[j * nu + i]!;
    transformLine(nv, s.f, s.d, s.v, s.z);
    for (let j = 0; j < nv; j++) g[j * nu + i] = s.d[j]!;
  }
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) s.f[i] = g[j * nu + i]!;
    transformLine(nu, s.f, s.d, s.v, s.z);
    for (let i = 0; i < nu; i++) g[j * nu + i] = s.d[i]!;
  }
}

/**
 * The plan field of `f` (signed distance to the outline, negative inside, 5 mm of the outline lying between a covered node and its
 * uncovered neighbour), made current if a fit left it stale. The fits skip it (a car near no other car never asks); a style's
 * pristine fields compute it once for all its cars.
 */
function planFieldOf(style: CageStyle, f: CageFields): Float32Array {
  if (f.planFresh) return f.plan;
  const { nu, nv, step } = style;
  const n = nu * nv;
  if (scratch.n < n) {
    const line = Math.max(nu, nv);
    scratch.n = n;
    scratch.f = new Float64Array(line);
    scratch.d = new Float64Array(line);
    scratch.v = new Int32Array(line);
    scratch.z = new Float64Array(line + 1);
    scratch.a = new Float64Array(n);
    scratch.b = new Float64Array(n);
  }
  const toCovered = scratch.a;
  const toUncovered = scratch.b;
  for (let k = 0; k < n; k++) {
    const inside = f.covered[k]! === 1;
    toCovered[k] = inside ? 0 : FAR2;
    toUncovered[k] = inside ? FAR2 : 0;
  }
  transformGrid(nu, nv, toCovered, scratch);
  transformGrid(nu, nv, toUncovered, scratch);
  for (let k = 0; k < n; k++) {
    f.plan[k] = f.covered[k]! === 1 ? -(Math.sqrt(toUncovered[k]!) - 0.5) * step : (Math.sqrt(toCovered[k]!) - 0.5) * step;
  }
  f.planFresh = true;
  return f.plan;
}

// ---- the car's cage ------------------------------------------------------------------------------------------------

/** `into` ← `live`'s inputs in `last`'s layout, each as the float32 it rounds to: a fit reads exactly these (`unpackInputs`), so a keyframe holds them in half the bytes and restores the same fit. */
function packInputs(live: CageLive, into: Float64Array): void {
  let o = 0;
  for (let k = 0; k < live.pos.length; k++) into[o++] = Math.fround(live.pos[k]!);
  for (let k = 0; k < live.X.length; k++) into[o++] = Math.fround(live.X[k]!);
  for (let k = 0; k < live.hubs.length; k++) into[o++] = Math.fround(live.hubs[k]!);
  for (let k = 0; k < live.co.length; k++) into[o++] = Math.fround(live.co[k]!);
  for (let k = 0; k < live.panelOn.length; k++) into[o++] = live.panelOn[k]!;
  for (let k = 0; k < live.panelPose.length; k++) into[o++] = Math.fround(live.panelPose[k]!);
  into[o++] = live.panelsFollow;
  into[o++] = Math.fround(live.params[P_CAP]!);
  into[o++] = Math.fround(live.params[P_ROOF_CLAMP]!);
  into[o++] = Math.fround(live.params[P_CUT_Y]!);
  into[o++] = Math.fround(live.params[P_CUT_X]!);
  into[o] = Math.fround(live.params[P_CUT_Z]!);
}

/** Empty inputs of a car of `style` (`unpackInputs` fills them). */
function allocateLive(style: CageStyle): CageLive {
  const n = style.massCount;
  const p = style.panelCount;
  return {
    X: new Float64Array(style.clusterCount * 9),
    pos: new Float64Array(n * 3),
    hubs: new Float64Array(n * HUB_STRIDE),
    params: new Float64Array(P_CUT_Z + 1),
    co: new Float64Array(style.restInputs.length - (n * 3 + style.clusterCount * 9 + n * HUB_STRIDE + p * 8 + 6)),
    panelOn: new Uint8Array(p),
    panelsFollow: 0,
    panelPose: new Float64Array(p * 7),
  };
}

/** `out` ← the inputs `packInputs` laid out in `inputs`. */
function unpackInputs(inputs: Float64Array, out: CageLive): void {
  let o = 0;
  for (let k = 0; k < out.pos.length; k++) out.pos[k] = inputs[o++]!;
  for (let k = 0; k < out.X.length; k++) out.X[k] = inputs[o++]!;
  for (let k = 0; k < out.hubs.length; k++) out.hubs[k] = inputs[o++]!;
  for (let k = 0; k < out.co.length; k++) out.co[k] = inputs[o++]!;
  for (let k = 0; k < out.panelOn.length; k++) out.panelOn[k] = inputs[o++]!;
  for (let k = 0; k < out.panelPose.length; k++) out.panelPose[k] = inputs[o++]!;
  out.panelsFollow = inputs[o++]!;
  out.params[P_CAP] = inputs[o++]!;
  out.params[P_ROOF_CLAMP] = inputs[o++]!;
  out.params[P_CUT_Y] = inputs[o++]!;
  out.params[P_CUT_X] = inputs[o++]!;
  out.params[P_CUT_Z] = inputs[o]!;
}

/**
 * How far (m) a mass or hub may be from where the last raster saw it before the cage is re-skinned and re-rasterised: a fifth of the
 * 5 cm fit bar (`CAGE_STEP`'s), so the cage never stands more than 1 cm off what the last raster read, well inside the bar.
 */
const REFIT_EPSILON = CAGE_STEP / 5;

/**
 * Whether `now` differs from `last` (same layout) enough to refit: a mass or a hub more than `REFIT_EPSILON` away, or any panel flag,
 * panel pose, roof clamp or imprint cut at all. The cluster maps and cage coefficients are fitted from the masses, so they move
 * only when a mass does and are not read here.
 */
function movedSince(style: CageStyle, last: Float64Array, now: Float64Array): boolean {
  const massEnd = style.massCount * 3;
  const hubStart = massEnd + style.clusterCount * 9;
  const hubEnd = hubStart + style.massCount * HUB_STRIDE;
  const tailStart = last.length - (style.panelCount * 8 + 6);
  for (let k = 0; k < massEnd; k++) if (Math.abs(now[k]! - last[k]!) > REFIT_EPSILON) return true;
  for (let k = hubStart; k < hubEnd; k++) if (Math.abs(now[k]! - last[k]!) > REFIT_EPSILON) return true;
  for (let k = tailStart; k < last.length; k++) if (now[k] !== last[k]) return true;
  return false;
}

/** A car's cage: the style it shares, the fields it stands on now, and what it was last fitted from. */
export class CarCage {
  readonly style: CageStyle;
  /** The fields as of the last fit: the style's shared ones while the car is pristine, else the car's own. */
  fields: CageFields;
  /** Counts every fit that changed `fields` (or switched which it is): a consumer pointing at `fields.top` re-points when it moves. */
  serial = 0;
  private own: CageFields | null = null;
  private fitted = false;
  /** How many fits changed the fields (the cost row: a refit is about 160-190 µs at 5 cm). */
  refits = 0;

  /** The car is whole again (a reset, or its skin never baked): back on the style's shared fields, the next `refit` fits afresh. True when that changed `fields`. */
  reset(): boolean {
    this.fitted = false;
    const changed = this.fields !== this.style.pristine;
    if (changed) this.serial++;
    this.fields = this.style.pristine;
    return changed;
  }
  private readonly last: Float64Array;
  private readonly now: Float64Array;
  /** `last` unpacked, for the fit to read (allocated at the first fit of a car off its rest shape). */
  private read: CageLive | null = null;

  constructor(style: CageStyle) {
    this.style = style;
    this.fields = style.pristine;
    this.last = new Float64Array(style.restInputs.length);
    this.now = new Float64Array(style.restInputs.length);
  }

  /** Whether the cage is its style's pristine one (every car of the style standing on the same fields). */
  get pristine(): boolean {
    return this.fields === this.style.pristine;
  }

  /** A car's cage for `key` (its body style: cars of one style share a build) on a lattice of `step`-metre nodes; `source` is read only on the style's first use. */
  static shared(key: object, source: () => CageSource, step: number = CAGE_STEP): CarCage {
    return cageFor(key, source, step);
  }

  /** The plan distance field of the fields as of the last fit (see `planFieldOf`): made current on the first ask after a fit. */
  planField(): Float32Array {
    return planFieldOf(this.style, this.fields);
  }

  /**
   * Fits the cage to `live`: a no-op (false) while every mass and hub is within `REFIT_EPSILON` of where the last fit saw it (and no
   * panel or imprint input changed), else the cage's vertices re-skinned and its fields re-rasterised (true, `serial` and `refits` up).
   * A car back at rest goes back to its style's shared fields. Allocates once, the first time a car leaves rest (its own fields); never again.
   */
  refit(live: CageLive): boolean {
    packInputs(live, this.now);
    if (this.fitted && !movedSince(this.style, this.last, this.now)) return false;
    this.last.set(this.now);
    this.fit(this.last);
    return true;
  }

  /** `fields` ← the cage fitted to `inputs` (a `packInputs` layout: what the last fit read, whole): the style's shared ones for a pristine car, else the car's own, re-skinned and re-rasterised. */
  private fit(inputs: Float64Array): void {
    const style = this.style;
    this.fitted = true;
    this.refits++;
    if (isPristine(style, inputs)) {
      this.fields = style.pristine;
    } else {
      const live = (this.read ??= allocateLive(style));
      unpackInputs(inputs, live);
      const own = (this.own ??= allocateFields(style.vertexCount + style.interiorCount, style.nu, style.nv, style.panelCount));
      skinCage(style, live, own);
      own.panelOn.set(live.panelOn);
      rasterise(style, own, live.panelOn, live.params[P_CUT_Y]!, live.params[P_CUT_X]!, live.params[P_CUT_Z]!);
      this.fields = own;
    }
    this.serial++;
  }

  /**
   * The refit history a keyframe carries (the cage is a function of the sim's bakes, but a bake within `REFIT_EPSILON` of the last fit is
   * not fitted, so what it stands on depends on that fit): 1 if the cage was fitted, then the inputs of its last fit as float32 (they are
   * single-precision already: `packInputs`), two to a number, `stateSize()` numbers.
   */
  stateSize(): number {
    return 1 + Math.ceil(this.last.length / 2);
  }

  writeState(buf: Float64Array): void {
    buf[0] = this.fitted ? 1 : 0;
    const into = new Float32Array(buf.buffer, buf.byteOffset + 8, 2 * (this.stateSize() - 1));
    into.set(this.last);
    into.fill(0, this.last.length);
  }

  /** The cage as `writeState` left it: refitted from the recorded inputs (so its fields are the recorded ones, bit for bit), or back on the style's shared fields if it was never fitted. Allocates once (a restore is cold). */
  readState(buf: Float64Array): void {
    if (buf[0] === 0) {
      this.reset();
      return;
    }
    this.last.set(new Float32Array(buf.buffer, buf.byteOffset + 8, this.last.length));
    this.fit(this.last);
  }
}

/** Whether `inputs` (`packInputs`' layout) are a pristine car's: every particle and map at rest, the wheels on, no roof imprint. */
function isPristine(style: CageStyle, inputs: Float64Array): boolean {
  const rest = style.restInputs;
  const n = rest.length - 5;
  for (let k = 0; k < n; k++) if (Math.abs(inputs[k]! - rest[k]!) > REST_TOLERANCE) return false;
  return inputs[n + 2] === IMPRINT_NONE && inputs[n + 3] === 0 && inputs[n + 4] === 0;
}

/**
 * How far (m, or per metre for the cluster maps and cage coefficients) an input may be from rest and still be the pristine car:
 * a car at rest sits a fraction of a millimetre off its rest particles (the maps are least-squares fits to them).
 */
const REST_TOLERANCE = 2e-3;


// ---- building a style's cage -----------------------------------------------------------------------------------------

const STYLES = new WeakMap<object, Map<number, CageStyle>>();

/** `CarCage.shared`. */
function cageFor(key: object, source: () => CageSource, step: number): CarCage {
  let byStep = STYLES.get(key);
  if (!byStep) STYLES.set(key, (byStep = new Map()));
  let style = byStep.get(step);
  if (!style) byStep.set(step, (style = buildStyle(source(), step)));
  return new CarCage(style);
}

/**
 * The triangles of a mesh that face up (the outward winding's normal has a positive y) and the vertices they use: the cage's top
 * field reads nothing else of the interior (a box's underside and sides lie under or beside its top), and every triangle kept costs
 * a raster at each refit.
 */
function upFacing(rest: Float32Array, index: ArrayLike<number>): { rest: Float32Array; index: Uint32Array } {
  const slot = new Int32Array(rest.length / 3).fill(-1);
  const kept: number[] = [];
  const out: number[] = [];
  for (let t = 0; t + 2 < index.length; t += 3) {
    const a = index[t]! * 3;
    const b = index[t + 1]! * 3;
    const c = index[t + 2]! * 3;
    // y of (b - a) x (c - a): (bz - az)(cx - ax) - (bx - ax)(cz - az).
    if ((rest[b + 2]! - rest[a + 2]!) * (rest[c]! - rest[a]!) - (rest[b]! - rest[a]!) * (rest[c + 2]! - rest[a + 2]!) <= 0) continue;
    for (let k = 0; k < 3; k++) {
      const v = index[t + k]!;
      if (slot[v]! < 0) {
        slot[v] = kept.length / 3;
        kept.push(rest[v * 3]!, rest[v * 3 + 1]!, rest[v * 3 + 2]!);
      }
      out.push(slot[v]!);
    }
  }
  return { rest: Float32Array.from(kept), index: Uint32Array.from(out) };
}

function buildStyle(src: CageSource, step: number): CageStyle {
  const body = decimate(src.rest, src.index, src.group, CAGE_VERTICES);
  const top = upFacing(src.interiorRest, src.interiorIndex);
  const inner = decimate(top.rest, top.index, new Uint8Array(top.rest.length / 3), INTERIOR_VERTICES);
  const { source } = body;
  const n = source.length;
  const ni = inner.source.length;
  const bodyTris = body.tris.length / 3;
  const tris = new Uint16Array(body.tris.length + inner.tris.length);
  tris.set(body.tris);
  for (let k = 0; k < inner.tris.length; k++) tris[body.tris.length + k] = inner.tris[k]! + n;
  const interiorRest = new Float32Array(ni * 3);
  for (let i = 0; i < ni; i++) for (let k = 0; k < 3; k++) interiorRest[i * 3 + k] = top.rest[inner.source[i]! * 3 + k]!;
  const rest = new Float64Array(n * 3);
  const skinN = new Uint8Array(n);
  const skinXf = new Int32Array(n * SKIN_K);
  const skinW = new Float64Array(n * SKIN_K);
  const resJ = new Int32Array(n * RES_SLOTS);
  const resW = new Float64Array(n * RES_SLOTS);
  const resC = new Float64Array(n * 3);
  const skinHub = new Int32Array(n);
  const infN = new Uint8Array(n);
  const infCo = new Int32Array(n * INF_K);
  const infUvw = new Float64Array(n * INF_K * 4);
  for (let i = 0; i < n; i++) {
    const v = source[i]!;
    for (let k = 0; k < 3; k++) {
      rest[i * 3 + k] = src.rest[v * 3 + k]!;
      resC[i * 3 + k] = src.resC[v * 3 + k]!;
    }
    skinN[i] = src.skinN[v]!;
    skinHub[i] = src.skinHub[v]!;
    for (let k = 0; k < SKIN_K; k++) {
      skinXf[i * SKIN_K + k] = src.skinXf[v * SKIN_K + k]!;
      skinW[i * SKIN_K + k] = src.skinW[v * SKIN_K + k]!;
    }
    for (let k = 0; k < RES_SLOTS; k++) {
      resJ[i * RES_SLOTS + k] = src.resJ[v * RES_SLOTS + k]!;
      resW[i * RES_SLOTS + k] = src.resW[v * RES_SLOTS + k]!;
    }
    infN[i] = src.infN[v]!;
    for (let k = 0; k < INF_K; k++) {
      infCo[i * INF_K + k] = src.infCo[v * INF_K + k]!;
      for (let c = 0; c < 4; c++) infUvw[(i * INF_K + k) * 4 + c] = src.infUvw[(v * INF_K + k) * 4 + c]!;
    }
  }
  const nu = 2 * Math.round(HALF_X / step) + 1;
  const nv = 2 * Math.round(HALF_Z / step) + 1;
  const massCount = src.massRest.length / 3;
  const restInputs = new Float64Array(massCount * 3 + src.clusterCount * 9 + massCount * HUB_STRIDE + src.restCo.length + src.panelCount * 8 + 1 + 5);
  let o = 0;
  for (let k = 0; k < src.massRest.length; k++) restInputs[o++] = src.massRest[k]!;
  for (let c = 0; c < src.clusterCount; c++) {
    restInputs[o] = 1;
    restInputs[o + 4] = 1;
    restInputs[o + 8] = 1;
    o += 9;
  }
  for (let j = 0; j < massCount; j++) {
    restInputs[o++] = 0;
    restInputs[o++] = src.massRest[j * 3]!;
    restInputs[o++] = src.massRest[j * 3]!;
    restInputs[o++] = src.massRest[j * 3 + 2]!;
    restInputs[o++] = src.massRest[j * 3 + 2]!;
  }
  for (let k = 0; k < src.restCo.length; k++) restInputs[o++] = src.restCo[k]!;
  restInputs.fill(1, o, o + src.panelCount);
  o += src.panelCount;
  for (let k = 0; k < src.panelCount; k++) {
    restInputs[o] = src.panelOrigin[k * 3]!;
    restInputs[o + 1] = src.panelOrigin[k * 3 + 1]!;
    restInputs[o + 2] = src.panelOrigin[k * 3 + 2]!;
    restInputs[o + 6] = 1;
    o += 7;
  }
  o += 1;
  restInputs[o + 2] = IMPRINT_NONE;
  const style: CageStyle = {
    step,
    nu,
    nv,
    u0: -HALF_X,
    v0: -HALF_Z,
    vertexCount: n,
    triCount: tris.length / 3,
    source,
    tris,
    rest,
    skinN,
    skinXf,
    skinW,
    resJ,
    resW,
    resC,
    skinHub,
    infN,
    infCo,
    infUvw,
    restInputs,
    massCount,
    clusterCount: src.clusterCount,
    pristine: allocateFields(n + ni, nu, nv, src.panelCount),
    triGroup: Uint8Array.from({ length: tris.length / 3 }, (_, t) => (t < bodyTris ? body.triGroup[t]! : src.panelCount + 1)),
    vertexGroup: Uint8Array.from(source, (v) => src.group[v]!),
    panelCount: src.panelCount,
    interiorCount: ni,
    interiorRest,
    interiorMass: src.interiorMass,
    panelsOn: new Uint8Array(src.panelCount).fill(1),
    panelGlass: src.panelGlass,
    panelOrigin: src.panelOrigin,
  };
  style.pristine.pos.set(rest);
  style.pristine.panelOn.fill(1);
  for (let i = 0; i < n; i++) style.pristine.rawY[i] = rest[i * 3 + 1]!;
  placeInterior(style, src.massRest, style.pristine);
  rasterise(style, style.pristine, style.panelsOn, IMPRINT_NONE, 0, 0);
  return style;
}
