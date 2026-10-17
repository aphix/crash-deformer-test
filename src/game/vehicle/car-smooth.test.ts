import * as THREE from "three";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { CAR_STYLES, CAR_STYLE_IDS, type CarStyleId } from "./car-variants.ts";
import { CREASE_DEGREES, makeBumperGeometry, makeHoodGeometry, makeTrunkGeometry, sampleSlice, sectionPoints } from "./car-mesh.ts";
import { makeChassisGeometry } from "./car-chassis-mesh.ts";
import { makeDoorGeometry } from "./car-door-mesh.ts";
import { makeGreenhouseFrame } from "./car-greenhouse-mesh.ts";
import { DeformableCar } from "./car.ts";
import { panelRegions, PANEL_NAMES } from "./car-panels.ts";
import { cageSourceOf } from "./car-cage-rig.ts";
import { assertSameDigest, paint } from "./test-support.ts";
import { runWall } from "../contact/crash-scenarios.test-util.ts";

const DEGREES_PER_RADIAN = 180 / Math.PI;

type Loft = { ring: number; slices: number };

const loftOf = (geometry: THREE.BufferGeometry): Loft => geometry.userData.loft as Loft;
const positionAt = (geometry: THREE.BufferGeometry, vertex: number): THREE.Vector3 => new THREE.Vector3().fromBufferAttribute(geometry.getAttribute("position"), vertex);
const angleBetweenDegrees = (a: THREE.Vector3, b: THREE.Vector3): number => Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1)) * DEGREES_PER_RADIAN;
const triangleCountOf = (geometry: THREE.BufferGeometry): number => (geometry.index ? geometry.index.count : geometry.getAttribute("position").count) / 3;

// ---- the measuring helpers ------------------------------------------------------------------------------------------------

/** A face thinner than this (m^2, doubled) has no normal to compare. */
const DEGENERATE_FACE_AREA = 1e-12;

/** Unit normal of the triangle (a, b, c), or null when it is degenerate. */
function triangleNormal(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): THREE.Vector3 | null {
  const normal = b.clone().sub(a).cross(c.clone().sub(a));
  return normal.lengthSq() < DEGENERATE_FACE_AREA ? null : normal.normalize();
}

/** Unit normal of the loft quad of ring segment `segment` between slices `slice` and `slice + 1`, or null when degenerate. */
function loftQuadNormal(geometry: THREE.BufferGeometry, loft: Loft, slice: number, segment: number): THREE.Vector3 | null {
  const next = (segment + 1) % loft.ring;
  const a = positionAt(geometry, slice * loft.ring + segment);
  const b = positionAt(geometry, slice * loft.ring + next);
  const c = positionAt(geometry, (slice + 1) * loft.ring + segment);
  const d = positionAt(geometry, (slice + 1) * loft.ring + next);
  const sum = b.clone().sub(a).cross(c.clone().sub(a)).add(d.clone().sub(b).cross(c.clone().sub(b)));
  return sum.lengthSq() < DEGENERATE_FACE_AREA ? null : sum.normalize();
}

/** The angles (degrees) between the quad before ring line `line` and the quad after it, at every slice of the loft: the lengthwise edge's dihedral. */
function ringLineDihedrals(geometry: THREE.BufferGeometry, line: number, sliceFilter: (slice: number) => boolean = () => true): number[] {
  const loft = loftOf(geometry);
  const angles: number[] = [];
  for (let slice = 0; slice < loft.slices - 1; slice++) {
    if (!sliceFilter(slice)) continue;
    const before = loftQuadNormal(geometry, loft, slice, (line + loft.ring - 1) % loft.ring);
    const after = loftQuadNormal(geometry, loft, slice, line);
    if (before && after) angles.push(angleBetweenDegrees(before, after));
  }
  return angles;
}

/** How many vertices of `geometry` sit exactly where vertex `vertex` does (1: a lone vertex, 2 or more: the edge was split here). */
function verticesAtSamePlace(geometry: THREE.BufferGeometry, vertex: number): number {
  const position = geometry.getAttribute("position");
  let count = 0;
  for (let other = 0; other < position.count; other++) {
    if (position.getX(other) === position.getX(vertex) && position.getY(other) === position.getY(vertex) && position.getZ(other) === position.getZ(vertex)) count++;
  }
  return count;
}

type EdgeCensus = { sharpEdges: number; sharpEdgesStillShared: number; smoothEdgesSplit: number; firstOffence: string };

/**
 * Every edge shared by exactly two faces of `geometry` (edges matched by the vertices' places, so a split edge still counts), against
 * `creaseDegrees`: the sharp ones (the faces' normals at least that far apart) must not share their vertices, the smooth ones must.
 */
function censusOfEdges(geometry: THREE.BufferGeometry, creaseDegrees: number): EdgeCensus {
  const position = geometry.getAttribute("position");
  const index = geometry.getIndex()!;
  const placeOf = (vertex: number) => `${position.getX(vertex)},${position.getY(vertex)},${position.getZ(vertex)}`;
  const faces = new Map<string, { normal: THREE.Vector3; vertices: string }[]>();
  for (let t = 0; t < index.count; t += 3) {
    const corners = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
    const normal = triangleNormal(...(corners.map((vertex) => positionAt(geometry, vertex)) as [THREE.Vector3, THREE.Vector3, THREE.Vector3]));
    if (!normal) continue;
    for (let k = 0; k < 3; k++) {
      const [a, b] = [corners[k]!, corners[(k + 1) % 3]!];
      const key = [placeOf(a), placeOf(b)].sort().join("|");
      const record = { normal, vertices: [a, b].sort((x, y) => x - y).join(",") };
      const list = faces.get(key);
      if (list) list.push(record);
      else faces.set(key, [record]);
    }
  }
  const census: EdgeCensus = { sharpEdges: 0, sharpEdgesStillShared: 0, smoothEdgesSplit: 0, firstOffence: "none" };
  for (const [key, [first, second, ...rest]] of faces) {
    if (!first || !second || rest.length > 0) continue;
    const shared = first.vertices === second.vertices;
    const degrees = angleBetweenDegrees(first.normal, second.normal);
    if (degrees >= creaseDegrees) {
      census.sharpEdges++;
      if (shared) census.sharpEdgesStillShared++;
      if (shared && census.firstOffence === "none") census.firstOffence = `a ${degrees.toFixed(1)}° edge at ${key} shares its vertices`;
    } else if (!shared) {
      census.smoothEdgesSplit++;
      if (census.firstOffence === "none") census.firstOffence = `a ${degrees.toFixed(1)}° edge at ${key} is split`;
    }
  }
  return census;
}

// ---- (a) rest normals ------------------------------------------------------------------------------------------------------

/** Half-ring indices of the body's side that the arches and the door cut never reach: the shoulder rows and the feature line (`sectionPoints`); the ring's deck rows face up into a tub on some bodies, so no outward test reads them. */
const SIDE_HALF_FIRST = 2;
const SIDE_HALF_LAST = 4;
/** Slices nearer than this (m) to the end faces are the rolled ends. */
const END_SLICES = 3;
/** The front door's cut runs from z 0 to 0.54 (`doorAperture`): the side there drops to the sill and faces up, so no outward test reads it. */
const DOOR_CUT_Z = [-0.05, 0.6] as const;

/** The slice's ring points on the body's side (both halves), with the vertex's ring-centroid estimate of "outward". */
function outerSidePoints(geometry: THREE.BufferGeometry, normals: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): { vertex: number; normal: THREE.Vector3; outward: THREE.Vector3 }[] {
  const loft = loftOf(geometry);
  const halfCount = (loft.ring - 1) / 2;
  const centre = new THREE.Vector3();
  for (let vertex = 0; vertex < loft.ring * loft.slices; vertex++) centre.add(positionAt(geometry, vertex));
  centre.multiplyScalar(1 / (loft.ring * loft.slices));
  const points: { vertex: number; normal: THREE.Vector3; outward: THREE.Vector3 }[] = [];
  for (let slice = 0; slice < loft.slices; slice++) {
    const ringCentre = new THREE.Vector3();
    for (let k = 0; k < loft.ring; k++) ringCentre.add(positionAt(geometry, slice * loft.ring + k));
    ringCentre.multiplyScalar(1 / loft.ring);
    const isEnd = slice < END_SLICES || slice >= loft.slices - END_SLICES;
    for (let k = 0; k < loft.ring; k++) {
      const half = k < halfCount ? k : loft.ring - 1 - k;
      if (k === halfCount || half > SIDE_HALF_LAST || half < SIDE_HALF_FIRST) continue;
      const vertex = slice * loft.ring + k;
      const at = positionAt(geometry, vertex);
      if (!isEnd && at.z > DOOR_CUT_Z[0] && at.z < DOOR_CUT_Z[1]) continue;
      points.push({ vertex, normal: new THREE.Vector3().fromBufferAttribute(normals, vertex), outward: at.clone().sub(isEnd ? centre : ringCentre).normalize() });
    }
  }
  return points;
}

const normalTestCases = CAR_STYLE_IDS.map((id) => ({ id }));

describe("given every body style's rest meshes (chassis, bonnet, boot, doors, bumpers) as built", () => {
  for (const testCase of normalTestCases) {
    const style = CAR_STYLES[testCase.id];
    const meshes: [string, THREE.BufferGeometry][] = [
      ["chassis", makeChassisGeometry(style)],
      ["bonnet", makeHoodGeometry(style)],
      ["boot", makeTrunkGeometry(style)],
      ["left door", makeDoorGeometry(-1, style)],
      ["right door", makeDoorGeometry(1, style)],
      ["front bumper", makeBumperGeometry(true, style)],
      ["rear bumper", makeBumperGeometry(false, style)],
    ];

    it(`when a ${testCase.id}'s normals are read, then every normal of every mesh is finite and unit length`, () => {
      for (const [name, geometry] of meshes) {
        const normal = geometry.getAttribute("normal");
        for (let vertex = 0; vertex < normal.count; vertex++) {
          const length = Math.hypot(normal.getX(vertex), normal.getY(vertex), normal.getZ(vertex));
          assert.ok(Math.abs(length - 1) < 1e-4, `${testCase.id} ${name} vertex ${vertex}: normal length ${length}`);
        }
      }
    });

    it(`when a ${testCase.id}'s body side and ends are read, then every normal points outward (dot with the centroid direction above 0)`, () => {
      const chassis = meshes[0]![1];
      for (const point of outerSidePoints(chassis, chassis.getAttribute("normal"))) {
        assert.ok(point.normal.dot(point.outward) > 0, `${testCase.id} vertex ${point.vertex}: normal ${point.normal.dot(point.outward)} against outward`);
      }
    });
  }
});

// ---- (b) the declared creases and curves ----------------------------------------------------------------------------------

/** An edge that rolls round (a pillar's octagon corner, the nose's roll) must turn by less than this per chord: the octagon's 45° plus a 5° margin. */
const ROLLED_EDGE_LIMIT_DEGREES = 50;
/** A lid's dome, bow and skirt corners barely turn: under 5° a chord. */
const FLAT_CURVE_LIMIT_DEGREES = 5;

const lidCreaseTable = [
  { it: "a bonnet's shut line and lip corners (ring points 0, 4, 6 to 11)", style: "sedan", part: "bonnet", creaseLines: [0, 4, 6, 7, 8, 9, 10, 11], smoothLines: [1, 2, 3, 5, 12], creaseDegrees: CREASE_DEGREES.deckLid },
  { it: "a sedan boot lid's shut line and lip corners (ring points 0, 4, 6 to 11)", style: "sedan", part: "boot", creaseLines: [0, 4, 6, 7, 8, 9, 10, 11], smoothLines: [1, 2, 3, 5, 12], creaseDegrees: CREASE_DEGREES.deckLid },
  { it: "a hatchback's tailgate edges (ring points 0, 4, 5, 6)", style: "hatchback", part: "boot", creaseLines: [0, 4, 5, 6], smoothLines: [1, 2, 3], creaseDegrees: CREASE_DEGREES.tailgate },
] as const;

describe("given the lids as built", () => {
  for (const testCase of lidCreaseTable) {
    it(`when ${testCase.it} are read, then each turns its declared ${testCase.creaseDegrees}° or more at vertices of its own, and the dome or bow turns under ${FLAT_CURVE_LIMIT_DEGREES}° as one vertex`, () => {
      const style = CAR_STYLES[testCase.style];
      const lid = testCase.part === "bonnet" ? makeHoodGeometry(style) : makeTrunkGeometry(style);
      const loft = loftOf(lid);
      const inner = (slice: number) => slice > 0 && slice < loft.slices - 2;
      for (const line of testCase.creaseLines) {
        const angles = ringLineDihedrals(lid, line, inner);
        assert.ok(Math.min(...angles) >= testCase.creaseDegrees, `ring line ${line} turns only ${Math.min(...angles)}°`);
        for (let slice = 1; slice < loft.slices - 1; slice++) {
          assert.ok(verticesAtSamePlace(lid, slice * loft.ring + line) >= 2, `ring line ${line} slice ${slice} is one vertex: its crease is not split`);
        }
      }
      for (const line of testCase.smoothLines) {
        const angles = ringLineDihedrals(lid, line, inner);
        assert.ok(Math.max(...angles) < FLAT_CURVE_LIMIT_DEGREES, `ring line ${line} turns ${Math.max(...angles)}°`);
        for (let slice = 1; slice < loft.slices - 1; slice++) {
          assert.equal(verticesAtSamePlace(lid, slice * loft.ring + line), 1, `ring line ${line} slice ${slice} is split: its curve is not smooth`);
        }
      }
    });
  }
});

type PartCase = { readonly name: string; readonly make: (id: CarStyleId) => THREE.BufferGeometry; readonly creaseDegrees: number };
const partCases: readonly PartCase[] = [
  { name: "bonnet", make: (id) => makeHoodGeometry(CAR_STYLES[id]), creaseDegrees: CREASE_DEGREES.deckLid },
  { name: "boot", make: (id) => makeTrunkGeometry(CAR_STYLES[id]), creaseDegrees: CREASE_DEGREES.deckLid },
  { name: "left door", make: (id) => makeDoorGeometry(-1, CAR_STYLES[id]), creaseDegrees: CREASE_DEGREES.door },
  { name: "right door", make: (id) => makeDoorGeometry(1, CAR_STYLES[id]), creaseDegrees: CREASE_DEGREES.door },
  { name: "front bumper", make: (id) => makeBumperGeometry(true, CAR_STYLES[id]), creaseDegrees: CREASE_DEGREES.bumper },
  { name: "rear bumper", make: (id) => makeBumperGeometry(false, CAR_STYLES[id]), creaseDegrees: CREASE_DEGREES.bumper },
];

describe("given every part whose hard edges are declared, as built for every body style", () => {
  for (const id of CAR_STYLE_IDS) {
    for (const testCase of partCases) {
      it(`when a ${id} ${testCase.name}'s edges are read against its ${testCase.creaseDegrees}° crease, then every sharper edge has vertices of its own and every softer one shares them`, () => {
        const geometry = testCase.make(id);
        const census = censusOfEdges(geometry, testCase.creaseDegrees);
        assert.ok(census.sharpEdges > 0, `${id} ${testCase.name} has no sharp edge at all`);
        assert.equal(census.sharpEdgesStillShared, 0, `${id} ${testCase.name}: sharp edges still share vertices (${JSON.stringify(census)})`);
        assert.equal(census.smoothEdgesSplit, 0, `${id} ${testCase.name}: smooth edges were split (${JSON.stringify(census)})`);
      });
    }
  }
});

/** The loft's quads wind one way all round: a left-side quad one slice in from the tail (ring segment 3, the shoulder's lower chord) faces -x when outward. */
const REFERENCE_SLICE = 1;
const REFERENCE_SEGMENT = 3;

/** The outward unit normal of ring segment `segment`'s quad between slices `slice` and `slice + 1`, or null when degenerate (the winding is read off the reference quad, so a tub's inward-facing floor still reads as it faces). */
function outwardQuadNormal(geometry: THREE.BufferGeometry, loft: Loft, slice: number, segment: number): THREE.Vector3 | null {
  const normal = loftQuadNormal(geometry, loft, slice, segment);
  const reference = loftQuadNormal(geometry, loft, REFERENCE_SLICE, REFERENCE_SEGMENT);
  if (!normal || !reference) return null;
  return reference.x > 0 ? normal.negate() : normal;
}

/** Whether ring segment `segment` lies on the body's side (both its points between the shoulder rows and the feature line on one half): the deck and floor rows turn into a tub at the pickup's tail. */
function isSideSegment(loft: Loft, segment: number): boolean {
  const halfCount = (loft.ring - 1) / 2;
  const halfOf = (point: number) => (point < halfCount ? point : loft.ring - 1 - point);
  const [first, second] = [halfOf(segment), halfOf((segment + 1) % loft.ring)];
  return first >= SIDE_HALF_FIRST && first <= SIDE_HALF_LAST && second >= SIDE_HALF_FIRST && second <= SIDE_HALF_LAST;
}

describe("given every body style's chassis, whose nose and tail roll into the end faces", () => {
  for (const id of CAR_STYLE_IDS) {
    for (const end of ["tail", "nose"] as const) {
      it(`when a ${id}'s ${end} rows are read, then no row turns ${ROLLED_EDGE_LIMIT_DEGREES}° or more from the one before, nor does the last from the flat end face`, () => {
        const body = makeChassisGeometry(CAR_STYLES[id]);
        const loft = loftOf(body);
        const rows = end === "tail" ? Array.from({ length: END_SLICES }, (_, k) => k) : Array.from({ length: END_SLICES }, (_, k) => loft.slices - 1 - k);
        const endFaceNormal = new THREE.Vector3(0, 0, end === "tail" ? -1 : 1);
        for (let segment = 0; segment < loft.ring; segment++) {
          if (!isSideSegment(loft, segment)) continue;
          const normals = rows.map((row) => outwardQuadNormal(body, loft, end === "tail" ? row : row - 1, segment));
          const outermost = normals[0];
          if (outermost) assert.ok(angleBetweenDegrees(outermost, endFaceNormal) < ROLLED_EDGE_LIMIT_DEGREES, `${id} ${end} segment ${segment}: ${angleBetweenDegrees(outermost, endFaceNormal)}° from the end face`);
          for (let k = 1; k < normals.length; k++) {
            const [outer, inner] = [normals[k - 1], normals[k]];
            if (outer && inner) assert.ok(angleBetweenDegrees(outer, inner) < ROLLED_EDGE_LIMIT_DEGREES, `${id} ${end} segment ${segment} row ${k}: ${angleBetweenDegrees(outer, inner)}° between rows`);
          }
        }
      });
    }
  }
});

/** Of each side's greenhouse parts the B pillar and the rail are the near-rectangular ones (the A and C pillars lean in plan, so their section is a sheared parallelogram); the headers are the last two. */
const roundedPartCases = [
  { name: "B pillar", pick: (parts: THREE.BufferGeometry[]) => parts[1]! },
  { name: "side rail", pick: (parts: THREE.BufferGeometry[]) => parts[parts.length - 3]! },
  { name: "windshield header", pick: (parts: THREE.BufferGeometry[]) => parts[parts.length - 2]! },
  { name: "rear glass header", pick: (parts: THREE.BufferGeometry[]) => parts[parts.length - 1]! },
] as const;

describe("given every body style's greenhouse frame", () => {
  for (const id of CAR_STYLE_IDS) {
    for (const testCase of roundedPartCases) {
      it(`when a ${id}'s ${testCase.name} is read, then no lengthwise edge turns ${ROLLED_EDGE_LIMIT_DEGREES}° or more (the box's 90° corners are rolled)`, () => {
        const part = testCase.pick(makeGreenhouseFrame(CAR_STYLES[id]));
        const loft = loftOf(part);
        for (let line = 0; line < loft.ring; line++) {
          const angles = ringLineDihedrals(part, line);
          assert.ok(angles.length > 0 && Math.max(...angles) < ROLLED_EDGE_LIMIT_DEGREES, `${id} ${testCase.name} ring line ${line} turns ${Math.max(...angles)}°`);
        }
      });
    }
  }
});

// ---- (c) after a real crush ------------------------------------------------------------------------------------------------

/** A normal may point this far past square to the local outward direction (dot above the negative of this) and still read as outward after a wrinkled crush. */
const CRUSHED_OUTWARD_DOT_FLOOR = -0.2;
const CRUSH_SPEED_KPH = 64;

describe("given every body style crushed by a 64 km/h full-width wall hit, as the engine steps it", () => {
  for (const id of CAR_STYLE_IDS) {
    it(`when a ${id}'s body normals are read after the skin is written, then every normal is finite and unit length and none on the side or ends points into the hull`, () => {
      const car = new DeformableCar(paint(), new THREE.Scene(), null, id);
      car.deform.setMode("shape");
      runWall(CRUSH_SPEED_KPH, 1, "front", { car });
      car.flushDeferredSkin();
      car.updateSkin();
      const geometry = car.body.geometry;
      const normals = geometry.getAttribute("normal");
      for (let vertex = 0; vertex < normals.count; vertex++) {
        const length = Math.hypot(normals.getX(vertex), normals.getY(vertex), normals.getZ(vertex));
        assert.ok(Number.isFinite(length) && Math.abs(length - 1) < 1e-4, `${id} vertex ${vertex}: crushed normal length ${length}`);
      }
      for (const point of outerSidePoints(geometry, normals)) {
        assert.ok(point.normal.dot(point.outward) > CRUSHED_OUTWARD_DOT_FLOOR, `${id} vertex ${point.vertex}: crushed normal ${point.normal.dot(point.outward)} against outward`);
      }
    });
  }
});

// ---- (d) draw calls and cost -----------------------------------------------------------------------------------------------

/**
 * Measured on f3bd2074 (before the smoothing) by building every style's car: the visible meshes a car draws, the triangles they hold, and
 * the body mesh's vertices (what the skin writes each frame, so what its cost follows).
 */
const BASELINE_BY_STYLE = [
  { id: "sedan", drawCalls: 20, triangles: 5266, bodyVertices: 1587 },
  { id: "hatchback", drawCalls: 20, triangles: 5064, bodyVertices: 1587 },
  { id: "wagon", drawCalls: 20, triangles: 5088, bodyVertices: 1635 },
  { id: "coupe", drawCalls: 20, triangles: 5152, bodyVertices: 1530 },
  { id: "pickup", drawCalls: 20, triangles: 5026, bodyVertices: 1568 },
  { id: "police", drawCalls: 21, triangles: 5338, bodyVertices: 1587 },
] as const satisfies readonly { id: CarStyleId; drawCalls: number; triangles: number; bodyVertices: number }[];
/** The stated budget: a car's triangles at most 1.6 x the baseline. */
const TRIANGLE_BUDGET = 1.6;
/** The skin writes every body vertex each frame (its cost follows the count): the body at most 1.2 x the baseline's vertices, which measured 1.2 x the baseline's skin time at most. */
const BODY_VERTEX_BUDGET = 1.2;

describe("given every body style's car built whole", () => {
  for (const testCase of BASELINE_BY_STYLE) {
    it(`when a ${testCase.id} is built, then it draws ${testCase.drawCalls} meshes, under ${TRIANGLE_BUDGET} x its ${testCase.triangles} triangles, with a body under ${BODY_VERTEX_BUDGET} x its ${testCase.bodyVertices} vertices`, () => {
      const car = new DeformableCar(paint(), new THREE.Scene(), null, testCase.id);
      let drawCalls = 0;
      let triangles = 0;
      car.group.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        for (let ancestor: THREE.Object3D | null = object; ancestor; ancestor = ancestor.parent) if (ancestor.name === "deform-rig" || !ancestor.visible) return;
        drawCalls++;
        triangles += triangleCountOf(object.geometry);
      });
      assert.equal(drawCalls, testCase.drawCalls);
      assert.ok(triangles <= testCase.triangles * TRIANGLE_BUDGET, `${triangles} triangles against ${testCase.triangles * TRIANGLE_BUDGET}`);
      const bodyVertices = car.body.geometry.getAttribute("position").count;
      assert.ok(bodyVertices <= testCase.bodyVertices * BODY_VERTEX_BUDGET, `${bodyVertices} body vertices against ${testCase.bodyVertices * BODY_VERTEX_BUDGET}`);
    });
  }
});

// ---- (e) the panels still cut ----------------------------------------------------------------------------------------------

describe("given every body style's panels cut from its smoothed loft", () => {
  for (const id of CAR_STYLE_IDS) {
    it(`when a ${id}'s panels are cut, then all ${PANEL_NAMES.length} exist, none shares a triangle with another, and every triangle indexes the loft`, () => {
      const body = makeChassisGeometry(CAR_STYLES[id]);
      const loft = loftOf(body);
      const regions = panelRegions(CAR_STYLES[id], body);
      assert.equal(regions.length, PANEL_NAMES.length);
      const seen = new Set<string>();
      for (const region of regions) {
        assert.ok(region.verts.length > 20 && region.tris.count >= 30 * 3, `${id} ${region.name} has ${region.tris.count / 3} triangles`);
        for (let t = 0; t < region.tris.count; t += 3) {
          const key = [0, 1, 2].map((k) => region.tris.getX(t + k)).join(",");
          assert.ok(!seen.has(key), `${id}: triangle ${key} is in two panels (${region.name})`);
          assert.ok(region.tris.getX(t) < loft.ring * loft.slices, `${id} ${region.name}: a triangle outside the loft`);
          seen.add(key);
        }
      }
    });
  }
});

// ---- the sim is untouched --------------------------------------------------------------------------------------------------

/**
 * The scripted crash: a car of each body style driven into the jersey slab at this speed (`runWall`, the engine's own step and phase clock), and
 * the sha-256 of everything the sim holds of it afterwards (`snapshot()`: the masses, beams, sensors and clusters, plus every mass's
 * rest, local and world position and velocity). The expected values were produced on f3bd2074, before any smoothing, by hashing
 * `JSON.stringify({ snap: car.deform.snapshot(), raw: masses.map((m) => [m.rest, m.local, m.world, m.vel].map((v) => v.toArray())) })`.
 */
const SIM_CRASH_KPH = 48;
const SIM_DIGEST_BY_STYLE = [
  { id: "sedan", digest: "42909afed5b013778570c85034bc78f81e61c47cc96bcc2675210b57b6699d7a" },
  { id: "hatchback", digest: "42909afed5b013778570c85034bc78f81e61c47cc96bcc2675210b57b6699d7a" },
  { id: "wagon", digest: "42909afed5b013778570c85034bc78f81e61c47cc96bcc2675210b57b6699d7a" },
  { id: "coupe", digest: "4ace2c0f6b1b519e5e837f1cabb74c900203f5433898cd8246f2a0f7b8d47058" },
  { id: "pickup", digest: "e539bc70cbf2dcf6f7a74f9ff57f0b5649c6f018d51946e534069a20f968f56c" },
  { id: "police", digest: "12fb33c481b40c8b5e3386d942ac3c04476de00660bc454a307eefd09a092534" },
] as const satisfies readonly { id: CarStyleId; digest: string }[];

describe("given every body style crashed into the wall at 48 km/h by the engine's own step", () => {
  for (const testCase of SIM_DIGEST_BY_STYLE) {
    it(`when a ${testCase.id}'s masses, beams, sensors and clusters are hashed, then they equal the digest the unsmoothed build produced`, () => {
      const car = new DeformableCar(paint(), new THREE.Scene(), null, testCase.id);
      car.deform.setMode("shape");
      runWall(SIM_CRASH_KPH, 1, "front", { car });
      const snap = car.deform.snapshot();
      const raw = car.deform.masses.map((mass) => [mass.rest.toArray(), mass.local.toArray(), mass.world.toArray(), mass.vel.toArray()]);
      const digest = createHash("sha256").update(JSON.stringify({ snap, raw })).digest("hex");
      assertSameDigest(digest, testCase.digest, `${testCase.id} after a ${SIM_CRASH_KPH} km/h wall hit`);
    });
  }
});

/**
 * Every rest-only table `cageSourceOf` hands the cage (the cage mesh is decimated from them, so they fix the contact shape of every
 * hit, not only the scripted one), hashed as raw bytes in field order. The expected values were produced on f3bd2074 by this function.
 */
function cageSourceDigest(car: DeformableCar): string {
  const source = cageSourceOf(car);
  const fields = [
    source.rest, Uint32Array.from(source.index), source.group, source.skinN, source.skinXf, source.skinW, source.resJ, source.resW, source.resC,
    source.skinHub, source.infN, source.infCo, source.infUvw, source.massRest, source.restCo, source.panelOrigin, source.panelGlass,
    source.interiorRest, Uint32Array.from(source.interiorIndex), source.interiorMass, Uint32Array.of(source.panelCount, source.clusterCount),
  ];
  const hash = createHash("sha256");
  for (const field of fields) hash.update(new Uint8Array(field.buffer, field.byteOffset, field.byteLength));
  return hash.digest("hex");
}

const CAGE_SOURCE_DIGEST_BY_STYLE = [
  { id: "sedan", digest: "4ae75bdb39abd7c349d113090f4f008fb24761338c9b1f7aa924e6afc412c877" },
  { id: "hatchback", digest: "bcc7956e75badcdbc98e67102be5c1745fe1f5012e85fd528fec73b66a71d1d1" },
  { id: "wagon", digest: "f08c06be9bce985f9bda361f106402edbdb47280dd51d0a712ad2f80bb29e0bb" },
  { id: "coupe", digest: "f00cbbb9f895cd3cc5e1b958b3465c3ab7e4f7f75fc531dc06495cb8bc1e740b" },
  { id: "pickup", digest: "47e39536242da3c28e635cecb77f91bb814d1d2432b7ec395180e87d60890b73" },
  { id: "police", digest: "2fd08944adac0b0686a35a6a4c8c19848d3415e2932a41e1dcbbdc7e3d925057" },
] as const satisfies readonly { id: CarStyleId; digest: string }[];

describe("given every body style's cage source, the tables its collision cage is decimated from", () => {
  for (const testCase of CAGE_SOURCE_DIGEST_BY_STYLE) {
    it(`when a ${testCase.id}'s cage source is hashed, then it equals the digest of the unsmoothed build, so the smoothed mesh never moves a contact shape`, () => {
      const car = new DeformableCar(paint(), new THREE.Scene(), null, testCase.id);
      assertSameDigest(cageSourceDigest(car), testCase.digest, `${testCase.id} cage source`);
    });
  }
});

/** A drawn ring point may stand this far (m) outside the cage source's ring at the same station: rounding in the chord interpolation. The cage carries the ground, so a car resting on its flank sinks into it by whatever the drawn side stands proud. */
const HULL_SKIN_M = 0.001;
/** Spacing (m) of the stations the rings are compared at: finer than the slice spacing (7 to 13 cm), so a bump between two slices shows. */
const HULL_STATION_STEP_M = 0.02;

/** How far (m) `point` stands outside the closed polygon `ring`: 0 inside, else its distance to the nearest edge. */
function distanceOutsideRing(point: { x: number; y: number }, ring: readonly { x: number; y: number }[]): number {
  let inside = false;
  let nearest = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    if (a.y > point.y !== b.y > point.y && point.x < a.x + ((point.y - a.y) / (b.y - a.y)) * (b.x - a.x)) inside = !inside;
    const edge = new THREE.Vector2(b.x - a.x, b.y - a.y);
    const along = THREE.MathUtils.clamp(new THREE.Vector2(point.x - a.x, point.y - a.y).dot(edge) / (edge.lengthSq() || 1), 0, 1);
    nearest = Math.min(nearest, Math.hypot(point.x - a.x - edge.x * along, point.y - a.y - edge.y * along));
  }
  return inside ? 0 : nearest;
}

describe("given every body style's drawn rings beside the cage source's rings at the same stations", () => {
  for (const id of CAR_STYLE_IDS) {
    it(`when a ${id}'s drawn cross-sections are compared with the cage source's every ${HULL_STATION_STEP_M * 100} cm, then no drawn point stands outside the cage ring by more than the skin`, () => {
      const style = CAR_STYLES[id];
      const first = style.profile[0]!.z;
      const last = style.profile[style.profile.length - 1]!.z;
      let worstOutside = 0;
      let worstAt = first;
      for (let z = first + HULL_STATION_STEP_M; z < last; z += HULL_STATION_STEP_M) {
        const station = sampleSlice(z, style.profile);
        const cageRing = sectionPoints(station, style, "cage");
        for (const point of sectionPoints(station, style, "drawn")) {
          const outside = distanceOutsideRing(point, cageRing);
          if (outside > worstOutside) {
            worstOutside = outside;
            worstAt = z;
          }
        }
      }
      assert.ok(worstOutside <= HULL_SKIN_M, `${id}: a drawn ring point at z ${worstAt.toFixed(2)} stands ${(worstOutside * 100).toFixed(1)} cm outside the cage source's ring`);
    });
  }
});
