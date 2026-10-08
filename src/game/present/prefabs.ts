import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { makeAsphalt, makeJerseyBarrier, makeLamp } from "./engine-world.ts";
import { tagSurface } from "./ultra/surface-tag.ts";
import { STAR_INNER, type PrefabId } from "../world/catalog.ts";

/**
 * Prefab meshes and the race's shared procedural textures. A prefab is one or a few parts (geometry
 * + material), each drawn as one InstancedMesh. At scale 1 a prefab fills `PREFABS[id].size`
 * [w, h, d]; its origin sits on the ground at the footprint centre, +Z forward, front (seats,
 * billboard face, lamp arm) on +X. Large props reach a little below the origin so they do not
 * float on a slope.
 */

const C = {
  black: 0x1b1c20,
  white: 0xe8e6e0,
  orange: 0xff6a1a,
  concrete: 0xb7b1a4,
  concreteDark: 0xa39d90,
  barrier: 0xc4bfb3,
  light: 0xd8d4cc,
  metal: 0x2a2c32,
  truss: 0xc8cbd0,
  hay: 0xc9a64a,
  twine: 0x7d6430,
  wood: 0x9a6b3a,
  woodDark: 0x6b4626,
  rock: 0x7a766e,
  trunk: 0x5a4030,
  leaf: [0x2f5a2c, 0x3b6d34],
  roof: 0x6a665f,
  seatBlue: 0x2f5d9a,
  seatRed: 0xb3261e,
};

/** World metres per texture tile. */
export const TILE = { asphalt: 8, concrete: 4, detail: 12 };

/** Billboard canvas: the ad on top, a metal-coloured strip (posts) along the bottom. */
const BILL_W = 512;
const BILL_AD = 256;
const BILL_STRIP = 32;

/**
 * The race's shared textures, built once per track art. `*Gain` is the reciprocal of the texture's
 * mean linear colour: a material with `color = gain` and `map = texture` shows its vertex colour on
 * average, so `SURFACES` colours stay the colours you see.
 */
export type RaceTextures = {
  asphalt: THREE.CanvasTexture;
  asphaltGain: THREE.Color;
  concrete: THREE.CanvasTexture;
  concreteGain: THREE.Color;
  /** Natural ground (grass, dirt, gravel, sand, cobble). */
  detail: THREE.CanvasTexture;
  detailGain: THREE.Color;
  /** One window bay (2.95 m × 3.5 m) of a building facade; its bottom-left corner is plain wall. */
  windows: THREE.CanvasTexture;
  billboard: THREE.CanvasTexture;
};

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

function texture(c: HTMLCanvasElement, repeat: boolean): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(c);
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 1 / mean linear colour of a canvas. */
export function gainOf(c: HTMLCanvasElement): THREE.Color {
  const lut = new Float32Array(256);
  const col = new THREE.Color();
  for (let i = 0; i < 256; i++) lut[i] = col.setRGB(i / 255, 0, 0, THREE.SRGBColorSpace).r;
  const px = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < px.length; i += 4) {
    r += lut[px[i]!]!;
    g += lut[px[i + 1]!]!;
    b += lut[px[i + 2]!]!;
  }
  const n = px.length / 4;
  return new THREE.Color(n / r, n / g, n / b);
}

/** Soft blob drawn at (x, y) and its wrapped copies, so the canvas tiles seamlessly. */
function blob(ctx: CanvasRenderingContext2D, size: number, x: number, y: number, r: number, rgba: string): void {
  for (const ox of [-size, 0, size]) {
    for (const oy of [-size, 0, size]) {
      const cx = x + ox;
      const cy = y + oy;
      if (cx + r < 0 || cy + r < 0 || cx - r > size || cy - r > size) continue;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, rgba);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
  }
}

function makeDetail(): HTMLCanvasElement {
  const S = 512;
  const [c, ctx] = canvas(S, S);
  ctx.fillStyle = "#c8c8c8";
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 90; i++) {
    const light = Math.random() > 0.5;
    blob(ctx, S, Math.random() * S, Math.random() * S, 20 + Math.random() * 70, light ? "rgba(255,255,255,0.09)" : "rgba(40,40,40,0.09)");
  }
  for (let i = 0; i < 14000; i++) {
    const n = Math.random();
    ctx.fillStyle = n > 0.5 ? `rgba(255,255,255,${(n - 0.5) * 0.35})` : `rgba(0,0,0,${(0.5 - n) * 0.35})`;
    ctx.fillRect(Math.random() * S, Math.random() * S, n > 0.93 || n < 0.07 ? 3 : 1.5, n > 0.93 || n < 0.07 ? 2 : 1.5);
  }
  return c;
}

function makeConcrete(): HTMLCanvasElement {
  const S = 256;
  const [c, ctx] = canvas(S, S);
  ctx.fillStyle = "#d2d2d2";
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 30; i++) blob(ctx, S, Math.random() * S, Math.random() * S, 12 + Math.random() * 40, Math.random() > 0.5 ? "rgba(255,255,255,0.12)" : "rgba(50,46,40,0.12)");
  for (let i = 0; i < 3500; i++) {
    const n = Math.random();
    ctx.fillStyle = n > 0.6 ? `rgba(255,255,255,${n * 0.18})` : `rgba(30,28,24,${(1 - n) * 0.2})`;
    ctx.fillRect(Math.random() * S, Math.random() * S, n > 0.92 ? 2 : 1, 1);
  }
  // Panel joint, once per tile.
  ctx.fillStyle = "rgba(40,38,34,0.22)";
  ctx.fillRect(0, 0, 2, S);
  return c;
}

function makeWindows(): HTMLCanvasElement {
  const S = 256;
  const [c, ctx] = canvas(S, S);
  ctx.fillStyle = "#dcd7cd";
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 1500; i++) {
    ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.06})`;
    ctx.fillRect(Math.random() * S, Math.random() * S, 2, 2);
  }
  // Window: canvas y runs down, so the sill (bottom of the bay) is at high y.
  const x0 = 38;
  const x1 = 218;
  const y0 = 48;
  const y1 = 190;
  const glass = ctx.createLinearGradient(0, y0, 0, y1);
  glass.addColorStop(0, "#3e5266");
  glass.addColorStop(1, "#1f2933");
  ctx.fillStyle = "#5c5a55";
  ctx.fillRect(x0 - 6, y0 - 6, x1 - x0 + 12, y1 - y0 + 12);
  ctx.fillStyle = glass;
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  ctx.fillStyle = "rgba(255,255,255,0.14)";
  ctx.beginPath();
  ctx.moveTo(x0 + 30, y0);
  ctx.lineTo(x0 + 80, y0);
  ctx.lineTo(x0 + 20, y1);
  ctx.lineTo(x0, y1);
  ctx.lineTo(x0, y0 + 60);
  ctx.fill();
  ctx.fillStyle = "#5c5a55";
  ctx.fillRect((x0 + x1) / 2 - 3, y0, 6, y1 - y0);
  ctx.fillStyle = "#b9b3a8";
  ctx.fillRect(x0 - 10, y1 + 6, x1 - x0 + 20, 10);
  return c;
}

function makeBillboard(): HTMLCanvasElement {
  const [c, ctx] = canvas(BILL_W, BILL_AD + BILL_STRIP);
  ctx.fillStyle = "#f2efe6";
  ctx.fillRect(0, 0, 512, 256);
  ctx.fillStyle = "#c8261c";
  ctx.fillRect(0, 0, 512, 64);
  ctx.fillRect(0, 192, 512, 64);
  ctx.fillStyle = "#16171b";
  ctx.font = "bold 92px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("CRUSH", 256, 130);
  ctx.fillStyle = "#f2efe6";
  ctx.font = "bold 40px sans-serif";
  ctx.fillText("STREAM", 256, 34);
  ctx.fillText("RACEWAY", 256, 224);
  ctx.fillStyle = "#2a2c32";
  ctx.fillRect(0, BILL_AD, BILL_W, BILL_STRIP);
  return c;
}

export function makeRaceTextures(): RaceTextures {
  const asphalt = tagSurface(makeAsphalt(), "asphalt", TILE.asphalt);
  asphalt.repeat.set(1, 1);
  const concrete = makeConcrete();
  const detail = makeDetail();
  return {
    asphalt,
    asphaltGain: gainOf(asphalt.image as HTMLCanvasElement),
    concrete: tagSurface(texture(concrete, true), "concrete", TILE.concrete),
    concreteGain: gainOf(concrete),
    detail: tagSurface(texture(detail, true), "ground", TILE.detail),
    detailGain: gainOf(detail),
    windows: texture(makeWindows(), true),
    billboard: texture(makeBillboard(), false),
  };
}

/** Materials the prefabs draw with (shared with the track art where it says so). */
export type PrefabMaterials = {
  /** Flat-shaded vertex colours (most props, gantry). */
  plain: THREE.Material;
  /** Vertex colours × concrete texture (barrier blocks, walls). */
  concrete: THREE.Material;
  building: THREE.Material;
  billboard: THREE.Material;
};

export function makePrefabMaterials(tex: RaceTextures): PrefabMaterials {
  return {
    plain: new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85, metalness: 0.05 }),
    concrete: new THREE.MeshStandardMaterial({ vertexColors: true, map: tex.concrete, color: tex.concreteGain, roughness: 0.92, metalness: 0.04 }),
    building: new THREE.MeshStandardMaterial({ vertexColors: true, map: tex.windows, roughness: 0.8, metalness: 0.05 }),
    billboard: new THREE.MeshStandardMaterial({ map: tex.billboard, emissiveMap: tex.billboard, emissive: 0xffffff, emissiveIntensity: 0.25, roughness: 0.6 }),
  };
}

/** A coloured piece: geometry already in prefab space and its sRGB colour. */
export type Piece = [THREE.BufferGeometry, number];

/** Merge pieces into one non-indexed geometry with position, normal, uv (zero when a piece has none) and a per-vertex `color`. */
export function painted(pieces: readonly Piece[]): THREE.BufferGeometry {
  const col = new THREE.Color();
  const parts = pieces.map(([g, hex]) => {
    const n = g.index ? g.toNonIndexed() : g;
    if (n !== g) g.dispose();
    for (const name of Object.keys(n.attributes)) if (name !== "position" && name !== "normal" && name !== "uv") n.deleteAttribute(name);
    n.clearGroups();
    const count = n.getAttribute("position").count;
    if (!n.getAttribute("normal")) n.computeVertexNormals();
    if (!n.getAttribute("uv")) n.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    col.setHex(hex);
    const c = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) col.toArray(c, i * 3);
    n.setAttribute("color", new THREE.BufferAttribute(c, 3));
    return n;
  });
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return merged;
}

/** Axis-aligned box of size (w, h, d) centred at (x, y, z). */
export function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}

/** Vertical cylinder / cone from y0 to y1 at (x, z). */
function cyl(rTop: number, rBottom: number, y0: number, y1: number, seg: number, open = false): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(rTop, rBottom, y1 - y0, seg, 1, open).translate(0, (y0 + y1) / 2, 0);
}

/** Every uv of `g` set to (u, v). */
function uvAt(g: THREE.BufferGeometry, u: number, v: number): THREE.BufferGeometry {
  const a = g.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < a.count; i++) a.setXY(i, u, v);
  return g;
}

function cone(): Piece[] {
  // Body radius at height y, for the reflective band hugging it.
  const r = (y: number) => 0.165 - ((y - 0.04) / 0.66) * 0.14;
  return [
    [box(0.4, 0.04, 0.4, 0, 0.02, 0), C.black],
    [cyl(0.025, 0.165, 0.04, 0.7, 8, true), C.orange],
    [cyl(r(0.44) + 0.006, r(0.3) + 0.006, 0.3, 0.44, 8, true), C.white],
  ];
}

function tyreStack(): Piece[] {
  const out: Piece[] = [];
  for (let i = 0; i < 4; i++) {
    const g = new THREE.TorusGeometry(0.25, 0.125, 5, 10).rotateX(Math.PI / 2).translate(0, 0.125 + i * 0.25, 0);
    out.push([g, i % 2 ? C.white : C.black]);
  }
  return out;
}

function hayBale(): Piece[] {
  return [
    [box(1.2, 0.9, 0.9, 0, 0.45, 0), C.hay],
    [box(0.06, 0.92, 0.92, -0.3, 0.45, 0), C.twine],
    [box(0.06, 0.92, 0.92, 0.3, 0.45, 0), C.twine],
  ];
}

function crate(): Piece[] {
  const out: Piece[] = [[box(0.96, 0.96, 0.96, 0, 0.5, 0), C.wood]];
  for (const y of [0.06, 0.94]) out.push([box(1, 0.12, 1, 0, y, 0), C.woodDark]);
  for (const x of [-0.45, 0.45]) for (const z of [-0.45, 0.45]) out.push([box(0.1, 0.76, 0.1, x, 0.5, z), C.woodDark]);
  return out;
}

function rock(): Piece[] {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    // Same hash for a shared corner, so the faceted shell stays closed.
    const h = Math.abs(Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453) % 1;
    const k = 0.8 + 0.25 * h;
    p.setXYZ(i, x * k, y * k, z * k);
  }
  g.computeBoundingBox();
  const b = g.boundingBox!;
  g.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
  g.scale(2.4 / (b.max.x - b.min.x), 1.85 / (b.max.y - b.min.y), 2.2 / (b.max.z - b.min.z));
  g.translate(0, -0.25, 0);
  g.computeVertexNormals();
  return [[g, C.rock]];
}

function tree(): Piece[] {
  return [
    [cyl(0.15, 0.24, -0.2, 2.0, 5, true), C.trunk],
    [new THREE.ConeGeometry(1.6, 3.8, 6).translate(0, 3.3, 0), C.leaf[0]!],
    [new THREE.ConeGeometry(1.05, 3.0, 6).translate(0, 5.5, 0), C.leaf[1]!],
  ];
}

/** Facade plane of width w (m) from y −1.5 to 13.5, uv in window bays (2.95 m × 3.5 m, floors from y 0). */
function facade(w: number): THREE.BufferGeometry {
  const h = 15;
  const g = new THREE.PlaneGeometry(w, h).translate(0, h / 2 - 1.5, 0);
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * w) / 2.95, (uv.getY(i) * h - 1.5) / 3.5);
  return g;
}

function building(): Piece[] {
  const half = 5.9;
  const out: Piece[] = [];
  for (let i = 0; i < 4; i++) {
    out.push([facade(half * 2).translate(0, 0, half).rotateY((i * Math.PI) / 2), 0xffffff]);
  }
  // Roof slab and parapet sample the plain wall at the tile's bottom-left corner.
  out.push([uvAt(box(12, 0.5, 12, 0, 13.75, 0), 0.05, 0.05), C.roof]);
  return out;
}

/** A five-pointed star prism (outer radius R, one tip towards +z) from y0 to y1. */
function star(R: number, y0: number, y1: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const a = (i * Math.PI) / 5;
    const r = i % 2 ? R * STAR_INNER : R;
    if (i) s.lineTo(Math.sin(a) * r, -Math.cos(a) * r);
    else s.moveTo(0, -r);
  }
  // The extrusion runs along the shape's z; turned upright, the shape's y maps to −z.
  return new THREE.ExtrudeGeometry(s, { depth: y1 - y0, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, y0, 0);
}

/** The Plaza de la Revolución memorial: a stone tower in star-plan steps, tapering to a spire. */
function monument(): Piece[] {
  const steps = [[6.2, -0.8, 1.4], [5.7, 1.4, 4.2], [5.1, 4.2, 9], [4.5, 9, 15], [3.9, 15, 22], [3.3, 22, 30], [2.8, 30, 38], [2.3, 38, 45], [1.8, 45, 50]] as const;
  const out = steps.map(([R, y0, y1], i): Piece => [star(R, y0, y1), i % 2 ? 0xd9d3c3 : 0xc4bdab]);
  out.push([new THREE.ConeGeometry(0.8, 5, 5).translate(0, 52.5, 0), 0xb4ad9b]);
  return out;
}

/** A royal palm: a leaning trunk and a crown of eight drooping fronds. */
function palm(): Piece[] {
  const lean = -0.08;
  const out: Piece[] = [[cyl(0.15, 0.27, 0, 8.2, 6).rotateZ(lean), C.trunk]];
  const top = new THREE.Vector3(0, 8.2, 0).applyAxisAngle(new THREE.Vector3(0, 0, 1), lean);
  for (let k = 0; k < 8; k++) {
    const frond = new THREE.BoxGeometry(0.5, 0.05, 3.4).translate(0, 0, 1.8).rotateX(0.5).rotateY((k * Math.PI) / 4).translate(top.x, top.y, 0);
    out.push([frond, C.leaf[k % 2]!]);
  }
  return out;
}

/** A stucco wall 10 m long (tinted per placement), a cap and a weathered footing. */
function wall(): Piece[] {
  return [
    [box(0.4, 3, 10, 0, 1.5, 0), 0xffffff],
    [box(0.6, 0.2, 10, 0, 3.1, 0), C.concrete],
    [box(0.44, 0.5, 10.02, 0, 0.25, 0), C.rock],
  ];
}

function dumpster(): Piece[] {
  return [
    [box(1.9, 1.05, 1.1, 0, 0.7, 0), 0x2f5d3a],
    [box(2, 0.1, 1.25, 0, 1.3, 0), C.black],
    [box(0.12, 0.3, 1.1, -0.82, 0.15, 0), C.metal],
    [box(0.12, 0.3, 1.1, 0.82, 0.15, 0), C.metal],
  ];
}

function grandstand(): Piece[] {
  const out: Piece[] = [];
  const depth = 1.2;
  for (let i = 0; i < 5; i++) {
    const top = 0.6 + 0.8 * i;
    const x = 3.5 - (i + 0.5) * depth;
    out.push([box(depth, top + 0.5, 29.6, x, (top - 0.5) / 2, 0), i % 2 ? C.concreteDark : C.concrete]);
    out.push([box(0.45, 0.4, 29, x - depth / 2 + 0.35, top + 0.2, 0), i === 2 ? C.seatRed : C.seatBlue]);
  }
  out.push([box(1, 6.25, 30, -3, 2.625, 0), C.concrete]);
  out.push([box(6.1, 0.25, 30, -0.45, 5.875, 0), C.light]);
  for (const z of [-14, -4.7, 4.7, 14]) out.push([box(0.2, 5.75, 0.2, 2.4, 2.875, z), C.metal]);
  return out;
}

function billboard(): Piece[] {
  const s0 = BILL_STRIP / (BILL_AD + BILL_STRIP);
  const panel = box(0.3, 2.5, 6, 0, 3.25, 0);
  const uv = panel.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setY(i, s0 + uv.getY(i) * (1 - s0));
  return [
    [uvAt(box(0.15, 2.2, 0.15, 0, 1, -2.2), 0.5, s0 / 2), 0xffffff],
    [uvAt(box(0.15, 2.2, 0.15, 0, 1, 2.2), 0.5, s0 / 2), 0xffffff],
    [panel, 0xffffff],
  ];
}

/** Lattice pylon (also the legs of the start gantry). */
function pylon(): Piece[] {
  const out: Piece[] = [];
  for (const x of [-0.44, 0.44]) for (const z of [-0.44, 0.44]) out.push([box(0.12, 6, 0.12, x, 3, z), C.truss]);
  for (let y = 0.75; y < 6; y += 1.5) {
    for (const s of [-0.44, 0.44]) {
      out.push([box(0.88, 0.07, 0.07, 0, y, s), C.truss]);
      out.push([box(0.07, 0.07, 0.88, s, y, 0), C.truss]);
    }
  }
  out.push([box(1, 0.12, 1, 0, 5.94, 0), C.metal]);
  return out;
}

/** Free a group's geometries, and the materials and maps not listed in `keep`. */
function disposeGroup(g: THREE.Group, keep: readonly THREE.Material[] = []): void {
  g.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    (o.geometry as THREE.BufferGeometry).dispose();
    const m = o.material as THREE.MeshStandardMaterial;
    if (keep.includes(m)) return;
    m.map?.dispose();
    m.dispose();
  });
}

/**
 * makeLamp fitted to 4.4 m with its arm towards the road (+X): the pole in vertex colours, then the
 * head and the night light pool on makeLamp's own shared materials, so the scene's day / night
 * switch lights them with every other lamp.
 */
function lamp(plain: THREE.Material): PrefabPart[] {
  const g = makeLamp();
  g.updateMatrixWorld(true);
  const k = 4.4 / 5.2;
  const fit = new THREE.Matrix4().makeRotationY(Math.PI / 2).scale(new THREE.Vector3(k, k, k));
  const pole: Piece[] = [];
  const shared: PrefabPart[] = [];
  g.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const m = o.material as THREE.MeshStandardMaterial;
    const geo = (o.geometry as THREE.BufferGeometry).clone().applyMatrix4(o.matrixWorld).applyMatrix4(fit);
    if (o.name === "pool" || m.emissive?.getHex()) shared.push({ geometry: geo, material: m, shared: true });
    else pole.push([geo, m.color.getHex()]);
  });
  disposeGroup(
    g,
    shared.map((p) => p.material),
  );
  return [{ geometry: painted(pole), material: plain, shared: false }, ...shared];
}

function barrierBlock(): Piece[] {
  const g = makeJerseyBarrier();
  // One 1.78 m × 0.61 m jersey segment stretched to the catalog's 2 m × 0.64 m block.
  const seg = g.children.find((o): o is THREE.Mesh => o instanceof THREE.Mesh && o.geometry instanceof THREE.ExtrudeGeometry)!;
  const geometry = (seg.geometry as THREE.BufferGeometry).clone().scale(0.64 / 0.61, 1, 2 / 1.78);
  disposeGroup(g);
  return [[geometry, C.barrier]];
}

/** One drawable part of a prefab; `shared` materials belong to the scene and must not be disposed with the prefab. */
type PrefabPart = { geometry: THREE.BufferGeometry; material: THREE.Material; shared: boolean };

/** Prefab `id` at scale 1 as drawable parts (one for most; the lamp adds its head and night pool). */
export function prefabParts(id: PrefabId, mats: PrefabMaterials): PrefabPart[] {
  const one = (pieces: Piece[], material: THREE.Material): PrefabPart[] => [{ geometry: painted(pieces), material, shared: false }];
  switch (id) {
    case "cone":
      return one(cone(), mats.plain);
    case "tyre-stack":
      return one(tyreStack(), mats.plain);
    case "hay-bale":
      return one(hayBale(), mats.plain);
    case "crate":
      return one(crate(), mats.plain);
    case "barrier-block":
      return one(barrierBlock(), mats.concrete);
    case "rock":
      return one(rock(), mats.plain);
    case "tree":
      return one(tree(), mats.plain);
    case "building":
      return one(building(), mats.building);
    case "stucco":
      return one(building(), mats.building);
    case "monument":
      return one(monument(), mats.plain);
    case "palm":
      return one(palm(), mats.plain);
    case "wall":
      return one(wall(), mats.plain);
    case "dumpster":
      return one(dumpster(), mats.plain);
    case "grandstand":
      return one(grandstand(), mats.plain);
    case "billboard":
      return one(billboard(), mats.billboard);
    case "lamp":
      return lamp(mats.plain);
    case "gantry":
      return one(pylon(), mats.plain);
  }
}
