import { before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { stubBrowser } from "../engine/engine-headless.test-util.ts";
import { levelOrder } from "../scenes/ground-stack.ts";
import { LANDING_HEIGHT, MINIGAME_MODES, STATION_ANCHORS, STATION_HALF_WIDTH, type MinigameMode } from "../scenes/minigame-constants.ts";
import { highJumpLayout } from "../scenes/minigame-high-jump.ts";
import { stationFrontX } from "../scenes/minigame-profile.ts";
import { RING_BACKSTOP, RING_BOARD_BOUNDS } from "../scenes/minigame-ring.ts";
import { HIGH_JUMP_DRAW_BUDGET, makeHighJumpArt } from "./high-jump-art.ts";
import { makeLongJumpArt } from "./long-jump-art.ts";
import { LANDING_FLOOR_PAST_END, LANDING_FLOOR_SIDE_MARGIN, LONG_JUMP_FLOOR_END_X, MINIGAME_ART_EXTRA_DRAW_BUDGET, MinigameArt } from "./minigame-art.ts";
import { SURFACE_DRAW_CALL_BUDGET } from "./minigame-surface-art.ts";
import { BOX_POSE_FLOATS } from "./ragdoll-boxes.ts";
import { makeRingFlingArt, RING_FLING_DRAW_BUDGET } from "./ring-fling-art.ts";

/** Made-up measurements (m): the layout's own functions turn them into posts, boards, net and boxes. */
const MEASURED = { apexHeight: 18, apexDistance: 14, landingDistance: 22 };
const LIP_Y = 7;
/** Two normalised quaternions that agree to ~1e-7 per component have a dot within ~1e-14 of 1: this bar is far looser than that and far tighter than any real turn. */
const QUATERNION_DOT_TOLERANCE = 1e-9;
const layout = highJumpLayout(MEASURED, LIP_Y);
/** Geometry and poses are f32: equal to within a few ulps of a value near 100. */
const FLOAT32_TOLERANCE = 1e-4;
const REBUILD_COUNT = 3;

function stationOf(art: MinigameArt, mode: MinigameMode): THREE.Object3D {
  const station = art.group.getObjectByName(`station:${mode}`);
  assert.ok(station, `the composer has a station group for ${mode}`);
  return station;
}

function descendantCount(root: THREE.Object3D): number {
  let count = 0;
  root.traverse(() => count++);
  return count;
}

function drawCalls(root: THREE.Object3D): number {
  let calls = 0;
  root.traverse((object) => {
    if (object instanceof THREE.Mesh) calls += Array.isArray(object.material) ? object.material.length : 1;
  });
  return calls;
}

function floorBounds(art: MinigameArt, mode: MinigameMode): THREE.Box3 {
  const floor = stationOf(art, mode).getObjectByName(`landing-floor:${mode}`);
  assert.ok(floor instanceof THREE.Mesh, `the ${mode} station has a landing floor`);
  floor.geometry.computeBoundingBox();
  return floor.geometry.boundingBox ?? assert.fail("the floor's geometry has bounds");
}

const ringFlingFloorEndX = RING_BOARD_BOUNDS.maxX + RING_BACKSTOP.distancePastBoard + RING_BACKSTOP.thickness + LANDING_FLOOR_PAST_END;

function builtArt(): MinigameArt {
  const art = new MinigameArt();
  art.setHighJumpLayout(layout, LIP_Y);
  return art;
}

describe("given the minigame stations' composer", () => {
  before(stubBrowser);

  it("when it is built, then it starts invisible, and each station group sits at its anchor's x and z on the ground", () => {
    const art = builtArt();
    assert.equal(art.group.visible, false);
    assert.equal(art.group.parent, null, "the engine adds it to a scene, not the composer");
    for (const mode of MINIGAME_MODES) {
      const station = stationOf(art, mode);
      assert.equal(station.position.x, STATION_ANCHORS[mode].x, `${mode} station x`);
      assert.equal(station.position.y, 0, `${mode} station y`);
      assert.equal(station.position.z, STATION_ANCHORS[mode].z, `${mode} station z`);
    }
    art.dispose();
  });

  it("when a mode is set, then exactly that mode's station shows, the boxes only with the High jump, and null hides the lot", () => {
    const art = builtArt();
    for (const shown of MINIGAME_MODES) {
      art.setMode(shown);
      assert.equal(art.group.visible, true);
      assert.equal(
        MINIGAME_MODES.filter((mode) => stationOf(art, mode).visible).join(","),
        shown,
        `only ${shown} shows`,
      );
      assert.equal(art.group.getObjectByName("cardboard-boxes")?.visible, shown === "highJump", `the boxes show with the High jump alone (mode ${shown})`);
    }
    art.setMode(null);
    assert.equal(art.group.visible, false);
    assert.deepEqual(
      MINIGAME_MODES.filter((mode) => stationOf(art, mode).visible),
      [],
    );
    assert.equal(art.group.getObjectByName("cardboard-boxes")?.visible, false);
    art.dispose();
  });

  it("when the High jump layout is set, then the returned boxes are the layout's placed at the High jump's anchor, in the layout's order", () => {
    const art = new MinigameArt();
    const placements = art.setHighJumpLayout(layout, LIP_Y);
    const anchor = STATION_ANCHORS.highJump;
    assert.equal(placements.length, layout.boxes.length);
    for (let boxIndex = 0; boxIndex < layout.boxes.length; boxIndex++) {
      const local = layout.boxes[boxIndex]!;
      const placed = placements[boxIndex]!;
      assert.equal(placed.x, local.x + anchor.x, `box ${boxIndex} x`);
      assert.equal(placed.y, local.y, `box ${boxIndex} y`);
      assert.equal(placed.z, local.z + anchor.z, `box ${boxIndex} z`);
      assert.equal(placed.yaw, local.yaw, `box ${boxIndex} yaw`);
      assert.equal(placed.width, local.width, `box ${boxIndex} width`);
      assert.equal(placed.height, local.height, `box ${boxIndex} height`);
      assert.equal(placed.depth, local.depth, `box ${boxIndex} depth`);
    }
    art.dispose();
  });

  it("when the High jump layout is rebuilt again and again, then its art replaces the old (the children stay as many, the old art is freed), never piling up", () => {
    const art = builtArt();
    const station = stationOf(art, "highJump");
    const childCount = station.children.length;
    const descendants = descendantCount(art.group);
    for (let rebuild = 0; rebuild < REBUILD_COUNT; rebuild++) {
      const oldGeometries: THREE.BufferGeometry[] = [];
      station.traverse((object) => {
        if (object instanceof THREE.Mesh && object.name !== "") oldGeometries.push(object.geometry);
      });
      const disposals = oldGeometries.map((geometry) => mock.method(geometry, "dispose"));
      art.setHighJumpLayout(layout, LIP_Y);
      assert.equal(station.children.length, childCount, `rebuild ${rebuild + 1}: child count`);
      assert.equal(descendantCount(art.group), descendants, `rebuild ${rebuild + 1}: descendant count`);
      assert.ok(
        disposals.every((spy) => spy.mock.callCount() >= 1),
        `rebuild ${rebuild + 1}: every old geometry freed`,
      );
    }
    art.dispose();
  });

  it("when the stations are built, then each landing floor is a flat plane at the landing's height from the surface's front to the throw's far end, a station's half width plus the margin either side, at the ground's terrain level", () => {
    const art = builtArt();
    const halfWidth = STATION_HALF_WIDTH + LANDING_FLOOR_SIDE_MARGIN;
    const expectedEnds = { longJump: LONG_JUMP_FLOOR_END_X, highJump: layout.netX + LANDING_FLOOR_PAST_END, ringFling: ringFlingFloorEndX };
    for (const mode of MINIGAME_MODES) {
      const bounds = floorBounds(art, mode);
      assert.ok(Math.abs(bounds.min.x - stationFrontX(mode)) < FLOAT32_TOLERANCE, `${mode} floor starts at the surface's front: ${bounds.min.x}`);
      assert.ok(Math.abs(bounds.max.x - expectedEnds[mode]) < FLOAT32_TOLERANCE, `${mode} floor ends at ${expectedEnds[mode]}: ${bounds.max.x}`);
      assert.ok(Math.abs(bounds.min.z + halfWidth) < FLOAT32_TOLERANCE && Math.abs(bounds.max.z - halfWidth) < FLOAT32_TOLERANCE, `${mode} floor spans z +-${halfWidth}`);
      assert.ok(Math.abs(bounds.min.y - LANDING_HEIGHT) < FLOAT32_TOLERANCE && Math.abs(bounds.max.y - LANDING_HEIGHT) < FLOAT32_TOLERANCE, `${mode} floor lies at y = ${LANDING_HEIGHT}`);
      const floor = stationOf(art, mode).getObjectByName(`landing-floor:${mode}`) as THREE.Mesh;
      assert.equal(floor.renderOrder, levelOrder("terrain"), `${mode} floor draws at the terrain level`);
    }
    art.dispose();
  });

  it("when a station is composed, then its draws stay within its art's own budget plus the composer's extra, the extra being what it adds to its art's factory output", () => {
    const art = builtArt();
    const ownBudgets = { longJump: SURFACE_DRAW_CALL_BUDGET, highJump: HIGH_JUMP_DRAW_BUDGET, ringFling: RING_FLING_DRAW_BUDGET };
    const factoryOutputs = { longJump: makeLongJumpArt(), highJump: makeHighJumpArt(layout, LIP_Y), ringFling: makeRingFlingArt() };
    for (const mode of MINIGAME_MODES) {
      const boxDraws = mode === "highJump" ? 1 : 0;
      const stationDraws = drawCalls(stationOf(art, mode)) + boxDraws;
      assert.ok(stationDraws <= ownBudgets[mode] + MINIGAME_ART_EXTRA_DRAW_BUDGET, `${mode} draws ${stationDraws}`);
      const added = stationDraws - drawCalls(factoryOutputs[mode]);
      assert.ok(added <= MINIGAME_ART_EXTRA_DRAW_BUDGET, `${mode}: the composer adds ${added} draws`);
    }
    art.dispose();
  });

  it("when poses are written, then the boxes' instance matrices equal the poses at the world origin, scaled to the layout's sizes", () => {
    const art = new MinigameArt();
    const placements = art.setHighJumpLayout(layout, LIP_Y);
    const poses = new Float32Array(placements.length * BOX_POSE_FLOATS);
    const turn = new THREE.Quaternion();
    for (let boxIndex = 0; boxIndex < placements.length; boxIndex++) {
      turn.setFromAxisAngle(new THREE.Vector3(1, boxIndex + 1, 2).normalize(), 0.3 * boxIndex);
      poses.set([5 + boxIndex, 0.5 + boxIndex / 10, STATION_ANCHORS.highJump.z - 3 + boxIndex / 3, turn.x, turn.y, turn.z, turn.w], boxIndex * BOX_POSE_FLOATS);
    }
    art.updateBoxes(poses, placements.length);
    const boxes = art.group.getObjectByName("cardboard-boxes") as THREE.InstancedMesh;
    assert.deepEqual(boxes.position.toArray(), [0, 0, 0], "the boxes' mesh stays at the world origin");
    assert.equal(boxes.parent, art.group, "not inside a station group (which sits at an anchor)");
    assert.equal(boxes.count, placements.length);
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    for (let boxIndex = 0; boxIndex < placements.length; boxIndex++) {
      boxes.getMatrixAt(boxIndex, matrix).decompose(position, rotation, scale);
      const pose = boxIndex * BOX_POSE_FLOATS;
      const placement = placements[boxIndex]!;
      assert.ok(position.distanceTo(new THREE.Vector3(poses[pose], poses[pose + 1], poses[pose + 2])) < FLOAT32_TOLERANCE, `box ${boxIndex} position ${position.toArray()}`);
      const expectedRotation = new THREE.Quaternion(poses[pose + 3], poses[pose + 4], poses[pose + 5], poses[pose + 6]).normalize();
      assert.ok(Math.abs(rotation.normalize().dot(expectedRotation)) > 1 - QUATERNION_DOT_TOLERANCE, `box ${boxIndex} rotation ${rotation.toArray()} vs ${expectedRotation.toArray()}`);
      assert.ok(scale.distanceTo(new THREE.Vector3(placement.width, placement.height, placement.depth)) < FLOAT32_TOLERANCE, `box ${boxIndex} size ${scale.toArray()}`);
    }
    art.dispose();
  });

  it("when it is disposed, then every geometry and every texture under its group (the boxes' too) is freed", () => {
    const art = builtArt();
    const geometries = new Set<THREE.BufferGeometry>();
    const textures = new Set<THREE.Texture>();
    art.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture) textures.add(value);
        }
      }
    });
    assert.ok(geometries.size > 0 && textures.size > 0, "there is something to free");
    const geometryDisposals = [...geometries].map((geometry) => ({ geometry, spy: mock.method(geometry, "dispose") }));
    const textureDisposals = [...textures].map((texture) => ({ texture, spy: mock.method(texture, "dispose") }));
    art.dispose();
    const liveGeometries = geometryDisposals.filter(({ spy }) => spy.mock.callCount() === 0).map(({ geometry }) => geometry.type + ":" + geometry.uuid);
    const liveTextures = textureDisposals.filter(({ spy }) => spy.mock.callCount() === 0).map(({ texture }) => texture.uuid);
    assert.deepEqual(liveGeometries, [], "no live geometry");
    assert.deepEqual(liveTextures, [], "no live texture");
  });
});
