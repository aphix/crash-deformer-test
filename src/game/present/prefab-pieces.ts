/**
 * The pieces every prefab drawing builds from: coloured geometry (`Piece`) merged into one painted mesh, boxes, cylinders and
 * square frustums, the Mall's marble shades, and the materials and parts the drawings hand to the track art.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/** Materials the prefabs draw with (shared with the track art where it says so). */
export type PrefabMaterials = {
  /** Flat-shaded vertex colours (most props, gantry). */
  plain: THREE.Material;
  /** Vertex colours × concrete texture (barrier blocks, walls). */
  concrete: THREE.Material;
  building: THREE.Material;
  billboard: THREE.Material;
  /** Still water: vertex colours, near-mirror gloss (the pools). */
  water: THREE.Material;
};

/** One drawable part of a prefab: its geometry, its material, and whether the material is shared with the track art. */
export type PrefabPart = { geometry: THREE.BufferGeometry; material: THREE.Material; shared: boolean };

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
export function cyl(rTop: number, rBottom: number, y0: number, y1: number, seg: number, open = false): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(rTop, rBottom, y1 - y0, seg, 1, open).translate(0, (y0 + y1) / 2, 0);
}

export const MARBLE_SHADE = { low: 0xe9e2d3, high: 0xd9d0bf, wall: 0xece7dc, dome: 0xf3f1ea, trim: 0xc9c2b2 };

/** A square-plan frustum (half sides `h0` at y0, `h1` at y1), faces square to the axes. */
export function squareFrustum(h0: number, h1: number, y0: number, y1: number): THREE.BufferGeometry {
  return cyl(h1 * Math.SQRT2, h0 * Math.SQRT2, y0, y1, 4).rotateY(Math.PI / 4);
}

