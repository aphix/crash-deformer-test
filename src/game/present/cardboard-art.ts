import * as THREE from "three";
import { canvasTexture } from "./lab-art.ts";
import { BOX_POSE_FLOATS, type BoxPlacement } from "./ragdoll-boxes.ts";

const CARDBOARD_TEXTURE_PX = 256;
const KRAFT_COLOR = "#b98f5a";
const FIBRE_COLOR = "rgba(90,60,25,0.12)";
const CORRUGATION_COLOR = "rgba(90,60,25,0.1)";
const TAPE_COLOR = "rgba(222,206,160,0.92)";
const TAPE_EDGE_COLOR = "rgba(120,100,60,0.5)";
const PRINT_COLOR = "rgba(52,34,16,0.55)";
/** Paper fibres: this many short streaks, placed by two coprime strides so they do not line up. */
const FIBRE_COUNT = 48;
const FIBRE_STRIDE = { x: 53, y: 97 } as const;
const CORRUGATION_PITCH_PX = 8;
const TAPE = { left: 114, width: 28 } as const;

/** Kraft board: fibre streaks and corrugation lines, a strip of tape down the middle, a few printed marks. */
function paintCardboard(context: CanvasRenderingContext2D): void {
  context.fillStyle = KRAFT_COLOR;
  context.fillRect(0, 0, CARDBOARD_TEXTURE_PX, CARDBOARD_TEXTURE_PX);
  context.fillStyle = CORRUGATION_COLOR;
  for (let line = 0; line < CARDBOARD_TEXTURE_PX / CORRUGATION_PITCH_PX; line++) context.fillRect(0, line * CORRUGATION_PITCH_PX, CARDBOARD_TEXTURE_PX, 1);
  context.fillStyle = FIBRE_COLOR;
  for (let fibre = 0; fibre < FIBRE_COUNT; fibre++) {
    context.fillRect((fibre * FIBRE_STRIDE.x) % CARDBOARD_TEXTURE_PX, (fibre * FIBRE_STRIDE.y) % CARDBOARD_TEXTURE_PX, 6 + (fibre % 5) * 4, 1 + (fibre % 3));
  }
  context.fillStyle = TAPE_COLOR;
  context.fillRect(TAPE.left, 0, TAPE.width, CARDBOARD_TEXTURE_PX);
  context.fillStyle = TAPE_EDGE_COLOR;
  context.fillRect(TAPE.left, 0, 1, CARDBOARD_TEXTURE_PX);
  context.fillRect(TAPE.left + TAPE.width, 0, 1, CARDBOARD_TEXTURE_PX);
  context.fillStyle = PRINT_COLOR;
  context.font = "bold 22px sans-serif";
  context.textAlign = "center";
  context.fillText("THIS SIDE UP", 56, 60);
  context.fillText("FRAGILE", 200, 200);
  context.fillText("\u2191\u2191", 56, 200);
}

/**
 * The dynamic box piles, drawn: one `InstancedMesh` (one draw) of a unit cube with kraft-board texture, each instance scaled to its
 * box's size (`setLayout`) and posed from the 7 floats `RagdollSystem.copyBoxPoses` gives (position xyz, rotation xyzw) in `update`.
 * Poses are world coordinates, so the mesh stays at the world origin.
 */
export class CardboardBoxes {
  readonly mesh: THREE.InstancedMesh;
  private sizes = new Float32Array(0);
  private readonly position = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly matrix = new THREE.Matrix4();

  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ map: canvasTexture(CARDBOARD_TEXTURE_PX, CARDBOARD_TEXTURE_PX, paintCardboard), roughness: 0.9 }),
      capacity,
    );
    this.mesh.name = "cardboard-boxes";
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    // Boxes tumble anywhere in the pile's lanes; the unit cube's own bounding sphere would cull the whole pile at the origin.
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
  }

  /** The boxes to draw, in the order of the poses `update` gets; nothing shows until the next `update`. */
  setLayout(boxes: readonly BoxPlacement[]): void {
    if (boxes.length > this.capacity) throw new RangeError(`${boxes.length} boxes exceed the capacity of ${this.capacity}`);
    this.sizes = new Float32Array(boxes.length * 3);
    for (let boxIndex = 0; boxIndex < boxes.length; boxIndex++) {
      const box = boxes[boxIndex]!;
      this.sizes.set([box.width, box.height, box.depth], boxIndex * 3);
    }
    this.mesh.count = 0;
  }

  /** Pose the first `count` boxes from `poses` (`BOX_POSE_FLOATS` each); the rest are not drawn. */
  update(poses: Float32Array, count: number): void {
    if (count * 3 > this.sizes.length) throw new RangeError(`${count} poses but the layout has ${this.sizes.length / 3} boxes`);
    if (poses.length < count * BOX_POSE_FLOATS) throw new RangeError(`${count} poses need ${count * BOX_POSE_FLOATS} floats, got ${poses.length}`);
    for (let boxIndex = 0; boxIndex < count; boxIndex++) {
      const pose = boxIndex * BOX_POSE_FLOATS;
      this.position.set(poses[pose]!, poses[pose + 1]!, poses[pose + 2]!);
      this.rotation.set(poses[pose + 3]!, poses[pose + 4]!, poses[pose + 5]!, poses[pose + 6]!);
      this.scale.set(this.sizes[boxIndex * 3]!, this.sizes[boxIndex * 3 + 1]!, this.sizes[boxIndex * 3 + 2]!);
      this.mesh.setMatrixAt(boxIndex, this.matrix.compose(this.position, this.rotation, this.scale));
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    const material = this.mesh.material as THREE.MeshStandardMaterial;
    material.map?.dispose();
    material.dispose();
    this.mesh.geometry.dispose();
    this.mesh.dispose();
  }
}
