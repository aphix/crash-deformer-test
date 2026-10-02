import * as THREE from "three";
import { PREFABS, SURFACE_IDS, SURFACES, type PrefabId } from "./catalog.ts";
import type { Placed } from "./placements.ts";
import { box, painted, plainMaterial, prefabParts, type Piece } from "./prefabs.ts";
import { blankPoint, type Track, type TrackGround, type TrackPath } from "./track.ts";

/**
 * The visible course: terrain (with a far skirt), road ribbons with markings and kerbs, walls,
 * the start gantry and every placed prop, in a couple of dozen draw calls. Heights come from
 * `track.ground()`, so hills and banking follow the physics ground.
 */

const TERRAIN_CELL = 2;
const SKIRT_RADIUS = 900;
/** Lifts over the ground (m); the terrain is also pushed back with a polygon offset. */
const ROAD_LIFT = 0.015;
const SHORTCUT_LIFT = 0.03;
const MARK_LIFT = 0.04;
const KERB_LIFT = 0.06;
/** Kerbs go on the inside of turns tighter than 60 m. */
const KERB_CURV = 1 / 60;
/** A kerb sample takes the strongest curvature within this many samples (≈ m), so spline ripple never gaps a kerb. */
const KERB_FILL = 6;
const KERB_WIDTH = 1.1;
/** Start / finish chequer depth (m), centred on s = 0; lines stop short of it. */
const CHEQUER = 2;
const GANTRY_BEAM = 6.6;
const GRAVITY = 9.81;

const WHITE = 0xe8e6e0;
const RED = 0xc8261c;
const BLACK = 0x15161a;
const CONCRETE = 0xc4bfb3;
const CONCRETE_DARK = 0x9e998e;

/** Wall cross-section (u outward from the wall line, v up), as fractions of the wall height for v > 0. */
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

/** Lit start-light colours (linear RGB): red, yellow, green; unlit discs show them × LIGHT_OFF. */
const LIGHT_RGB: readonly (readonly [number, number, number])[] = [
  [1, 0.06, 0.03],
  [1, 0.72, 0.04],
  [0.12, 1, 0.25],
];
const LIGHT_OFF = 0.1;

/** Growing vertex-coloured triangle list. */
class Mesher {
  readonly pos: number[] = [];
  readonly col: number[] = [];
  readonly idx: number[] = [];
  private readonly c = new THREE.Color();

  v(x: number, y: number, z: number, hex: number, shade = 1): number {
    this.c.setHex(hex);
    this.pos.push(x, y, z);
    this.col.push(this.c.r * shade, this.c.g * shade, this.c.b * shade);
    return this.pos.length / 3 - 1;
  }

  /** Quad a→b at one section, c→d at the next; faces up when b is left of a and c is ahead of a. */
  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, c, b, b, c, d);
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

/** Deterministic 0..1 value per lattice point, for colour mottling. */
function hash2(x: number, z: number): number {
  return Math.abs(Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1;
}

function surfaceHex(index: number): number {
  return SURFACES[SURFACE_IDS[index]!].color;
}

function buildTerrain(track: Track, ground: TrackGround): THREE.BufferGeometry {
  const m = new Mesher();
  const far = Math.max(60, ...track.json.scatter.map((s) => s.far));
  const margin = Math.max(80, far + 40);
  const b = track.bounds;
  const x0 = Math.floor((b.minX - margin) / TERRAIN_CELL) * TERRAIN_CELL;
  const z0 = Math.floor((b.minZ - margin) / TERRAIN_CELL) * TERRAIN_CELL;
  const nx = Math.ceil((b.maxX + margin - x0) / TERRAIN_CELL) + 1;
  const nz = Math.ceil((b.maxZ + margin - z0) / TERRAIN_CELL) + 1;
  const terrain = SURFACE_IDS.indexOf(track.json.environment.terrain);
  const surf = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) surf[j * nx + i] = ground.surfaceIndex(x0 + i * TERRAIN_CELL, z0 + j * TERRAIN_CELL);
  }
  const bare = (c: number) => surf[c] === terrain;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * TERRAIN_CELL;
      const z = z0 + j * TERRAIN_CELL;
      const c = j * nx + i;
      // Road / runoff patches shrink by one cell, so 2 m triangles never smear their colour past
      // the ribbons that cover them; uncovered patches (open shortcut ends) still show.
      const s = bare(c - 1) || bare(c + 1) || bare(c - nx) || bare(c + nx) ? terrain : surf[c]!;
      let y = ground.heightAt(x, z);
      if (!bare(c)) {
        // Under a ribbon: the lowest ground within half a cell, so 2 m triangles never bridge a
        // crease (a banked road's edge) above the ribbon.
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) y = Math.min(y, ground.heightAt(x + dx * TERRAIN_CELL * 0.5, z + dz * TERRAIN_CELL * 0.5));
        }
      }
      m.v(x, y, z, surfaceHex(s), 0.92 + 0.12 * hash2(x, z));
    }
  }
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      // Rows run +z (ahead), columns +x: +x is left of +z (z × x = y), so a+1 is the left vertex.
      m.quad(a, a + 1, a + nx, a + 1 + nx);
    }
  }
  // Far skirt: an annulus under the grid's edge out to the horizon, just below the base terrain.
  const cx = x0 + ((nx - 1) * TERRAIN_CELL) / 2;
  const cz = z0 + ((nz - 1) * TERRAIN_CELL) / 2;
  const inner = (Math.min(nx, nz) - 1) * TERRAIN_CELL * 0.5;
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
      m.v(x, ground.base(x, z) - 0.25, z, hex, 0.92 + 0.12 * hash2(x, z));
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < seg; s++) {
      const a = first + r * seg + s;
      const n = first + r * seg + ((s + 1) % seg);
      // Outward is ahead; the next angle (+z turning to +x) lies to its left.
      m.quad(a, n, a + seg, n + seg);
    }
  }
  return m.geometry();
}

/** Road (+ runoff strips) ribbon along `p`. */
function addRibbon(m: Mesher, p: TrackPath, ground: TrackGround, lift: number): void {
  const withRun = p.runL.some((r) => r > 0) || p.runR.some((r) => r > 0);
  const first = m.pos.length / 3;
  const per = withRun ? 6 : 2;
  for (let k = 0; k < p.count; k++) {
    const lx = p.tz[k]!;
    const lz = -p.tx[k]!;
    const h = p.half[k]!;
    const road = surfaceHex(p.surface[k]!);
    const run = surfaceHex(p.runSurface[k]!);
    const lats: [number, number][] = withRun
      ? [
          [-h - p.runR[k]!, run],
          [-h, run],
          [-h, road],
          [h, road],
          [h, run],
          [h + p.runL[k]!, run],
        ]
      : [
          [-h, road],
          [h, road],
        ];
    for (const [lat, hex] of lats) {
      const x = p.x[k]! + lx * lat;
      const z = p.z[k]! + lz * lat;
      m.v(x, ground.heightAt(x, z) + lift, z, hex);
    }
  }
  const segs = p.closed ? p.count : p.count - 1;
  for (let k = 0; k < segs; k++) {
    const a = first + k * per;
    const c = first + ((k + 1) % p.count) * per;
    for (let q = 0; q < per; q += 2) m.quad(a + q, a + q + 1, c + q, c + q + 1);
  }
}

/** Flat quad strip piece between samples k and k+1 of the main loop at laterals [l0, l1]. */
function addStrip(m: Mesher, p: TrackPath, ground: TrackGround, k: number, l0: number, l1: number, lift: number, hex: number): void {
  const b = (k + 1) % p.count;
  const ids: number[] = [];
  for (const i of [k, b]) {
    for (const lat of [l0, l1]) {
      const x = p.x[i]! + p.tz[i]! * lat;
      const z = p.z[i]! - p.tx[i]! * lat;
      ids.push(m.v(x, ground.heightAt(x, z) + lift, z, hex));
    }
  }
  m.quad(ids[0]!, ids[1]!, ids[2]!, ids[3]!);
}

function buildMarkings(track: Track, ground: TrackGround): THREE.BufferGeometry {
  const m = new Mesher();
  const p = track.path;
  const ds = track.length / p.count;
  for (let k = 0; k < p.count; k++) {
    const s = k * ds;
    const h = p.half[k]!;
    if (s + ds > CHEQUER / 2 + 0.3 && s < track.length - CHEQUER / 2 - 0.3) {
      addStrip(m, p, ground, k, h - 0.35, h - 0.13, MARK_LIFT, WHITE);
      addStrip(m, p, ground, k, -h + 0.13, -h + 0.35, MARK_LIFT, WHITE);
      if (s % 9 < 3) addStrip(m, p, ground, k, -0.09, 0.09, MARK_LIFT, WHITE);
    }
    let c = 0;
    for (let d = -KERB_FILL; d <= KERB_FILL; d++) {
      const v = p.curv[(k + d + p.count) % p.count]!;
      if (Math.abs(v) > Math.abs(c)) c = v;
    }
    if (Math.abs(c) > KERB_CURV) {
      const hex = Math.floor(s / 2) % 2 ? RED : WHITE;
      if (c > 0) addStrip(m, p, ground, k, h - 0.05, h + KERB_WIDTH, KERB_LIFT, hex);
      else addStrip(m, p, ground, k, -h - KERB_WIDTH, -h + 0.05, KERB_LIFT, hex);
    }
  }
  // Chequered start / finish band: ≈1 m squares across the road, two rows.
  const pt = blankPoint();
  const cols = Math.max(2, Math.round(p.half[0]! * 2));
  const rows = 2;
  const corner = (r: number, c: number) => {
    track.pointAt(-CHEQUER / 2 + (r * CHEQUER) / rows, pt);
    const lat = -pt.half + (c * 2 * pt.half) / cols;
    const x = pt.x + pt.tz * lat;
    const z = pt.z - pt.tx * lat;
    return [x, ground.heightAt(x, z) + MARK_LIFT, z] as const;
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const hex = (r + c) % 2 ? BLACK : WHITE;
      const [a, b, cc, d] = [corner(r, c), corner(r, c + 1), corner(r + 1, c), corner(r + 1, c + 1)].map(([x, y, z]) => m.v(x, y, z, hex));
      m.quad(a!, b!, cc!, d!);
    }
  }
  return m.geometry();
}

/** Wall base point on the wall line, its ground height and the outward unit vector. */
type WallSection = { x: number; y: number; z: number; ox: number; oz: number };

/** Continuous barrier on each walled side of the main loop, broken (and capped) where the flag is off. */
function buildWalls(track: Track, ground: TrackGround): THREE.BufferGeometry {
  const m = new Mesher();
  const p = track.path;
  const n = p.count;
  const hgt = track.json.road.wallHeight;
  const ds = track.length / n;
  const prof = WALL_PROFILE.map(([u, v]) => [u, v > 0 ? v * hgt : v] as const);
  // Section k of side `side` (+1 left, −1 right): base point, base height, outward unit vector.
  const sec = (k: number, side: number): WallSection => {
    const ox = p.tz[k]! * side;
    const oz = -p.tx[k]! * side;
    const off = p.half[k]! + (side > 0 ? p.runL[k]! : p.runR[k]!);
    const x = p.x[k]! + ox * off;
    const z = p.z[k]! + oz * off;
    return { x, z, y: ground.heightAt(x, z), ox, oz };
  };
  const point = (s: WallSection, j: number, hex: number) =>
    m.v(s.x + s.ox * prof[j]![0], s.y + prof[j]![1], s.z + s.oz * prof[j]![0], hex);
  for (const side of [1, -1]) {
    const flag = side > 0 ? p.wallL : p.wallR;
    for (let k = 0; k < n; k++) {
      if (!flag[k]) continue;
      const b = (k + 1) % n;
      const s0 = sec(k, side);
      const s1 = sec(b, side);
      const stripe = Math.floor((k * ds) / 4) % 2 ? RED : WHITE;
      for (let j = 0; j < prof.length - 1; j++) {
        const hex = j === 3 ? stripe : j < 3 ? CONCRETE : CONCRETE_DARK;
        const a0 = point(s0, j, hex);
        const b0 = point(s0, j + 1, hex);
        const a1 = point(s1, j, hex);
        const b1 = point(s1, j + 1, hex);
        // The profile runs clockwise (inner foot → top → outer foot); mirror the winding per side.
        if (side > 0) m.quad(a0, b0, a1, b1);
        else m.quad(b0, a0, b1, a1);
      }
      for (const [at, end] of [
        [k, !flag[(k - 1 + n) % n]],
        [b, !flag[b]],
      ] as const) {
        if (!end) continue;
        const s = sec(at, side);
        const ids = prof.map((_, j) => point(s, j, CONCRETE_DARK));
        const forward = at === b;
        // Fan winding: in profile order faces back on the left wall, forward on the right.
        const flip = (side > 0) === forward;
        for (let j = 1; j < ids.length - 1; j++) {
          if (flip) m.idx.push(ids[0]!, ids[j + 1]!, ids[j]!);
          else m.idx.push(ids[0]!, ids[j]!, ids[j + 1]!);
        }
      }
    }
  }
  return m.geometry();
}

/** Knock state: 0 in place, 1 flying / tumbling, 2 knocked and at rest. */
const AT_REST = 0;
const FLYING = 1;
const DOWN = 2;

export class TrackArt {
  readonly group = new THREE.Group();
  private readonly placed: readonly Placed[];
  private readonly ground: TrackGround;
  private readonly lamps: THREE.InstancedMesh;
  private readonly lampColour: number[] = [];
  private lights = -1;
  /** Per placement: instance slot in its prefab's meshes. */
  private readonly slot: Int32Array;
  private readonly meshes: Partial<Record<PrefabId, THREE.InstancedMesh[]>> = {};
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
    const plain = plainMaterial();

    const terrain = new THREE.Mesh(
      buildTerrain(track, ground),
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
    );
    terrain.receiveShadow = true;
    terrain.name = "terrain";

    const rm = new Mesher();
    addRibbon(rm, track.path, ground, ROAD_LIFT);
    for (const sc of track.shortcuts) addRibbon(rm, sc.path, ground, SHORTCUT_LIFT);
    const road = new THREE.Mesh(rm.geometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.02 }));
    road.receiveShadow = true;
    road.name = "road";

    const marks = new THREE.Mesh(
      buildMarkings(track, ground),
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }),
    );
    marks.receiveShadow = true;
    marks.name = "markings";

    const walls = new THREE.Mesh(buildWalls(track, ground), plain);
    walls.castShadow = true;
    walls.receiveShadow = true;
    walls.name = "walls";
    this.group.add(terrain, road, marks, walls);

    // Start gantry, built in the line's frame: x = lateral (+ left), y up from the road, z forward.
    const pt = track.pointAt(0, blankPoint());
    const p = track.path;
    const roadY = ground.heightAt(pt.x, pt.z);
    const frame = new THREE.Matrix4().makeRotationY(Math.atan2(pt.tx, pt.tz)).setPosition(pt.x, roadY, pt.z);
    const latL = pt.half + p.runL[0]! + 1.2;
    const latR = -(pt.half + p.runR[0]! + 1.2);
    const pieces: Piece[] = [];
    const pylon = prefabParts("gantry", plain)[0]!.geometry;
    for (const lat of [latL, latR]) {
      const lx = pt.x + pt.tz * lat;
      const lz = pt.z - pt.tx * lat;
      const foot = ground.heightAt(lx, lz) - roadY;
      const leg = pylon.clone().scale(1, (GANTRY_BEAM - 0.4 - foot) / 6, 1).translate(lat, foot, 0);
      pieces.push([leg, 0xc8cbd0]);
    }
    pylon.dispose();
    pieces.push([box(latL - latR + 1, 0.8, 0.9, (latL + latR) / 2, GANTRY_BEAM, 0), 0x2a2c32]);
    pieces.push([box(latL - latR + 1, 0.12, 0.92, (latL + latR) / 2, GANTRY_BEAM + 0.46, 0), RED]);
    const panelX = [pt.half * 0.45, -pt.half * 0.45];
    for (const x of panelX) pieces.push([box(3.3, 1.3, 0.3, x, GANTRY_BEAM - 1.05, 0), BLACK]);
    const gantry = new THREE.Mesh(painted(pieces).applyMatrix4(frame), plain);
    gantry.castShadow = true;
    gantry.name = "start-gantry";

    const disc = new THREE.CircleGeometry(0.42, 20).rotateY(Math.PI);
    this.lamps = new THREE.InstancedMesh(disc, new THREE.MeshBasicMaterial({ toneMapped: false }), panelX.length * 3);
    this.lamps.name = "start-lights";
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
    this.group.add(gantry, this.lamps);
    this.setLights(0);

    // Props: one InstancedMesh per prefab part.
    const byPrefab = new Map<PrefabId, number[]>();
    placed.forEach((pl, idx) => {
      const list = byPrefab.get(pl.prefab) ?? [];
      list.push(idx);
      byPrefab.set(pl.prefab, list);
    });
    this.slot = new Int32Array(placed.length);
    for (const [id, list] of byPrefab) {
      const knock = PREFABS[id].body === "knock";
      const meshes = prefabParts(id, plain).map((part) => {
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, list.length);
        mesh.name = `prop:${id}`;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        // Knocked props leave the instances' original bounds.
        mesh.frustumCulled = !knock;
        return mesh;
      });
      this.meshes[id] = meshes;
      list.forEach((idx, s) => {
        this.slot[idx] = s;
        this.restMatrix(idx);
        for (const mesh of meshes) mesh.setMatrixAt(s, this.m4);
      });
      for (const mesh of meshes) {
        mesh.computeBoundingSphere();
        this.group.add(mesh);
      }
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
      const k = c === l - 1 ? 1 : LIGHT_OFF;
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
      const floor = this.ground.heightAt(pos[i3]!, pos[i3 + 2]!);
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
    for (const m of mats) {
      if (m instanceof THREE.MeshStandardMaterial) {
        m.map?.dispose();
        m.emissiveMap?.dispose();
      }
      m.dispose();
    }
    this.group.removeFromParent();
    this.group.clear();
  }

  /** Placement `i`'s standing matrix into `m4`. */
  private restMatrix(i: number): void {
    const p = this.placed[i]!;
    this.m4.compose(this.v.set(p.x, p.y, p.z), this.q.setFromAxisAngle(this.up, p.yaw), this.sc.set(p.sx, p.sy, p.sz));
  }
}
