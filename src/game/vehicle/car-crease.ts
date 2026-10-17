import * as THREE from "three";
import { hypot3, detCos } from "../kernel/physics-core.js";

const RAD_PER_DEGREE = Math.PI / 180;
/** A face thinner than this (its doubled area, m^2) has no normal worth comparing: it never decides a crease. */
const DEGENERATE_FACE_AREA = 1e-12;
const CORNERS_PER_TRIANGLE = 3;

function findRoot(parents: Int32Array, corner: number): number {
  let root = corner;
  while (parents[root] !== root) root = parents[root]!;
  let walker = corner;
  while (parents[walker] !== root) {
    const next = parents[walker]!;
    parents[walker] = root;
    walker = next;
  }
  return root;
}

function joinCorners(parents: Int32Array, a: number, b: number): void {
  const rootA = findRoot(parents, a);
  const rootB = findRoot(parents, b);
  if (rootA !== rootB) parents[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
}

/** The corner (index into the triangle list) of triangle `triangle` that sits on `vertex`. */
function cornerOnVertex(indices: ArrayLike<number>, triangle: number, vertex: number): number {
  const base = triangle * CORNERS_PER_TRIANGLE;
  for (let k = 0; k < CORNERS_PER_TRIANGLE; k++) if (indices[base + k] === vertex) return base + k;
  throw new Error(`splitCreases: triangle ${triangle} has no corner on vertex ${vertex}`);
}

/** Unit face normals of an indexed triangle list, a zero vector for a degenerate face. */
function faceNormals(positions: ArrayLike<number>, indices: ArrayLike<number>): Float64Array {
  const triangleCount = indices.length / CORNERS_PER_TRIANGLE;
  const normals = new Float64Array(triangleCount * 3);
  for (let t = 0; t < triangleCount; t++) {
    const a = indices[t * 3]! * 3;
    const b = indices[t * 3 + 1]! * 3;
    const c = indices[t * 3 + 2]! * 3;
    const abx = positions[b]! - positions[a]!;
    const aby = positions[b + 1]! - positions[a + 1]!;
    const abz = positions[b + 2]! - positions[a + 2]!;
    const acx = positions[c]! - positions[a]!;
    const acy = positions[c + 1]! - positions[a + 1]!;
    const acz = positions[c + 2]! - positions[a + 2]!;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const doubledArea = hypot3(nx, ny, nz);
    if (doubledArea * doubledArea < DEGENERATE_FACE_AREA) continue;
    normals[t * 3] = nx / doubledArea;
    normals[t * 3 + 1] = ny / doubledArea;
    normals[t * 3 + 2] = nz / doubledArea;
  }
  return normals;
}

/** Both faces have a normal and it turns away from the other's by more than the crease allows (`smoothDot` = cosine of the angle). */
function isCrease(normals: Float64Array, f: number, g: number, smoothDot: number): boolean {
  const hasNormal = (face: number) => normals[face * 3] !== 0 || normals[face * 3 + 1] !== 0 || normals[face * 3 + 2] !== 0;
  if (!hasNormal(f) || !hasNormal(g)) return false;
  const dot = normals[f * 3]! * normals[g * 3]! + normals[f * 3 + 1]! * normals[g * 3 + 1]! + normals[f * 3 + 2]! * normals[g * 3 + 2]!;
  return dot < smoothDot;
}

/**
 * Hard edges where the drawn mesh declares them. Every vertex whose faces meet across an edge sharper than `creaseDegrees`
 * (the angle between the two face normals) is copied once per smooth fan of faces, so the vertex normals (this function
 * recomputes them) are hard across the crease and averaged everywhere else. The copies keep every attribute and their
 * position exactly, so a skin that welds by rest position (`wrinkleSeeds`) moves them as one. The original vertices keep
 * their index (the first fan of each vertex), the copies are appended, and the triangle order is unchanged.
 */
export function splitCreases(geometry: THREE.BufferGeometry, creaseDegrees: number): THREE.BufferGeometry {
  const index = geometry.getIndex();
  if (!index) throw new Error("splitCreases: the geometry must be indexed");
  const indices = index.array;
  const positions = geometry.getAttribute("position").array;
  const vertexCount = geometry.getAttribute("position").count;
  const triangleCount = indices.length / CORNERS_PER_TRIANGLE;
  const normals = faceNormals(positions, indices);
  const smoothDot = detCos(creaseDegrees * RAD_PER_DEGREE);

  const parents = Int32Array.from({ length: indices.length }, (_, corner) => corner);
  const facesOnEdge = new Map<number, number[]>();
  for (let t = 0; t < triangleCount; t++) {
    for (let k = 0; k < CORNERS_PER_TRIANGLE; k++) {
      const a = indices[t * 3 + k]!;
      const b = indices[t * 3 + ((k + 1) % CORNERS_PER_TRIANGLE)]!;
      const key = Math.min(a, b) * vertexCount + Math.max(a, b);
      const faces = facesOnEdge.get(key);
      if (faces) faces.push(t);
      else facesOnEdge.set(key, [t]);
    }
  }
  for (const [key, faces] of facesOnEdge) {
    const low = Math.floor(key / vertexCount);
    const high = key % vertexCount;
    for (let i = 0; i < faces.length; i++) {
      for (let j = i + 1; j < faces.length; j++) {
        const f = faces[i]!;
        const g = faces[j]!;
        if (isCrease(normals, f, g, smoothDot)) continue;
        joinCorners(parents, cornerOnVertex(indices, f, low), cornerOnVertex(indices, g, low));
        joinCorners(parents, cornerOnVertex(indices, f, high), cornerOnVertex(indices, g, high));
      }
    }
  }

  const fanVertex = new Map<number, number>();
  const claimed = new Uint8Array(vertexCount);
  const copiedFrom: number[] = [];
  const remapped = indices.slice();
  for (let corner = 0; corner < indices.length; corner++) {
    const vertex = indices[corner]!;
    const root = findRoot(parents, corner);
    let target = fanVertex.get(root);
    if (target === undefined) {
      if (claimed[vertex] === 0) {
        claimed[vertex] = 1;
        target = vertex;
      } else {
        target = vertexCount + copiedFrom.length;
        copiedFrom.push(vertex);
      }
      fanVertex.set(root, target);
    }
    remapped[corner] = target;
  }
  if (copiedFrom.length === 0) {
    geometry.computeVertexNormals();
    return geometry;
  }

  for (const name of Object.keys(geometry.attributes)) {
    const attribute = geometry.getAttribute(name) as THREE.BufferAttribute;
    const { itemSize } = attribute;
    const grown = new (attribute.array.constructor as new (length: number) => typeof attribute.array)((vertexCount + copiedFrom.length) * itemSize);
    grown.set(attribute.array);
    for (let c = 0; c < copiedFrom.length; c++) {
      for (let k = 0; k < itemSize; k++) grown[(vertexCount + c) * itemSize + k] = attribute.array[copiedFrom[c]! * itemSize + k]!;
    }
    geometry.setAttribute(name, new THREE.BufferAttribute(grown, itemSize, attribute.normalized));
  }
  geometry.setIndex(new THREE.BufferAttribute(remapped, 1));
  geometry.computeVertexNormals();
  return geometry;
}
