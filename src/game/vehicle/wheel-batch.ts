import * as THREE from "three";
import { makeWheelGeometry, makeWheelGeometryFar, makeWheelMaterial, treadNormalMap } from "./car-materials.ts";
import type { DeformableCar } from "./car.ts";
import { spokeSmear } from "./wheel-blur.ts";

/** What the batch needs of a renderer: its shadow pass, which it wraps to show the shadow prisms to that pass alone. */
type ShadowPass = { readonly shadowMap: { render: THREE.WebGLShadowMap["render"] } };

/** An untinted wheel: the instance colour that leaves the tyre and the alloy as toned. */
const UNTINTED = new THREE.Color(1, 1, 1);

/** One instanced draw of one wheel geometry: the wheels at one distance rung. */
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
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
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

/** The shadow proxy's prism is twelve-sided, of equal area to the tyre's circle so the shadow keeps its size. */
const SHADOW_SIDES = 12;
/** Its circumradius (m): the tyre's crown radius (`TYRE_R`, 0.32) times √(π / 3), since a twelve-sided polygon's area is 3 R². */
const SHADOW_RADIUS = 0.32 * Math.sqrt(Math.PI / 3);
/** The tyre's width (m) between its shoulders (±0.112 on `TYRE_PROFILE`). */
const SHADOW_WIDTH = 0.224;

/**
 * Every car's wheels (tyre, rim, hub) as two instanced draws and one shadow draw: the full wheel for a car the
 * distance detail draws whole, the far wheel (`makeWheelGeometryFar`) for a car cut to its body. Cars keep a
 * bare Group per wheel as the transform that spins, steers, rides the hub and pops; `sync` copies
 * those world matrices in once the scene's matrices are current for the frame.
 *
 * The sun's shadow pass draws none of those two: it draws `shadow`, every wheel as a 48-triangle tyre prism (the shadow
 * of a wheel is its tyre's silhouette), shown to the pass alone by `attach`'s wrapper of `shadowMap.render`. The main
 * pass builds its draw list before the shadow pass runs, so a mesh that turns visible only for the shadow pass is not in it.
 */
export class WheelBatch {
  /** The full-detail wheels, the far ones, then the shadow prisms (shown to the shadow pass only). */
  readonly meshes: readonly THREE.InstancedMesh[];
  private readonly near: WheelLane;
  private readonly far: WheelLane;
  private readonly shadow: THREE.InstancedMesh;
  private readonly isFar: (car: DeformableCar) => boolean;
  private attached: ShadowPass | null = null;
  private detach: (() => void) | null = null;
  /**
   * Each wheel's angle at its last change and the turn that change made: the turn between two drawn frames is what the
   * eye sees. A second `sync` in the same frame (a render pass per target) finds no change and keeps the step.
   */
  private readonly turn = new WeakMap<THREE.Object3D, { angle: number; step: number }>();

  /** `isFar`: whether the distance detail has cut a car to its body (`CarDetail.isFar`): its wheels are drawn far wheels. */
  constructor(capacity: number, isFar: (car: DeformableCar) => boolean) {
    this.isFar = isFar;
    this.near = new WheelLane(makeWheelGeometry(), capacity);
    this.far = new WheelLane(makeWheelGeometryFar(), capacity);
    const prism = new THREE.CylinderGeometry(SHADOW_RADIUS, SHADOW_RADIUS, SHADOW_WIDTH, SHADOW_SIDES).rotateZ(Math.PI / 2);
    prism.deleteAttribute("normal");
    prism.deleteAttribute("uv");
    this.shadow = new THREE.InstancedMesh(prism, new THREE.MeshBasicMaterial(), capacity);
    this.shadow.customDepthMaterial = new THREE.MeshDepthMaterial();
    this.shadow.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shadow.castShadow = true;
    this.shadow.frustumCulled = false;
    this.shadow.visible = false;
    this.shadow.count = 0;
    this.meshes = [this.near.mesh, this.far.mesh, this.shadow];
  }

  /** Show the shadow prisms to `renderer`'s shadow pass and to nothing else. */
  private attach(renderer: ShadowPass): void {
    this.detach?.();
    this.attached = renderer;
    const map = renderer.shadowMap;
    const render = map.render;
    map.render = (lights, scene, camera) => {
      this.shadow.visible = true;
      try {
        render.call(map, lights, scene, camera);
      } finally {
        this.shadow.visible = false;
      }
    };
    this.detach = () => {
      map.render = render;
    };
  }

  /** Pack the shown wheels of `cars` (world matrices must be current); a car the detail has cut gets the far wheel. `renderer` is the one drawing: its shadow pass is hooked once. */
  sync(cars: readonly DeformableCar[], renderer: ShadowPass): void {
    if (this.attached !== renderer) this.attach(renderer);
    this.near.begin();
    this.far.begin();
    let shadows = 0;
    for (const car of cars) {
      const lane = this.isFar(car) ? this.far : this.near;
      for (const w of car.wheels) {
        let shown = lane.open;
        for (let p: THREE.Object3D | null = w; p && shown; p = p.parent) shown = p.visible;
        let t = this.turn.get(w);
        if (!t) this.turn.set(w, (t = { angle: w.rotation.x, step: 0 }));
        if (w.rotation.x !== t.angle) {
          t.step = w.rotation.x - t.angle;
          t.angle = w.rotation.x;
        }
        if (!shown) continue;
        lane.add(w.matrixWorld, spokeSmear(t.step), (w.userData.rim as THREE.Color | undefined) ?? UNTINTED);
        this.shadow.setMatrixAt(shadows++, w.matrixWorld);
      }
    }
    this.near.end();
    this.far.end();
    this.shadow.count = shadows;
    const attr = this.shadow.instanceMatrix;
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, shadows * 16);
    attr.needsUpdate = true;
  }

  dispose(): void {
    this.detach?.();
    this.attached = null;
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
  }
}
