import * as THREE from "three";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { splitCreases } from "./car-crease.ts";
import { assertSameNumbers } from "./test-support.ts";

const RAD_PER_DEGREE = Math.PI / 180;
/** The crease angle the rows split at: between the two folds below, so one is hard and the other smooth. */
const CREASE_DEGREES = 30;
const HARD_FOLD_DEGREES = 90;
const SOFT_FOLD_DEGREES = 10;
/** The strip is 1 m wide and each quad 1 m long; the soft strip starts this far along x so the strips share no vertex. */
const SOFT_STRIP_OFFSET_X = 10;
const VERTICES_PER_COLUMN = 2;
const COLUMNS_PER_STRIP = 3;

type Fold = { readonly name: string; readonly point: THREE.Vector3; readonly expectedIdsAtFold: number };

/** Two quads side by side (a strip of three vertex columns, each two vertices tall) whose second quad turns `foldDegrees` about the middle column, all faces wound to point the same way. */
function addFoldedStrip(positions: number[], indices: number[], foldDegrees: number, offsetX: number): THREE.Vector3 {
  const first = positions.length / 3;
  const foldColumn = new THREE.Vector3(offsetX + 1, 0, 0);
  const columns = [new THREE.Vector3(offsetX, 0, 0), foldColumn, foldColumn.clone().add(new THREE.Vector3(Math.cos(foldDegrees * RAD_PER_DEGREE), 0, Math.sin(foldDegrees * RAD_PER_DEGREE)))];
  for (const column of columns) positions.push(column.x, 0, column.z, column.x, 1, column.z);
  for (let quad = 0; quad < COLUMNS_PER_STRIP - 1; quad++) {
    const [v0, v1, v2, v3] = [0, 1, 2, 3].map((k) => first + quad * VERTICES_PER_COLUMN + k);
    indices.push(v0!, v2!, v1!, v1!, v2!, v3!);
  }
  return foldColumn;
}

function twoFoldedStrips(): { geometry: THREE.BufferGeometry; folds: Fold[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  const hardPoint = addFoldedStrip(positions, indices, HARD_FOLD_DEGREES, 0);
  const softPoint = addFoldedStrip(positions, indices, SOFT_FOLD_DEGREES, SOFT_STRIP_OFFSET_X);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const sheetCoordinates = Array.from({ length: positions.length / 3 }, (_, vertex) => [positions[vertex * 3]!, positions[vertex * 3 + 1]!]).flat();
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(sheetCoordinates, 2));
  geometry.setIndex(indices);
  return {
    geometry,
    folds: [
      { name: `${HARD_FOLD_DEGREES}-degree fold`, point: hardPoint, expectedIdsAtFold: 2 },
      { name: `${SOFT_FOLD_DEGREES}-degree fold`, point: softPoint, expectedIdsAtFold: 1 },
    ],
  };
}

/** Ids of the vertices sitting exactly on the line over `point` (its x and z, any y). */
function idsOnFold(geometry: THREE.BufferGeometry, point: THREE.Vector3, y: number): number[] {
  const position = geometry.getAttribute("position");
  const ids: number[] = [];
  for (let vertex = 0; vertex < position.count; vertex++) {
    if (position.getX(vertex) === Math.fround(point.x) && position.getY(vertex) === y && position.getZ(vertex) === Math.fround(point.z)) ids.push(vertex);
  }
  return ids;
}

describe("given two strips of two quads, one folded 90 degrees and one folded 10 degrees", () => {
  const { geometry: unsplit, folds } = twoFoldedStrips();
  const vertexCountBefore = unsplit.getAttribute("position").count;
  const split = splitCreases(unsplit, CREASE_DEGREES);

  it("when split at 30 degrees, then only the 90-degree fold's two edge vertices are copied", () => {
    assert.equal(split.getAttribute("position").count, vertexCountBefore + VERTICES_PER_COLUMN);
  });

  for (const fold of folds) {
    for (const y of [0, 1]) {
      it(`when split at 30 degrees, then the ${fold.name} has ${fold.expectedIdsAtFold} vertex(es) at its y = ${y} end`, () => {
        assert.equal(idsOnFold(split, fold.point, y).length, fold.expectedIdsAtFold);
      });
    }
  }

  it("when split at 30 degrees, then the copies sit exactly where their originals do and carry the same uv", () => {
    const ids = idsOnFold(split, folds[0]!.point, 0);
    const position = split.getAttribute("position");
    const uv = split.getAttribute("uv");
    assertSameNumbers(position.array.slice(ids[1]! * 3, ids[1]! * 3 + 3), position.array.slice(ids[0]! * 3, ids[0]! * 3 + 3), "copied position");
    assertSameNumbers(uv.array.slice(ids[1]! * 2, ids[1]! * 2 + 2), uv.array.slice(ids[0]! * 2, ids[0]! * 2 + 2), "copied uv");
  });

  it("when split at 30 degrees, then the 90-degree fold's two normals are unit length and point 90 degrees apart", () => {
    const [low, high] = idsOnFold(split, folds[0]!.point, 0);
    const normal = split.getAttribute("normal");
    const lowNormal = new THREE.Vector3().fromBufferAttribute(normal, low!);
    const highNormal = new THREE.Vector3().fromBufferAttribute(normal, high!);
    assert.ok(Math.abs(lowNormal.length() - 1) < 1e-6 && Math.abs(highNormal.length() - 1) < 1e-6, `the two normals are ${lowNormal.length()} and ${highNormal.length()} long`);
    assert.ok(Math.abs(lowNormal.dot(highNormal)) < 1e-6, `the two normals have dot ${lowNormal.dot(highNormal)}, not 0`);
  });

  it("when split at 30 degrees, then the 10-degree fold's one normal lies between its two faces' normals, off each by under the fold's 10 degrees", () => {
    const [only] = idsOnFold(split, folds[1]!.point, 0);
    const normal = new THREE.Vector3().fromBufferAttribute(split.getAttribute("normal"), only!);
    const firstQuadNormal = new THREE.Vector3(0, 0, 1);
    const secondQuadNormal = new THREE.Vector3(-Math.sin(SOFT_FOLD_DEGREES * RAD_PER_DEGREE), 0, Math.cos(SOFT_FOLD_DEGREES * RAD_PER_DEGREE));
    const offFirstDegrees = Math.acos(normal.dot(firstQuadNormal)) / RAD_PER_DEGREE;
    const offSecondDegrees = Math.acos(normal.dot(secondQuadNormal)) / RAD_PER_DEGREE;
    assert.ok(offFirstDegrees > 1e-3 && offSecondDegrees > 1e-3, `the shared normal is ${offFirstDegrees} / ${offSecondDegrees} degrees off the faces: it is one face's, not an average`);
    assert.ok(Math.abs(offFirstDegrees + offSecondDegrees - SOFT_FOLD_DEGREES) < 1e-3, `the shared normal is ${offFirstDegrees} + ${offSecondDegrees} degrees off the two faces, not between them`);
  });
});

describe("given a flat sheet with no crease at all", () => {
  it("when split at 30 degrees, then no vertex is copied and the normals are the sheet's", () => {
    const sheet = new THREE.PlaneGeometry(1, 1, 3, 3);
    const before = sheet.getAttribute("position").count;
    const split = splitCreases(sheet, CREASE_DEGREES);
    assert.equal(split.getAttribute("position").count, before);
    assertSameNumbers(split.getAttribute("normal").array.slice(0, 3), [0, 0, 1], "plane normal", 1e-6);
  });
});
