import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { Track } from "../world/track.ts";
import { OFF_MENU, TRACKS } from "../world/tracks/index.ts";
import { depthProxy, groundMaterial, GROUND_LIFT_M, GROUND_LIFT_PX, isBaseLevel, levelOrder, type GroundLevel } from "../scenes/ground-stack.ts";
import { courseLayers, depthSlope, depthStep, heightSteps, RANGE, rasterNoise, scanOverlaps, type ScanLayer } from "./ground-overlap.test-util.ts";

/** A flat 4 × 4 m square `y` m over the ground, two triangles, drawn as a ground layer of `level` would be. */
const quad = (name: string, y: number, level: GroundLevel): ScanLayer => ({
  name,
  pos: [0, y, 0, 4, y, 0, 4, y, 4, 0, y, 4],
  idx: [0, 1, 2, 0, 2, 3],
  order: levelOrder(level),
  writes: isBaseLevel(level),
  lift: isBaseLevel(level) ? 0 : GROUND_LIFT_PX,
});

describe("given a 24-bit depth buffer over 0.1 to 900 m and flat ground seen from the race camera 2.4 m up", () => {
  it("when the depth resolution is read, then a step is 13 mm at 150 m and under a millimetre at 30 m", () => {
    assert.ok(Math.abs(depthStep(150) - 0.0134) < 0.0005);
    assert.ok(depthStep(30) < 0.001);
  });

  it("when a pixel row of the ground is read, then it climbs about 1360 steps at any distance, five times that from the 0.45 m floor of the chase cam", () => {
    assert.ok(Math.abs(depthSlope(2.4) - 1363) < 20);
    assert.ok(Math.abs(depthSlope(0.45) / depthSlope(2.4) - 2.4 / 0.45) < 1e-9);
  });

  const roundingCases = [
    { it: "when a GPU places vertices on a 1/16 pixel grid (a phone), then two triangulations of one plane differ by about 60 steps", bits: 4, from: 58, to: 62 },
    { it: "when a GPU places vertices on a 1/8 pixel grid, then they differ by about 120 steps", bits: 3, from: 118, to: 123 },
    { it: "when a GPU places vertices on a 1/256 pixel grid (a desktop), then they differ by under 4 steps", bits: 8, from: 0, to: 4 },
  ] as const;
  for (const testCase of roundingCases) {
    it(testCase.it, () => {
      const noise = rasterNoise(2.4, testCase.bits);
      assert.ok(noise >= testCase.from && noise <= testCase.to, `${noise}`);
    });
  }
});

describe("given the scan for ground layers that z-fight (are drawn at the same depth)", () => {
  it("when two painted layers of different levels share a plane, then none is found whichever is listed first: the higher level is painted over the lower", () => {
    assert.deepEqual(scanOverlaps([quad("road.dirt", 0.015, "dirt"), quad("road.asphalt", 0.015, "asphalt")]), []);
    assert.deepEqual(scanOverlaps([quad("road.asphalt", 0.015, "asphalt"), quad("road.dirt", 0.015, "dirt")]), []);
  });

  it("when two depth-writing layers share a plane, then the whole shared square is found: only the depth buffer could tell them apart", () => {
    const flat = scanOverlaps([quad("road.asphalt.deck", 0.015, "deck"), quad("marking.deck", 0.015, "deck")]);
    assert.equal(flat.length, 1);
    assert.ok(Math.abs(flat[0]!.area - 16) < 1e-6, "the whole 4 × 4 m square");
  });

  it("when a layer is painted over another that lies 20 cm above it, then it is found: the higher level would hide what is clearly above it", () => {
    const inverted = scanOverlaps([quad("road.dirt", 0, "dirt"), quad("road.asphalt", 0.2, "asphalt")]);
    assert.equal(inverted.length, 1);
    assert.equal(inverted[0]!.minSteps, 0);
  });

  it("when one painted mesh has parts at two heights, then it is found, unless they are within 5 cm: its own triangle order would decide which shows", () => {
    const low = quad("road.asphalt", 0, "asphalt");
    assert.equal(scanOverlaps([low, quad("road.asphalt", 0.3, "asphalt")]).length, 1);
    assert.equal(scanOverlaps([low, quad("road.asphalt", 0.05, "asphalt")]).length, 0);
  });

  it("when a road lies 1.5 cm over the terrain at 250 m, then its lift clears the raster noise of a 1/8 pixel grid and its height alone does not", () => {
    const noise = rasterNoise(2.4, 3);
    assert.ok(heightSteps(0.015, RANGE) < noise, "1.5 cm of height is a few dozen steps there");
    const ground = quad("terrain", 0, "terrain");
    assert.deepEqual(scanOverlaps([ground, quad("road.asphalt", 0.015, "asphalt")], RANGE, 0.5, ["terrain"], noise), []);
    const unlifted = { ...quad("road.asphalt", 0.015, "asphalt"), lift: 0 };
    assert.equal(scanOverlaps([ground, unlifted], RANGE, 0.5, ["terrain"], noise).length, 1);
  });

  it("when every course's ground layers are scanned at 250 m for a phone's 1/16 pixel grid, then under 2 m² of its whole ground is ambiguous", () => {
    for (const raw of [...TRACKS, ...OFF_MENU]) {
      const track = new Track(raw);
      const overlaps = scanOverlaps(courseLayers(track), RANGE, 0.5);
      const area = overlaps.reduce((sum, o) => sum + o.area, 0);
      assert.ok(area < 2, `${track.id}: ${area} m² ambiguous: ${overlaps.map((o) => `${o.a} over ${o.b} ${o.area} m² at ${o.x},${o.z}`).join("; ")}`);
    }
  });
});

describe("given the ground stack", () => {
  it("when its levels are listed bottom to top, then they draw in that order before the rest of the scene, and only the terrain and a bridge's top write depth", () => {
    const order = (["terrain", "deck", "runoff", "concrete", "asphalt", "cobble", "marking", "kerb", "dirt", "gravel", "grass", "sand", "decal", "glow"] as const).map(levelOrder);
    for (let i = 1; i < order.length; i++) assert.ok(order[i]! > order[i - 1]!, `level ${i} draws at ${order[i]}, not after ${order[i - 1]}`);
    assert.ok(order.every((o) => o < 0), "the ground draws before the rest of the scene");
    assert.deepEqual(
      (["terrain", "deck", "runoff", "asphalt", "marking", "decal", "glow"] as const).filter(isBaseLevel),
      ["terrain", "deck"],
    );
  });

  it("when a road's, a transparent decal's and the terrain's materials are made ground surfaces, then the road and the decal stop writing depth and are depth-tested a pixel of their own depth slope nearer, the opaque road alone is also moved 3 cm toward the camera along its view ray (once, however often it is made one), and the terrain is left as it was", () => {
    // The renderer is not used by a ground surface's compile step; a vertex shader is all it reads.
    const renderer = {} as THREE.WebGLRenderer;
    const compiled = (material: THREE.Material): string => {
      const shader = { vertexShader: "void main() {\n#include <project_vertex>\n}" } as THREE.WebGLProgramParametersWithUniforms;
      material.onBeforeCompile(shader, renderer);
      return shader.vertexShader;
    };
    const road = groundMaterial(groundMaterial(new THREE.MeshBasicMaterial(), "asphalt"), "asphalt");
    const decal = groundMaterial(new THREE.MeshBasicMaterial({ transparent: true }), "decal");
    const terrain = groundMaterial(new THREE.MeshBasicMaterial(), "terrain");
    const lift = `gl_Position = projectionMatrix * vec4(mvPosition.xyz * max(1.0 - ${GROUND_LIFT_M} / length(mvPosition.xyz), 0.0), 1.0);`;
    assert.equal(GROUND_LIFT_M, 0.03);
    assert.deepEqual(
      [road, decal, terrain].map((m) => ({ depthWrite: m.depthWrite, polygonOffset: m.polygonOffset, factor: m.polygonOffsetFactor, lifts: compiled(m).split(lift).length - 1 })),
      [
        { depthWrite: false, polygonOffset: true, factor: -1, lifts: 1 },
        { depthWrite: false, polygonOffset: true, factor: -1, lifts: 0 },
        { depthWrite: true, polygonOffset: false, factor: 0, lifts: 0 },
      ],
    );
  });

  it("when the depth copy is built from a painted road, its run-off, its paint, a bridge's top, the terrain and a second road, then it holds the road, the run-off and the second road, one after the other", () => {
    const tri = (y: number) => ({ pos: [0, y, 0, 1, y, 0, 0, y, 1], idx: [0, 1, 2] });
    const proxy = depthProxy([
      { kind: "terrain", level: "terrain", m: tri(-1) },
      { kind: "road", level: "asphalt", m: tri(0) },
      { kind: "runoff", level: "runoff", m: tri(2) },
      { kind: "marking", level: "marking", m: tri(4) },
      { kind: "road", level: "deck", m: tri(3) },
      { kind: "road", level: "dirt", m: { pos: [5, 1, 5, 6, 1, 5, 5, 1, 6], idx: [0, 1, 2] } },
    ]);
    assert.deepEqual(Array.from(proxy.geometry.index!.array), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(Array.from(proxy.geometry.attributes.position!.array), [0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 1, 2, 0, 0, 2, 1, 5, 1, 5, 6, 1, 5, 5, 1, 6]);
    proxy.geometry.dispose();
    (proxy.material as THREE.Material).dispose();
  });

  it("when the depth copy is built, then it writes depth and no colour, and draws between the terrain and a bridge's top", () => {
    const proxy = depthProxy([]);
    const material = proxy.material as THREE.MeshBasicMaterial;
    assert.deepEqual({ colorWrite: material.colorWrite, depthWrite: material.depthWrite }, { colorWrite: false, depthWrite: true });
    assert.ok(proxy.renderOrder > levelOrder("terrain") && proxy.renderOrder < levelOrder("deck"));
    proxy.geometry.dispose();
    material.dispose();
  });
});
