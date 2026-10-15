import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { triangles } from "../world/collider-drawn.test-util.ts";
import { BASIN, FOUNTAIN, POOL, type PrefabId } from "../world/catalog.ts";
import { CAPITOL_POOL, capitolPool } from "../world/landmarks.ts";
import { prefabParts } from "./prefabs.ts";

/**
 * The least (m) a surface may lie under the water's top inside its footprint, seen from above. The highest overhead flight (the reel's
 * 80 m plus up to 60 m of climb) sees the Mall's water from about 200 m: one step of a 24-bit depth buffer with the game camera's near plane
 * of 0.1 m is 200² / (0.1 · 2²⁴) = 2.4 cm there, so 5 cm is two steps. Nearer than that, stone and water flicker (the radial streaks over
 * the Mall's basin were a face 1 cm under the water, seen at about 100 m).
 */
const OVERHEAD_DEPTH_GAP = 0.05;
/** Rounding noise (m) between two faces drawn at one height (the geometry holds float32). */
const SAME_HEIGHT = 1e-5;
/** Barycentric samples along a triangle's edge when asking which part of it lies in the water's footprint. */
const SAMPLES = 6;

type Pond = { id: PrefabId; waterTop: number; inside: (x: number, z: number) => boolean };

/** Whether (x, z) is inside a polygon (even-odd). */
function inPolygon(polygon: readonly (readonly [number, number])[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, az] = polygon[i]!;
    const [bx, bz] = polygon[j]!;
    if (az > z !== bz > z && x < ((bx - ax) * (z - az)) / (bz - az) + ax) inside = !inside;
  }
  return inside;
}

const CAPITOL_WATER = capitolPool().water;

const PONDS: Pond[] = [
  { id: "reflecting-pool", waterTop: POOL.y1 + POOL.brim, inside: (x, z) => Math.abs(x) < POOL.half[0] - POOL.rim && Math.abs(z) < POOL.half[1] - POOL.rim },
  { id: "basin", waterTop: BASIN.y1 + POOL.brim, inside: (x, z) => Math.hypot(x, z) < BASIN.r - BASIN.rim },
  { id: "fountain", waterTop: FOUNTAIN.basin.y1 + POOL.brim, inside: (x, z) => Math.hypot(x, z) < FOUNTAIN.water.r },
  { id: "capitol-pool", waterTop: CAPITOL_POOL.y1 + CAPITOL_POOL.brim, inside: (x, z) => inPolygon(CAPITOL_WATER, x, z) },
];

/** The heights (m) of every upward-facing horizontal triangle of a prefab with a point inside the footprint: the faces an overhead camera sees. */
function horizontalFacesInside(id: PrefabId, inside: Pond["inside"]): number[] {
  const plain = new THREE.MeshBasicMaterial();
  const mats = { plain, concrete: plain, building: plain, billboard: plain, water: plain };
  const heights: number[] = [];
  for (const part of prefabParts(id, mats)) {
    const t = triangles(part.geometry);
    for (let i = 0; i < t.length; i += 9) {
      const y = t[i + 1]!;
      if (Math.abs(t[i + 4]! - y) > SAME_HEIGHT || Math.abs(t[i + 7]! - y) > SAME_HEIGHT) continue;
      const facingUp = (t[i + 5]! - t[i + 2]!) * (t[i + 6]! - t[i]!) - (t[i + 3]! - t[i]!) * (t[i + 8]! - t[i + 2]!) > 0;
      if (!facingUp) continue;
      const sampled = [];
      for (let a = 1; a < SAMPLES; a++) for (let b = 1; a + b < SAMPLES; b++) sampled.push([a / SAMPLES, b / SAMPLES, (SAMPLES - a - b) / SAMPLES] as const);
      const touchesFootprint = sampled.some(([u, v, w]) => inside(t[i]! * u + t[i + 3]! * v + t[i + 6]! * w, t[i + 2]! * u + t[i + 5]! * v + t[i + 8]! * w));
      if (touchesFootprint) heights.push(y);
    }
  }
  return heights;
}

describe("given the Mall's four ponds (reflecting pool, round basin, lawn fountain, Capitol Reflecting Pool) drawn at scale 1", () => {
  for (const pond of PONDS) {
    it(`when the ${pond.id}'s upward faces over its water are listed, then its water's top is among them and no other face lies within ${OVERHEAD_DEPTH_GAP} m under it`, () => {
      const heights = horizontalFacesInside(pond.id, pond.inside);
      assert.ok(heights.some((y) => Math.abs(y - pond.waterTop) < SAME_HEIGHT), `the ${pond.id} draws no water top at ${pond.waterTop} m`);
      const flickering = heights.filter((y) => y < pond.waterTop - SAME_HEIGHT && y > pond.waterTop - OVERHEAD_DEPTH_GAP);
      assert.deepEqual(flickering, [], `${flickering.length} faces of the ${pond.id} lie under its water top (${pond.waterTop} m) at ${[...new Set(flickering)].join(", ")} m`);
    });
  }
});
