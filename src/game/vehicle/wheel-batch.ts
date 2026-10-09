import * as THREE from "three";
import { makeWheelGeometry, makeWheelGeometryFar, makeWheelMaterial, treadNormalMap } from "./car-materials.ts";
import { spokeSmear } from "./wheel-blur.ts";

/** An untinted wheel: the instance colour that leaves the tyre and the alloy as toned. */
const UNTINTED = new THREE.Color(1, 1, 1);

/** One instanced draw (and its shadow draw) of one wheel geometry: the wheels at one distance rung. */
class WheelLane {
  readonly mesh: THREE.InstancedMesh;
  /** Per instance: how smeared its spokes are drawn (`spokeSmear` of the turn since the last drawn frame). */
  private readonly blur: THREE.InstancedBufferAttribute;
  private readonly capacity: number;
  private n = 0;

  constructor(geo: THREE.BufferGeometry, capacity: number) {
    // Its own copy of the parts material (and shadow depth material): on the material the plain part meshes use,
    // three re-ran program selection (`getProgram`, an allocation) on every instanced ↔ plain switch, twice a frame.
    const mat = makeWheelMaterial();
    mat.normalMap = treadNormalMap();
    this.capacity = capacity;
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

  begin(): void {
    this.n = 0;
  }

  /** Whether another wheel fits. */
  get open(): boolean {
    return this.n < this.capacity;
  }

  add(world: THREE.Matrix4, smear: number, tint: THREE.Color): void {
    this.blur.setX(this.n, smear);
    this.mesh.setColorAt(this.n, tint);
    this.mesh.setMatrixAt(this.n++, world);
  }

  end(): void {
    const n = this.n;
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

/**
 * Every car's wheels (tyre, rim, hub) as two instanced draws plus their shadow draws: the full wheel for a car the
 * distance detail draws whole, the far wheel (`makeWheelGeometryFar`) for a car cut to its body. Cars keep a
 * bare Group per wheel as the transform that spins, steers, rides the hub and pops; `sync` copies
 * those world matrices in once the scene's matrices are current for the frame.
 */
export class WheelBatch {
  /** The full-detail wheels, then the far ones. */
  readonly meshes: readonly THREE.InstancedMesh[];
  private readonly near: WheelLane;
  private readonly far: WheelLane;
  /**
   * Each wheel's angle at its last change and the turn that change made: the turn between two drawn frames is what the
   * eye sees. A second `sync` in the same frame (a render pass per target) finds no change and keeps the step.
   */
  private readonly turn = new WeakMap<THREE.Object3D, { angle: number; step: number }>();

  constructor(capacity: number) {
    this.near = new WheelLane(makeWheelGeometry(), capacity);
    this.far = new WheelLane(makeWheelGeometryFar(), capacity);
    this.meshes = [this.near.mesh, this.far.mesh];
  }

  /** Pack the shown wheels of `cars` (world matrices must be current); a car `isFar` says the detail has cut gets the far wheel. */
  sync<C extends { readonly wheels: readonly THREE.Object3D[] }>(cars: readonly C[], isFar: (car: C) => boolean): void {
    this.near.begin();
    this.far.begin();
    for (const car of cars) {
      const lane = isFar(car) ? this.far : this.near;
      for (const w of car.wheels) {
        let shown = lane.open;
        for (let p: THREE.Object3D | null = w; p && shown; p = p.parent) shown = p.visible;
        let t = this.turn.get(w);
        if (!t) this.turn.set(w, (t = { angle: w.rotation.x, step: 0 }));
        if (w.rotation.x !== t.angle) {
          t.step = w.rotation.x - t.angle;
          t.angle = w.rotation.x;
        }
        if (shown) lane.add(w.matrixWorld, spokeSmear(t.step), (w.userData.rim as THREE.Color | undefined) ?? UNTINTED);
      }
    }
    this.near.end();
    this.far.end();
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
  }
}
