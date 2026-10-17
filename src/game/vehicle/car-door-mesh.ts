import * as THREE from "three";
import { hypot2, detSin } from "../kernel/physics-core.js";
import type { BodyStyle } from "./car-variants.ts";
import { splitCreases } from "./car-crease.ts";
import { CREASE_DEGREES, SEDAN, sampleSlice, sideX } from "./car-mesh.ts";

/**
 * Door and mirror dimensions in car space. The door group's origin is the hinge axis at the
 * A-pillar, (±hingeX, hingeY, hingeZ); the skin box spans z −0.57…0.01 and y ±0.31 around it.
 */
export const DOOR = {
  hingeX: 0.86,
  hingeY: 0.54,
  hingeZ: 0.55,
  /** Hinge axis to trailing edge (m). */
  length: 0.57,
  halfHeight: 0.31,
  /** Door skin mesh offset from the hinge along z (m). */
  skinZ: -0.28,
  /** Mirror base in door space (±mirrorX, mirrorY, 0); the cap reaches `mirrorReach` out and is ±`mirrorHalfDepth` deep. */
  mirrorX: 0.06,
  mirrorY: 0.32,
  mirrorReach: 0.21,
  mirrorHalfDepth: 0.08,
} as const;

/** Door skin over the body side at its outer face (m). */
const DOOR_PROUD = 0.003;
/** The door skin is a slab this thick (m) inboard of its outer face. */
const DOOR_THICKNESS = 0.05;
/** The skin's length along z (m) between its leading and trailing edge. */
const DOOR_LENGTH = 0.58;
/** Outer-face rows (bunched toward the top by `DOOR_ROW_WARP`, so the shoulder roll reads round) and columns before the edge rolls are added. */
const DOOR_ROWS = 8;
const DOOR_ROW_WARP = 1.6;
const DOOR_COLUMNS = 6;
/** The outer face rolls over its perimeter in a quarter circle of this radius (m), in `DOOR_EDGE_STEPS` chords, and meets the slab's edge wall tangent to it. */
const DOOR_EDGE_RADIUS = 0.02;
const DOOR_EDGE_STEPS = 2;
/** A face row or column nearer than this (m) to where the edge roll starts is dropped: two stations a few millimetres apart are only skin cost. */
const DOOR_EDGE_CLEARANCE = 0.01;
/** The skin's trailing end slopes down and the leading end up past these z (m), as the body side does at the hinge and latch. */
const DOOR_FRONT_SLOPE = { fromZ: 0.16, rise: -0.06 } as const;
const DOOR_REAR_SLOPE = { fromZ: -0.2, rise: -0.04 } as const;

/** Stations along one axis of the door skin, from `-halfExtent` to `halfExtent`: the edge roll's chords at each end, `interior` stations between them. */
function doorStations(halfExtent: number, interior: readonly number[]): number[] {
  const fromEdge = Array.from({ length: DOOR_EDGE_STEPS + 1 }, (_, k) => DOOR_EDGE_RADIUS * (1 - detSin((Math.PI / 2) * (1 - k / DOOR_EDGE_STEPS))));
  const kept = interior.filter((station) => halfExtent - Math.abs(station) >= DOOR_EDGE_RADIUS + DOOR_EDGE_CLEARANCE);
  return [...fromEdge.map((d) => d - halfExtent), ...kept, ...[...fromEdge].reverse().map((d) => halfExtent - d)];
}

/** How far (m) the outer face has rolled back at `distanceToRowEdge` and `distanceToColumnEdge` from the outline: 0 where the roll starts, `DOOR_EDGE_RADIUS` at the outline. */
function doorEdgeDrop(distanceToRowEdge: number, distanceToColumnEdge: number): number {
  const r = DOOR_EDGE_RADIUS;
  const into = Math.min(r, hypot2(Math.max(r - distanceToRowEdge, 0), Math.max(r - distanceToColumnEdge, 0)));
  return r - Math.sqrt(r * r - into * into);
}

/** Loop of grid vertex ids around a `columns` x `rows` grid (row-major), bottom row left to right, then up the right side, back along the top and down the left. */
function gridPerimeter(columns: number, rows: number): number[] {
  const loop: number[] = [];
  for (let c = 0; c < columns; c++) loop.push(c);
  for (let r = 1; r < rows; r++) loop.push(r * columns + columns - 1);
  for (let c = columns - 2; c >= 0; c--) loop.push((rows - 1) * columns + c);
  for (let r = rows - 2; r >= 1; r--) loop.push(r * columns);
  return loop;
}

/**
 * Door skin in hinge-local space (parent at the A-pillar hinge, the skin `DOOR.skinZ` behind it). The outer face
 * follows the body side (`sideX`) at each height and station and rolls over its perimeter in a rounded edge into a
 * slab `DOOR_THICKNESS` thick inboard, closed by a flat inner face; its rows bunch toward the top so the shoulder
 * roll reads round.
 */
export function makeDoorGeometry(sign: number, style: BodyStyle = SEDAN): THREE.BufferGeometry {
  const h = DOOR.halfHeight;
  const halfLength = DOOR_LENGTH / 2;
  const rowInterior = Array.from({ length: DOOR_ROWS - 1 }, (_, k) => h * (1 - 2 * (1 - (k + 1) / DOOR_ROWS) ** DOOR_ROW_WARP));
  const columnInterior = Array.from({ length: DOOR_COLUMNS - 1 }, (_, k) => -halfLength + (DOOR_LENGTH * (k + 1)) / DOOR_COLUMNS);
  const rows = doorStations(h, rowInterior);
  const columns = doorStations(halfLength, columnInterior);
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const outerX: number[] = [];
  const tri = (a: number, b: number, c: number, outward: boolean) => (outward ? indices.push(a, b, c) : indices.push(a, c, b));
  for (const rowStation of rows) {
    for (const z of columns) {
      let y = rowStation;
      if (z > DOOR_FRONT_SLOPE.fromZ) y += (z - DOOR_FRONT_SLOPE.fromZ) * DOOR_FRONT_SLOPE.rise;
      if (z < DOOR_REAR_SLOPE.fromZ) y += (DOOR_REAR_SLOPE.fromZ - z) * DOOR_REAR_SLOPE.rise;
      const sl = sampleSlice(DOOR.hingeZ + DOOR.skinZ + z, style.profile);
      const outer = sideX(DOOR.hingeY + y, sl.hw, sl.yBelt) + DOOR_PROUD - DOOR.hingeX;
      const drop = doorEdgeDrop(Math.min(rowStation + h, h - rowStation), Math.min(z + halfLength, halfLength - z));
      positions.push(sign * (outer - drop), y, z);
      outerX.push(outer);
      uvs.push((z + halfLength) / DOOR_LENGTH, (rowStation + h) / (2 * h));
    }
  }
  const faceVertices = positions.length / 3;
  for (let r = 0; r < rows.length - 1; r++) {
    for (let c = 0; c < columns.length - 1; c++) {
      const a = r * columns.length + c;
      const b = a + 1;
      const above = a + columns.length;
      tri(a, b, above, sign < 0);
      tri(b, above + 1, above, sign < 0);
    }
  }
  const loop = gridPerimeter(columns.length, rows.length);
  const slabEdge = loop.map((faceVertex, k) => {
    positions.push(sign * (outerX[faceVertex]! - DOOR_THICKNESS), positions[faceVertex * 3 + 1]!, positions[faceVertex * 3 + 2]!);
    uvs.push(uvs[faceVertex * 2]!, uvs[faceVertex * 2 + 1]!);
    return faceVertices + k;
  });
  let centreY = 0;
  let centreZ = 0;
  let centreX = 0;
  for (const v of slabEdge) {
    centreX += positions[v * 3]! / slabEdge.length;
    centreY += positions[v * 3 + 1]! / slabEdge.length;
    centreZ += positions[v * 3 + 2]! / slabEdge.length;
  }
  const centre = positions.length / 3;
  positions.push(centreX, centreY, centreZ);
  uvs.push(0.5, 0.5);
  for (let k = 0; k < loop.length; k++) {
    const next = (k + 1) % loop.length;
    tri(loop[k]!, loop[next]!, slabEdge[k]!, sign > 0);
    tri(loop[next]!, slabEdge[next]!, slabEdge[k]!, sign > 0);
    tri(centre, slabEdge[k]!, slabEdge[next]!, sign > 0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return splitCreases(geo, CREASE_DEGREES.door);
}
