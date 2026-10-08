import { describe, it } from "node:test";
import assert from "node:assert/strict";
import "../kernel/rapier-node.test-util.ts";
import { loadRapier } from "../kernel/rapier.ts";
import { colliderSolids, courseSolids } from "../present/ragdoll-solids.ts";
import { Mesher } from "../present/track-mesh.ts";
import { addWalls } from "../present/track-structures.ts";
import { PREFAB_IDS, PREFABS, type PrefabId } from "./catalog.ts";
import { BAND, gap, meshGap, prefabGap, triangles, type P3 } from "./collider-drawn.test-util.ts";
import { placeProps, propColliders } from "./placements.ts";
import { Track } from "./track.ts";
import { parseTrack } from "./track-schema.ts";
import { wallColliders } from "./track-sections.ts";
import { OFF_MENU, TRACKS } from "./tracks/index.ts";

/**
 * What a car meets is what is drawn, in both directions: a collider standing out of the drawn shape is a wall you hit in the
 * air ("out"), drawn shape standing out of its collider is a wall you drive into ("in"). Three things are held to the drawn
 * art: the race walls against `addWalls`' triangles on every course (`WALL_IN`: the notch a bend leaves at the far corner
 * between two boxes the miter fills; `WALL_OUT`: a level box's top over the drawn top at the low end of a climbing piece,
 * `WALL_STEP`), every solid and knock prop piece against the very geometry `prefabParts` draws (each kind's own `KIND_TOL`, both
 * ways; "out" only in the car band `BAND` over the prop's foot and never counting drawn parts under the ground, a piece's faces
 * inside the others of its prop, or a surface's own interior), and the cosmetic Rapier world's solids against the colliders the
 * cars meet (built from the same list, to the millimetre).
 */
const WALL_IN = 0.07;
const WALL_OUT = 0.13;
/** Rapier solids are built from the colliders themselves: only float noise may separate them. */
const SAME = 1e-9;

/**
 * The most (m) a kind's colliders stand off its drawn shape, either way: what the kind's pieces measure (`prefabGap`), up to the
 * next centimetre, and what bounds it. A kind with no entry is held to 0 until it has measured. What one more piece would buy,
 * measured: the tree's first crown step in two, 0.22 → 0.20 (the second step then limits); the rock's top ring in two, 0.36 →
 * 0.35; the palm's first drum in two, 0.29 → 0.21 (the second drum then limits); the monument's every arm in one more slice,
 * 0.26 → 0.19 for 45 more boxes.
 */
const KIND_TOL: Partial<Record<PrefabId, number>> = {
  // A cone's three stacked solids against its taper.
  cone: 0.08,
  // A circle round the drum's corners (the drawn drum has fewer sides).
  "tyre-stack": 0.09,
  // Straps and a frame proud of a box.
  "hay-bale": 0.02,
  crate: 0.03,
  // The jersey profile's slope against three steps.
  "barrier-block": 0.09,
  // An irregular dome against four rings: the top ring's corners.
  rock: 0.36,
  // A hexagonal crown's corners and flats against one circle per step, halfway between them.
  tree: 0.22,
  // A roof slab over its walls.
  building: 0.08,
  stucco: 0.08,
  grandstand: 0.01,
  billboard: 0.01,
  lamp: 0.02,
  // The star's arms in slices as wide as the arm is at its middle, and the five-sided spire in three circles.
  monument: 0.26,
  // The leaning trunk in three drums, each bounding its slice of the lean.
  palm: 0.29,
  wall: 0.03,
  dumpster: 0.09,
};

const COURSES = [...TRACKS, ...OFF_MENU].map((json) => ({ id: parseTrack(json).id, json }));

describe("given each course's drawn walls (`addWalls`) and its wall colliders (`wallColliders`)", () => {
  for (const course of COURSES) {
    const track = new Track(course.json);
    const pieces = wallColliders(track);
    const m = new Mesher();
    const ground = track.ground();
    for (const p of track.paths()) if (p.wallL.includes(1) || p.wallR.includes(1)) addWalls(m, p, ground, track.json.road.wallHeight);
    const tris = triangles(m.geometry(false));
    if (pieces.length === 0) continue;

    it(`when every vertex of the ${course.id} course's drawn walls is measured against the colliders, then none stands more than ${WALL_IN} m out of them`, () => {
      let worst = { d: 0, at: "" };
      for (let i = 0; i < tris.length; i += 3) {
        let d = Infinity;
        for (const c of pieces) if (Math.hypot(c.x - tris[i]!, c.z - tris[i + 2]!) < c.r + WALL_IN) d = Math.min(d, gap(c, tris[i]!, tris[i + 1]!, tris[i + 2]!));
        if (d !== Infinity && d > worst.d) worst = { d, at: `(${tris[i]!.toFixed(2)}, ${tris[i + 1]!.toFixed(2)}, ${tris[i + 2]!.toFixed(2)})` };
      }
      assert.ok(worst.d <= WALL_IN, `a drawn wall vertex at ${worst.at} is ${worst.d.toFixed(3)} m outside every collider`);
    });

    it(`when points over the faces of the ${course.id} course's wall colliders are measured against the drawn walls, then none stands more than ${WALL_OUT} m off them`, () => {
      let worst = { d: 0, at: "" };
      for (const [j, c] of pieces.entries()) {
        const sn = Math.sin(c.yaw);
        const cs = Math.cos(c.yaw);
        const at = (u: number, w: number, y: number): P3 => [c.x + u * cs + w * sn, y, c.z - u * sn + w * cs];
        // Both faces at three heights and the top's middle, over the piece's two ends and its middle.
        for (const w of [-c.hz, 0, c.hz]) {
          for (const [u, y] of [[-c.hx, c.base + 0.3], [-c.hx, (c.base + c.top) / 2], [-c.hx, c.top], [c.hx, c.base + 0.3], [c.hx, (c.base + c.top) / 2], [c.hx, c.top], [0, c.top]] as const) {
            const [x, yy, z] = at(u, w, y);
            const d = meshGap(tris, x, yy, z, WALL_OUT + 0.5);
            if (d > worst.d) worst = { d, at: `piece ${j} (${x.toFixed(2)}, ${yy.toFixed(2)}, ${z.toFixed(2)})` };
          }
        }
      }
      assert.ok(worst.d <= WALL_OUT, `a wall collider point at ${worst.at} is ${worst.d.toFixed(3)} m off the drawn wall`);
    });
  }
});

describe("given every solid and knock prefab at scale 1: the colliders the game meets, and the geometry `prefabParts` draws", () => {
  for (const id of PREFAB_IDS) {
    if (PREFABS[id].body === "none") continue;
    const { pieces, inward, outward } = prefabGap(id);
    const tol = KIND_TOL[id] ?? 0;

    it(`when the ${id}'s drawn points are measured against its ${pieces} collider pieces, then none stands more than ${tol} m out of them`, () => {
      assert.ok(inward.d <= tol, `the ${id} is drawn ${inward.d.toFixed(3)} m outside its colliders at ${inward.at}`);
    });

    it(`when points over the faces of the ${id}'s collider pieces, up to ${BAND} m, are measured against the drawn shape, then none stands more than ${tol} m off it`, () => {
      assert.ok(outward.d <= tol, `a ${id} collider point at ${outward.at} is ${outward.d.toFixed(3)} m off the drawn shape`);
    });
  }
});

describe("given the colliders the cars meet and the solids the cosmetic Rapier world builds from them", () => {
  for (const course of COURSES) {
    it(`when the ${course.id} course's Rapier solids are built, then each is the very box or cylinder of a wall piece or a prop piece, at its place`, async () => {
      const R = await loadRapier();
      const track = new Track(course.json);
      const placed = placeProps(track);
      const colliders = [...propColliders(placed).filter((c) => c.body === "solid"), ...wallColliders(track)];
      const solids = courseSolids(track, placed);
      assert.ok(solids.length >= colliders.length, `${solids.length} solids for ${colliders.length} colliders`);
      for (const [k, c] of colliders.entries()) {
        const desc = solids[k]!.make(R)!;
        const h = (c.top - c.base) / 2;
        const t = desc.translation;
        assert.ok(Math.abs(t.x - c.x) < SAME && Math.abs(t.y - (c.base + h)) < SAME && Math.abs(t.z - c.z) < SAME, `solid ${k} stands at (${t.x}, ${t.y}, ${t.z}), its collider at (${c.x}, ${c.base + h}, ${c.z})`);
        const s = desc.shape;
        if (c.kind === "circle") {
          assert.ok(s instanceof R.Cylinder, `solid ${k} is a cylinder`);
          assert.ok(Math.abs(s.radius - c.r) < SAME && Math.abs(s.halfHeight - h) < SAME, `solid ${k}: cylinder ${s.radius} × ${s.halfHeight}, collider ${c.r} × ${h}`);
        } else {
          assert.ok(s instanceof R.Cuboid, `solid ${k} is a box`);
          assert.ok(Math.abs(s.halfExtents.x - c.hx) < SAME && Math.abs(s.halfExtents.y - h) < SAME && Math.abs(s.halfExtents.z - c.hz) < SAME, `solid ${k}: box ${JSON.stringify(s.halfExtents)}, collider ${c.hx} × ${h} × ${c.hz}`);
          const turn = 2 * Math.atan2(desc.rotation.y, desc.rotation.w) - c.yaw;
          assert.ok(Math.abs(Math.sin(turn)) < 1e-6 && Math.cos(turn) > 0, `solid ${k} is turned ${turn} rad off its collider`);
        }
      }
    });
  }
});

describe("given the Rapier solids of a prop piece list", () => {
  it("when colliderSolids is given knock pieces, then it builds none of them (a knocked prop is a body of its own)", () => {
    const pieces = propColliders([{ prefab: "cone", x: 0, y: 0, z: 0, yaw: 0, sx: 1, sy: 1, sz: 1 }]);
    assert.equal(pieces.length, 3);
    assert.deepEqual(colliderSolids(pieces, []), []);
  });
});
