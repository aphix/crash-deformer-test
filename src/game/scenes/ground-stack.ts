import * as THREE from "three";
import { SURFACE } from "../world/constants.ts";
import { GROUND_LEVEL } from "./constants.ts";

/**
 * The one layering rule for everything drawn flat on the ground. A layer sits on a LEVEL of a fixed stack, and the level is
 * its draw order: the terrain (and the sandbox / derby floor) first, then run-off, the paved roads (concrete, asphalt, cobble)
 * with their paint and kerbs, the looser roads (a dirt or gravel track, a grass or sand ford lies over the road it crosses),
 * then the scenes' decals (rings, lamp pools, the derby lip) and their glow. Only the terrain and a bridge's top write depth.
 * Every layer above them is painted over what is below it and writes no depth, so where two of them overlap the higher level
 * wins whatever the depth buffer says: a phone's GPU rounds vertices to a sixteenth of a pixel, and two ground planes seen at
 * a grazing angle then differ by about 60 depth steps, more than any offset a depth-writing road could take without
 * creeping over the tyres of the cars on it.
 *
 * Painted layers are still depth-tested, against the terrain and against `depthProxy` (the ribbons at their true height), so
 * a crest hides the road beyond it. For that test they are drawn nearer than they lie by two lifts, neither of which grows
 * on screen with distance: `GROUND_LIFT_PX` of a pixel of their own depth slope (`polygonOffsetFactor`), which clears the
 * raster noise (that slope times the vertex rounding) at every distance and angle, and `GROUND_LIFT_M` toward the camera in
 * view space, which clears the centimetre or two two crossing roads' triangles part by near the camera, where a pixel of
 * slope is under a centimetre of height. Opaque layers draw before everything else and write no depth, so nothing tests
 * against their lift; a transparent decal draws after the cars and is tested against them, so it takes the slope lift alone.
 *
 * Bridge decks are the one place ground lies over ground at another height; their top surface is an ordinary depth-writing
 * mesh ("deck" level) that the roads under it lose to by depth, not by order.
 * `ground-overlap.test-util.ts` scans every course for overlaps this leaves ambiguous.
 */
const GROUND_STACK = [
  GROUND_LEVEL.terrain,
  GROUND_LEVEL.deck,
  GROUND_LEVEL.runoff,
  SURFACE.concrete,
  SURFACE.asphalt,
  SURFACE.cobble,
  GROUND_LEVEL.marking,
  GROUND_LEVEL.kerb,
  SURFACE.dirt,
  SURFACE.gravel,
  SURFACE.grass,
  SURFACE.sand,
  GROUND_LEVEL.decal,
  GROUND_LEVEL.glow,
] as const;
export type GroundLevel = (typeof GROUND_STACK)[number];

/** Levels that write depth and sit where they are: the terrain and a bridge's top (it is metres over what it crosses). */
const BASE_LEVELS: readonly GroundLevel[] = [GROUND_LEVEL.terrain, GROUND_LEVEL.deck];

/** True for a level that writes depth and is drawn where it lies. */
export function isBaseLevel(level: GroundLevel): boolean {
  return BASE_LEVELS.includes(level);
}

/**
 * Pixels of its own depth slope a painted layer is tested nearer than it lies. Two planes whose vertices a GPU rounds to
 * 1/2^b px differ by up to √2 / 2^(b+1) px of their slope: 0.044 px at 4 bits, 0.088 at 3.
 */
export const GROUND_LIFT_PX = 1;
/** Metres an opaque painted layer is moved toward the camera in view space (along the ray, so it stays where it is on screen). */
export const GROUND_LIFT_M = 0.03;

const LIFT_GLSL = `gl_Position = projectionMatrix * vec4(mvPosition.xyz * max(1.0 - ${GROUND_LIFT_M} / length(mvPosition.xyz), 0.0), 1.0);`;

/** Render order of a level: the whole ground draws before the rest of the scene, bottom of the stack first. */
const GROUND_ORDER = -100;
export function levelOrder(level: GroundLevel): number {
  return GROUND_ORDER + GROUND_STACK.indexOf(level);
}

/**
 * Make `material` the surface of `level`: above the base, it writes no depth and is tested `GROUND_LIFT_PX` of its depth slope
 * nearer, and when opaque `GROUND_LIFT_M` nearer too (its programs keyed `|ground`).
 */
export function groundMaterial<M extends THREE.Material>(material: M, level: GroundLevel): M {
  if (isBaseLevel(level)) return material;
  material.depthWrite = false;
  material.polygonOffset = true;
  material.polygonOffsetFactor = -GROUND_LIFT_PX;
  if (material.transparent || material.userData.ground === true) return material;
  material.userData.ground = true;
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    prev.call(material, shader, renderer);
    shader.vertexShader = shader.vertexShader.replace("#include <project_vertex>", `#include <project_vertex>\n${LIFT_GLSL}`);
  };
  material.customProgramCacheKey = () => `${prevKey.call(material)}|ground`;
  return material;
}

/** A ground mesh of `level`: its material made a ground surface and its place in the draw order set. */
export function groundMesh<G extends THREE.BufferGeometry, M extends THREE.Material>(geometry: G, material: M, level: GroundLevel): THREE.Mesh<G, M> {
  const mesh = new THREE.Mesh(geometry, groundMaterial(material, level));
  mesh.renderOrder = levelOrder(level);
  return mesh;
}

/**
 * The depth the painted ribbons leave behind. Layers above the terrain write none, and the terrain under a ribbon is not drawn,
 * so a crest of road or run-off would not hide the ground beyond it. This mesh writes the painted road and run-off ribbons of
 * `layers` (not their paint, kerbs or a bridge's top), at their true height, into the depth buffer and no colour; the layers
 * themselves pass against it by their lift, and a car or a wall tests against the true depth of the ground. It draws just after
 * the terrain.
 */
export function depthProxy(layers: readonly { kind: string; level: GroundLevel; m: { pos: ArrayLike<number>; idx: ArrayLike<number> } }[]): THREE.Mesh {
  const parts = layers.filter((l) => (l.kind === "road" || l.kind === "runoff") && !isBaseLevel(l.level)).map((l) => l.m);
  let posCount = 0;
  let idxCount = 0;
  for (const part of parts) {
    posCount += part.pos.length;
    idxCount += part.idx.length;
  }
  const pos = new Float32Array(posCount);
  const idx = new Uint32Array(idxCount);
  let p = 0;
  let k = 0;
  for (const part of parts) {
    const base = p / 3;
    for (let i = 0; i < part.pos.length; i++) pos[p++] = part.pos[i]!;
    for (let i = 0; i < part.idx.length; i++) idx[k++] = part.idx[i]! + base;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geometry.setIndex(new THREE.BufferAttribute(idx, 1));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ colorWrite: false }));
  mesh.name = "ground-depth";
  mesh.renderOrder = levelOrder(GROUND_LEVEL.terrain) + 0.5;
  return mesh;
}

/**
 * Height (m) a line layer lies over the floor: the hardware applies a depth offset to polygons only, so a grid of lines
 * keeps clear by height instead. 2.5 cm is 8 depth steps at the 80 m of the farthest orbit camera.
 */
export const LINE_LIFT = 0.025;
