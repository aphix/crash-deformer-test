import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { stubBrowser } from "../engine/engine-headless.test-util.ts";
import { CardboardBoxes } from "./cardboard-art.ts";
import { BOX_POSE_FLOATS, type BoxPlacement } from "./ragdoll-boxes.ts";

/** Poses are f32 and the instance matrices are f32 too: equal to within a few ulps of a value near 10. */
const FLOAT32_TOLERANCE = 1e-5;

const placements: readonly BoxPlacement[] = [
  { x: 0, y: 0, z: 0, yaw: 0, width: 0.9, height: 1.2, depth: 1.4 },
  { x: 0, y: 0, z: 0, yaw: 0, width: 1.4, height: 0.8, depth: 1 },
  { x: 0, y: 0, z: 0, yaw: 0, width: 1, height: 1, depth: 0.85 },
];
const tumbles = [new THREE.Vector3(1, 2, 3).normalize(), new THREE.Vector3(-3, 1, 0.5).normalize(), new THREE.Vector3(0, 0, 1)];
const spins = [1.1, 2.4, 0.3];
const centres = [new THREE.Vector3(10.5, 1.25, -3), new THREE.Vector3(12, 0.5, 2.25), new THREE.Vector3(14.75, 3, 0)];

/** What `RagdollSystem.copyBoxPoses` writes for the three boxes: position xyz then rotation xyzw each. */
function tumbledPoses(): Float32Array {
  const poses = new Float32Array(placements.length * BOX_POSE_FLOATS);
  for (let boxIndex = 0; boxIndex < placements.length; boxIndex++) {
    const rotation = new THREE.Quaternion().setFromAxisAngle(tumbles[boxIndex]!, spins[boxIndex]!);
    poses.set([...centres[boxIndex]!.toArray(), rotation.x, rotation.y, rotation.z, rotation.w], boxIndex * BOX_POSE_FLOATS);
  }
  return poses;
}

function drawnBox(boxes: CardboardBoxes, boxIndex: number) {
  const matrix = new THREE.Matrix4();
  boxes.mesh.getMatrixAt(boxIndex, matrix);
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, rotation, scale);
  return { position, rotation, scale };
}

describe("given the dynamic box piles' drawing", () => {
  before(stubBrowser);

  it("when it is built, then it is one instanced mesh of one material (one draw), its box textured and never frustum-culled", () => {
    const boxes = new CardboardBoxes(placements.length);
    assert.ok(boxes.mesh instanceof THREE.InstancedMesh);
    assert.equal(Array.isArray(boxes.mesh.material), false, "one material is one draw");
    assert.equal(boxes.mesh.instanceMatrix.count, placements.length, "one matrix slot per box of the capacity");
    assert.ok((boxes.mesh.material as THREE.MeshStandardMaterial).map, "the cardboard texture");
    assert.equal(boxes.mesh.frustumCulled, false, "the pile tumbles away from the unit cube's own bounding sphere");
    boxes.dispose();
  });

  it("when the poses of tumbled boxes are drawn, then each instance sits at its pose's position, turned by its pose's rotation, scaled to its placement's size", () => {
    const boxes = new CardboardBoxes(placements.length);
    boxes.setLayout(placements);
    boxes.update(tumbledPoses(), placements.length);
    for (let boxIndex = 0; boxIndex < placements.length; boxIndex++) {
      const drawn = drawnBox(boxes, boxIndex);
      const placement = placements[boxIndex]!;
      assert.ok(drawn.position.distanceTo(centres[boxIndex]!) < FLOAT32_TOLERANCE, `box ${boxIndex} position ${drawn.position.toArray()}`);
      const expectedRotation = new THREE.Quaternion().setFromAxisAngle(tumbles[boxIndex]!, spins[boxIndex]!);
      assert.ok(drawn.rotation.angleTo(expectedRotation) < FLOAT32_TOLERANCE, `box ${boxIndex} rotation is off by ${drawn.rotation.angleTo(expectedRotation)} rad`);
      assert.ok(drawn.scale.distanceTo(new THREE.Vector3(placement.width, placement.height, placement.depth)) < FLOAT32_TOLERANCE, `box ${boxIndex} size ${drawn.scale.toArray()}`);
    }
    boxes.dispose();
  });

  it("when fewer boxes than the layout are updated, then only that many are drawn, and a later full update draws them all", () => {
    const boxes = new CardboardBoxes(placements.length);
    boxes.setLayout(placements);
    assert.equal(boxes.mesh.count, 0, "nothing draws before the first update");
    boxes.update(tumbledPoses(), 2);
    assert.equal(boxes.mesh.count, 2);
    boxes.update(tumbledPoses(), placements.length);
    assert.equal(boxes.mesh.count, placements.length);
    boxes.dispose();
  });

  it("when a layout holds more boxes than the capacity, or an update more than the layout or the poses give, then it throws", () => {
    const boxes = new CardboardBoxes(placements.length);
    assert.throws(() => boxes.setLayout([...placements, placements[0]!]), RangeError);
    boxes.setLayout(placements);
    assert.throws(() => boxes.update(tumbledPoses(), placements.length + 1), RangeError, "more poses than boxes in the layout");
    assert.throws(() => boxes.update(new Float32Array(BOX_POSE_FLOATS), placements.length), RangeError, "poses too short");
    boxes.dispose();
  });
});
