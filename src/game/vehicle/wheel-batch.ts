import * as THREE from "three";
import { makeWheelGeometry, makeWheelMaterial, treadNormalMap } from "./car-materials.ts";
import { spokeSmear } from "./wheel-blur.ts";

/** An untinted wheel: the instance colour that leaves the tyre and the alloy as toned. */
const UNTINTED = new THREE.Color(1, 1, 1);

/**
 * Every car's wheels (tyre, rim, hub) as one instanced draw plus one shadow draw. Cars keep a
 * bare Group per wheel as the transform that spins, steers, rides the hub and pops; `sync` copies
 * those world matrices in once the scene's matrices are current for the frame.
 */
export class WheelBatch {
  readonly mesh: THREE.InstancedMesh;
  /** Per instance: how smeared its spokes are drawn (`spokeSmear` of the turn since the last drawn frame). */
  private readonly blur: THREE.InstancedBufferAttribute;
  /**
   * Each wheel's angle at its last change and the turn that change made: the turn between two drawn frames is what the
   * eye sees. A second `sync` in the same frame (a render pass per target) finds no change and keeps the step.
   */
  private readonly turn = new WeakMap<THREE.Object3D, { angle: number; step: number }>();

  constructor(capacity: number) {
    // Its own copy of the parts material (and shadow depth material): on the material the plain part meshes use,
    // three re-ran program selection (`getProgram`, an allocation) on every instanced ↔ plain switch, twice a frame.
    const mat = makeWheelMaterial();
    mat.normalMap = treadNormalMap();
    const geo = makeWheelGeometry();
    this.blur = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.blur.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("blur", this.blur);
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.customDepthMaterial = new THREE.MeshDepthMaterial();
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    // Instances span the pad and move every frame; a stale bound would cull live wheels.
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    // A player's rim colour (`userData.rim` on the wheel, `car-look.ts`) tints the instance: the alloy takes it, the black tyre stays black.
    this.mesh.setColorAt(0, UNTINTED);
    this.mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
  }

  /** Pack the shown wheels of `cars` (world matrices must be current). */
  sync(cars: readonly { readonly wheels: readonly THREE.Object3D[] }[]): void {
    const max = this.mesh.instanceMatrix.count;
    let n = 0;
    for (const car of cars) {
      for (const w of car.wheels) {
        let shown = n < max;
        for (let p: THREE.Object3D | null = w; p && shown; p = p.parent) shown = p.visible;
        let t = this.turn.get(w);
        if (!t) this.turn.set(w, (t = { angle: w.rotation.x, step: 0 }));
        if (w.rotation.x !== t.angle) {
          t.step = w.rotation.x - t.angle;
          t.angle = w.rotation.x;
        }
        if (shown) {
          this.blur.setX(n, spokeSmear(t.step));
          this.mesh.setColorAt(n, (w.userData.rim as THREE.Color | undefined) ?? UNTINTED);
          this.mesh.setMatrixAt(n++, w.matrixWorld);
        }
      }
    }
    this.mesh.count = n;
    const attr = this.mesh.instanceMatrix;
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, n * 16);
    attr.needsUpdate = true;
    this.blur.clearUpdateRanges();
    this.blur.addUpdateRange(0, n);
    this.blur.needsUpdate = true;
    const tint = this.mesh.instanceColor!;
    tint.clearUpdateRanges();
    tint.addUpdateRange(0, n * 3);
    tint.needsUpdate = true;
  }
}

