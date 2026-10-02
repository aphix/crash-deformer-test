import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { makeJerseyBarrier, makeLamp } from "../engine-world.ts";
import type { PrefabId } from "./catalog.ts";

/**
 * Prefab meshes, one geometry + material per part, built to be drawn as one InstancedMesh per
 * part. At scale 1 a prefab fills `PREFABS[id].size` [w, h, d]; its origin sits on the ground at
 * the footprint centre, +Z forward, front (seats, billboard face, lamp arm) on +X. Large props
 * reach a little below the origin so they do not float on a slope.
 */

export type PrefabPart = { geometry: THREE.BufferGeometry; material: THREE.Material };

const C = {
  black: 0x1b1c20,
  white: 0xe8e6e0,
  orange: 0xff6a1a,
  concrete: 0xb7b1a4,
  concreteDark: 0xa39d90,
  light: 0xd8d4cc,
  metal: 0x2a2c32,
  truss: 0xc8cbd0,
  hay: 0xc9a64a,
  twine: 0x7d6430,
  wood: 0x9a6b3a,
  woodDark: 0x6b4626,
  rock: 0x7a766e,
  trunk: 0x5a4030,
  leaf: [0x2f5a2c, 0x35632f, 0x3b6d34],
  wall: 0x8d8a84,
  glass: 0x2a3440,
  roof: 0x55524d,
  seatBlue: 0x2f5d9a,
  seatRed: 0xb3261e,
};

/** Flat-shaded vertex-colour material shared by every plain part (and the track art). */
export function plainMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85, metalness: 0.05 });
}

/** A coloured piece: geometry already in prefab space and its sRGB colour. */
export type Piece = [THREE.BufferGeometry, number];

/** Merge pieces into one non-indexed geometry with a per-vertex `color` (position, normal, color only). */
export function painted(pieces: readonly Piece[]): THREE.BufferGeometry {
  const col = new THREE.Color();
  const parts = pieces.map(([g, hex]) => {
    const n = g.index ? g.toNonIndexed() : g;
    if (n !== g) g.dispose();
    for (const name of Object.keys(n.attributes)) if (name !== "position" && name !== "normal") n.deleteAttribute(name);
    n.clearGroups();
    col.setHex(hex);
    const count = n.getAttribute("position").count;
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
function cyl(rTop: number, rBottom: number, y0: number, y1: number, seg: number, x = 0, z = 0): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(rTop, rBottom, y1 - y0, seg).translate(x, (y0 + y1) / 2, z);
}

function cone(): Piece[] {
  // Body radius at height y, for the reflective band hugging it.
  const r = (y: number) => 0.165 - ((y - 0.04) / 0.66) * 0.14;
  return [
    [box(0.4, 0.04, 0.4, 0, 0.02, 0), C.black],
    [cyl(0.025, 0.165, 0.04, 0.7, 10), C.orange],
    [cyl(r(0.44) + 0.006, r(0.3) + 0.006, 0.3, 0.44, 10), C.white],
  ];
}

function tyreStack(): Piece[] {
  const out: Piece[] = [];
  for (let i = 0; i < 4; i++) {
    const g = new THREE.TorusGeometry(0.25, 0.125, 6, 12).rotateX(Math.PI / 2).translate(0, 0.125 + i * 0.25, 0);
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
    [cyl(0.16, 0.24, -0.2, 2.2, 6), C.trunk],
    [new THREE.ConeGeometry(1.6, 3.4, 7).translate(0, 3.3, 0), C.leaf[0]!],
    [new THREE.ConeGeometry(1.2, 2.8, 7).translate(0, 5.0, 0), C.leaf[1]!],
    [new THREE.ConeGeometry(0.75, 1.9, 7).translate(0, 6.05, 0), C.leaf[2]!],
  ];
}

function building(): Piece[] {
  const out: Piece[] = [
    [box(11.8, 15, 11.8, 0, 6, 0), C.wall],
    [box(12, 0.5, 12, 0, 13.75, 0), C.roof],
  ];
  for (let f = 0; f < 4; f++) {
    const y = 2 + f * 3.2;
    for (const s of [-1, 1]) {
      out.push([box(0.2, 1.3, 10.4, s * 5.9, y, 0), C.glass]);
      out.push([box(10.4, 1.3, 0.2, 0, y, s * 5.9), C.glass]);
    }
  }
  return out;
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

function billboardTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 256;
  const ctx = c.getContext("2d")!;
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
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function billboard(plain: THREE.Material): PrefabPart[] {
  const map = billboardTexture();
  const panel = new THREE.MeshStandardMaterial({ map, emissiveMap: map, emissive: 0xffffff, emissiveIntensity: 0.25, roughness: 0.6 });
  return [
    { geometry: painted([[box(0.15, 2.2, 0.15, 0, 1, -2.2), C.metal], [box(0.15, 2.2, 0.15, 0, 1, 2.2), C.metal]]), material: plain },
    { geometry: box(0.3, 2.5, 6, 0, 3.25, 0), material: panel },
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

/** Parts of a group's meshes with each child's transform baked in, then `m` applied. */
function bake(g: THREE.Group, m: THREE.Matrix4): PrefabPart[] {
  g.updateMatrixWorld(true);
  const out: PrefabPart[] = [];
  g.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      out.push({ geometry: (o.geometry as THREE.BufferGeometry).clone().applyMatrix4(o.matrixWorld).applyMatrix4(m), material: o.material as THREE.Material });
    }
  });
  return out;
}

function disposeGroup(g: THREE.Group): void {
  g.traverse((o) => {
    if (o instanceof THREE.Mesh) (o.geometry as THREE.BufferGeometry).dispose();
  });
}

function lamp(): PrefabPart[] {
  const g = makeLamp();
  // makeLamp is 5.2 m with the head on +Z; fit it to 4.4 m with the arm towards the road (+X).
  const k = 4.4 / 5.2;
  const parts = bake(g, new THREE.Matrix4().makeRotationY(Math.PI / 2).scale(new THREE.Vector3(k, k, k)));
  disposeGroup(g);
  return parts;
}

function barrierBlock(): PrefabPart[] {
  const g = makeJerseyBarrier();
  // One 1.78 m × 0.61 m jersey segment stretched to the catalog's 2 m × 0.64 m block.
  const seg = g.children.find((o): o is THREE.Mesh => o instanceof THREE.Mesh && o.geometry instanceof THREE.ExtrudeGeometry)!;
  const geometry = (seg.geometry as THREE.BufferGeometry).clone().scale(0.64 / 0.61, 1, 2 / 1.78);
  const material = seg.material as THREE.Material;
  g.traverse((o) => {
    if (o instanceof THREE.Mesh && o.material !== material) (o.material as THREE.Material).dispose();
  });
  disposeGroup(g);
  return [{ geometry, material }];
}

/** Mesh parts of prefab `id` at scale 1; plain parts use `plain` (see `plainMaterial`). */
export function prefabParts(id: PrefabId, plain: THREE.Material): PrefabPart[] {
  const one = (pieces: Piece[]): PrefabPart[] => [{ geometry: painted(pieces), material: plain }];
  switch (id) {
    case "cone":
      return one(cone());
    case "tyre-stack":
      return one(tyreStack());
    case "hay-bale":
      return one(hayBale());
    case "crate":
      return one(crate());
    case "barrier-block":
      return barrierBlock();
    case "rock":
      return one(rock());
    case "tree":
      return one(tree());
    case "building":
      return one(building());
    case "grandstand":
      return one(grandstand());
    case "billboard":
      return billboard(plain);
    case "lamp":
      return lamp();
    case "gantry":
      return one(pylon());
  }
}
