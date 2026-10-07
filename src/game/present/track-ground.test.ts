import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { Track } from "../world/track.ts";
import { TRACKS } from "../world/tracks/index.ts";
import { type Mesher, RoadIndex, sections } from "./track-mesh.ts";
import { buildGroundLayers, TerrainBatch } from "./track-ground.ts";

/** A course's terrain as `TrackArt` draws it: the near mesh (chunk after chunk, then the far skirt) and the chunks. */
type Terrain = { near: Mesher; chunks: { coarse: Mesher; box: Float32Array; fineAt: Int32Array; coarseAt: Int32Array } };

function terrainOf(course: string): Terrain {
  const track = TRACKS.map((raw) => new Track(raw)).find((t) => t.id === course)!;
  const paths = track.paths();
  const terrain = buildGroundLayers(track, track.ground(), new RoadIndex(paths), paths, paths.map((p) => sections(p, 0)))[0]!;
  assert.equal(terrain.kind, "terrain");
  assert.ok(terrain.chunks, "the terrain is cut into chunks");
  return { near: terrain.m, chunks: terrain.chunks };
}

/** Sample offsets inside each 2 m grid cell: 1 mm past each grid line, and the middle. */
const OFFSETS = [0.001, 1, 1.999];
const CELL = 2;

/** Drawn heights on the sample grid, row by row (NaN where nothing is drawn). */
type Sampled = { y: Float32Array; nx: number; nz: number };

/** The chunks' ground sampled at `OFFSETS` in every 2 m cell: chunk c draws from its far mesh when `far(c)`, else from its near one. */
function sampleGround(t: Terrain, far: (chunk: number) => boolean): Sampled {
  const { box } = t.chunks;
  const chunks = box.length / 4;
  const x0 = box[0]!;
  const z0 = box[1]!;
  const nx = Math.round((box[(chunks - 1) * 4 + 2]! - x0) / CELL) * OFFSETS.length;
  const nz = Math.round((box[(chunks - 1) * 4 + 3]! - z0) / CELL) * OFFSETS.length;
  const y = new Float32Array(nx * nz).fill(NaN);
  const at = (s: number) => Math.floor(s / OFFSETS.length) * CELL + OFFSETS[s % OFFSETS.length]!;
  /** First sample at or past `v` m from the grid's origin. */
  const from = (v: number) => {
    let s = Math.max(0, Math.floor(v / CELL)) * OFFSETS.length;
    while (at(s) < v) s++;
    return s;
  };
  for (let c = 0; c < chunks; c++) {
    const { pos, idx } = far(c) ? t.chunks.coarse : t.near;
    const ranges = far(c) ? t.chunks.coarseAt : t.chunks.fineAt;
    for (let i = ranges[c * 2 + 1]!; i < ranges[c * 2 + 3]!; i += 3) {
      const a = idx[i]! * 3;
      const b = idx[i + 1]! * 3;
      const d = idx[i + 2]! * 3;
      const ax = pos[a]! - x0;
      const az = pos[a + 2]! - z0;
      const bx = pos[b]! - x0;
      const bz = pos[b + 2]! - z0;
      const dx = pos[d]! - x0;
      const dz = pos[d + 2]! - z0;
      const area = (bx - ax) * (dz - az) - (dx - ax) * (bz - az);
      for (let sz = from(Math.min(az, bz, dz)); sz < nz && at(sz) <= Math.max(az, bz, dz); sz++) {
        for (let sx = from(Math.min(ax, bx, dx)); sx < nx && at(sx) <= Math.max(ax, bx, dx); sx++) {
          const px = at(sx);
          const pz = at(sz);
          const wb = ((px - ax) * (dz - az) - (dx - ax) * (pz - az)) / area;
          const wd = ((bx - ax) * (pz - az) - (px - ax) * (bz - az)) / area;
          const wa = 1 - wb - wd;
          if (wa < -1e-9 || wb < -1e-9 || wd < -1e-9) continue;
          y[sz * nx + sx] = wa * pos[a + 1]! + wb * pos[b + 1]! + wd * pos[d + 1]!;
        }
      }
    }
  }
  return { y, nx, nz };
}

/** The largest height step (m) across a 2 m grid line, between the samples 1 mm either side of it. */
function largestStep(g: Sampled): number {
  let worst = 0;
  const last = OFFSETS.length - 1;
  for (let sz = 0; sz < g.nz; sz++) {
    for (let sx = last; sx + 1 < g.nx; sx += OFFSETS.length) {
      const step = Math.abs(g.y[sz * g.nx + sx]! - g.y[sz * g.nx + sx + 1]!);
      if (step > worst) worst = step;
    }
  }
  for (let sz = last; sz + 1 < g.nz; sz += OFFSETS.length) {
    for (let sx = 0; sx < g.nx; sx++) {
      const step = Math.abs(g.y[sz * g.nx + sx]! - g.y[(sz + 1) * g.nx + sx]!);
      if (step > worst) worst = step;
    }
  }
  return worst;
}

const courseCases = [
  { it: "the hilliest course", course: "dam-spine", fewerFarTrianglesPct: 20 },
  { it: "the second hilliest course", course: "four-count", fewerFarTrianglesPct: 30 },
  { it: "a course of cliff shelves", course: "razor-shelf", fewerFarTrianglesPct: 30 },
  { it: "a course with paved yards painted on its ground", course: "breaker-yard", fewerFarTrianglesPct: 45 },
] as const;

describe("given a course's terrain drawn in chunks, each with a near mesh and a coarser far mesh", () => {
  for (const testCase of courseCases) {
    describe(`given ${testCase.it} (${testCase.course})`, () => {
      const t = terrainOf(testCase.course);
      const { box } = t.chunks;
      const chunks = box.length / 4;
      // Chunks run row by row; the last column may be narrower.
      const columns = Math.ceil((box[(chunks - 1) * 4 + 2]! - box[0]!) / (box[2]! - box[0]!) - 1e-6);
      const near = sampleGround(t, () => false);

      it("when neighbouring chunks are drawn one near and one far (both ways round), then no crack opens: the ground's height agrees within 1 cm across every 2 m grid line", () => {
        assert.ok(largestStep(near) < 0.01, `near everywhere: a ${largestStep(near)} m step`);
        for (const parity of [0, 1]) {
          const step = largestStep(sampleGround(t, (c) => (Math.floor(c / columns) + (c % columns)) % 2 === parity));
          assert.ok(step < 0.01, `checkerboard ${parity}: a ${step} m step`);
        }
      });

      it(`when every chunk is drawn far, then the ground covers exactly the near ground, stays within 0.2 m of it, and has at least ${testCase.fewerFarTrianglesPct} % fewer triangles`, () => {
        const far = sampleGround(t, () => true);
        let uncovered = 0;
        let added = 0;
        let worst = 0;
        let compared = 0;
        for (let s = 0; s < near.y.length; s++) {
          const a = near.y[s]!;
          const b = far.y[s]!;
          if (Number.isNaN(a) !== Number.isNaN(b)) {
            if (Number.isNaN(b)) uncovered++;
            else added++;
            continue;
          }
          if (Number.isNaN(a)) continue;
          compared++;
          worst = Math.max(worst, Math.abs(a - b));
        }
        assert.ok(compared > 0, "ground was sampled");
        assert.equal(uncovered, 0, "far ground left a hole");
        assert.equal(added, 0, "far ground covers a hole the near ground leaves");
        assert.ok(worst <= 0.2 + 1e-4, `${worst} m from the near ground`);
        const nearTriangles = t.chunks.fineAt[chunks * 2 + 1]! / 3;
        const farTriangles = t.chunks.coarseAt[chunks * 2 + 1]! / 3;
        assert.ok(farTriangles <= nearTriangles * (1 - testCase.fewerFarTrianglesPct / 100), `${farTriangles} far triangles against ${nearTriangles} near`);
      });
    });
  }
});

describe("given a course's terrain batch (four-count)", () => {
  const t = terrainOf("four-count");
  const batch = new TerrainBatch(t.near, t.chunks, new THREE.MeshBasicMaterial());
  const camera = new THREE.PerspectiveCamera();
  const view = (x: number, z: number) => {
    camera.position.set(x, 3, z);
    camera.updateMatrixWorld(true);
    batch.view(camera);
  };
  /** Flat distance from (x, z) to drawn chunk k's nearest point. */
  const gap = (k: number, x: number, z: number) => {
    const b = batch.box;
    return Math.hypot(Math.max(b[k * 4]! - x, x - b[k * 4 + 2]!, 0), Math.max(b[k * 4 + 1]! - z, z - b[k * 4 + 3]!, 0));
  };

  it("when the camera stands on the course, then every chunk whose nearest point lies within 240 m draws near, and every other far", () => {
    const x = (batch.box[0]! + batch.box[batch.box.length - 2]!) / 2;
    const z = (batch.box[1]! + batch.box[batch.box.length - 1]!) / 2;
    view(x, z);
    let nearCount = 0;
    for (let k = 0; k < batch.far.length; k++) {
      assert.equal(batch.far[k], gap(k, x, z) > 240 ? 1 : 0, `chunk ${k} at ${gap(k, x, z)} m`);
      nearCount += 1 - batch.far[k]!;
    }
    assert.ok(nearCount > 0 && nearCount < batch.far.length, `${nearCount} of ${batch.far.length} near`);
  });

  it("when a far chunk's nearest point comes back to 230 m, then it stays far, and at 220 m it draws near again", () => {
    const z = (batch.box[1]! + batch.box[3]!) / 2;
    const edge = batch.box[2]!;
    view(edge + 300, z);
    assert.equal(batch.far[0], 1);
    view(edge + 230, z);
    assert.equal(batch.far[0], 1);
    view(edge + 220, z);
    assert.equal(batch.far[0], 0);
  });

  it("when the camera looks east from the middle of the course, then every chunk wholly behind it is left out, and the chunks straight ahead are drawn", () => {
    const x = (batch.box[0]! + batch.box[batch.box.length - 2]!) / 2;
    const z = (batch.box[1]! + batch.box[batch.box.length - 1]!) / 2;
    camera.position.set(x, 3, z);
    camera.lookAt(x + 100, 3, z);
    camera.updateMatrixWorld(true);
    batch.view(camera);
    let behind = 0;
    let ahead = 0;
    for (let k = 0; k < batch.far.length; k++) {
      const b = batch.box;
      if (b[k * 4 + 2]! < x) {
        behind++;
        assert.equal(batch.getVisibleAt(k), false, `chunk ${k} behind the camera`);
      } else if (b[k * 4]! > x && b[k * 4 + 1]! <= z && b[k * 4 + 3]! >= z) {
        ahead++;
        assert.equal(batch.getVisibleAt(k), true, `chunk ${k} straight ahead`);
      }
    }
    assert.ok(behind > 0 && ahead > 0, `${behind} chunks behind, ${ahead} straight ahead`);
  });
});
