import * as THREE from "three";
import { DISC_RADIUS, Ground, STEP_UP } from "../world/ground.ts";
import type { JerseyBarrier } from "./engine-props.ts";
import { BARRIER_HALF, BARRIER_TOP } from "../contact/sat.ts";
import { detSin, detCos } from "../kernel/physics-core.js";

/**
 * The fleet's jump ramps (owner's sketch): two wedges on the jersey slab's long axis, the high end against each
 * slab end and sloping down away from it. While they are on, this is the fleet's ground: `DISC_GROUND` plus the
 * wedges and the slab, so the disc itself stays bit-identical with them off. A wedge is one prism of the store
 * (`world/prism.ts`): its top is the plane of its face, its flanks and its back are the prism's sides. A point of a
 * tyre or the hull is on the face or in the wall by the one rule every solid answers by (`pointContact`): it is in
 * the wall when it came in by a side, on the top when it came down onto it or is within the step a tyre mounts.
 */
export const RAMP = { start: BARRIER_HALF.z + 0.04, len: 4.6, halfW: 1.5, top: 1.2 } as const;
const SLOPE = RAMP.top / RAMP.len;

export class FleetRamps extends Ground {
  readonly group = new THREE.Group();
  /** Unit slab axis (plan), from the slab's yaw. */
  private ax = 0;
  private az = 1;
  /** The slab while it is in the scene (placed at the same yaw): a prism of the store, so its top is ground and its sides are walls. */
  private slab: JerseyBarrier | null = null;
  private yaw = 0;
  /** The slab's prism, and the wedges': one each side of the slab (`place` turns them with the slab's yaw). */
  private readonly slabPrism: number;
  private readonly wedges: number[] = [];

  constructor(scene: THREE.Scene) {
    super();
    this.addPlane(0, -DISC_RADIUS, DISC_RADIUS, -DISC_RADIUS, DISC_RADIUS, STEP_UP, DISC_RADIUS);
    // The slab: its width is rewritten as it crumples, its place as it slides.
    this.slabPrism = this.addPrism({ x: 0, z: 0, yaw: 0, hx: BARRIER_HALF.x, hz: BARRIER_HALF.z, base: 0, top: BARRIER_TOP, id: 0, moves: true });
    // A wedge: the plan from the slab's end to its toe, its top rising toward the slab (the plane's slope runs along the prism's z, away from the high end).
    for (const side of [1, -1]) {
      this.wedges.push(this.addPrism({ x: 0, z: 0, yaw: 0, hx: RAMP.halfW, hz: RAMP.len / 2, base: 0, top: RAMP.top / 2, gw: -side * SLOPE, id: side > 0 ? 1 : 2, moves: true }));
    }
    const shape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(RAMP.len, 0), new THREE.Vector2(0, RAMP.top)]);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: RAMP.halfW * 2, bevelEnabled: false });
    geo.translate(0, 0, -RAMP.halfW);
    const mat = new THREE.MeshStandardMaterial({ color: 0xb08850, roughness: 0.85, metalness: 0.02 });
    for (const side of [1, -1]) {
      const m = new THREE.Mesh(geo, mat);
      // Local +x (up the run, away from the slab) along side × axis; the slab's yaw is added in `place`.
      m.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
      m.position.set(0, 0, side * RAMP.start);
      m.castShadow = true;
      m.receiveShadow = true;
      this.group.add(m);
    }
    this.group.visible = false;
    scene.add(this.group);
    this.place(0, null);
  }

  /** Line the wedges up on the slab's long axis (`JerseyBarrier.orient`'s yaw); `slab` while it is in the scene. */
  place(yaw: number, slab: JerseyBarrier | null): void {
    this.yaw = yaw;
    this.ax = detSin(yaw);
    this.az = detCos(yaw);
    this.group.rotation.y = yaw;
    this.slab = slab;
    // Each wedge's middle: half its length past the slab end's offset, along the slab's axis.
    const mid = RAMP.start + RAMP.len / 2;
    for (let k = 0; k < 2; k++) {
      const side = k === 0 ? 1 : -1;
      this.movePrism(this.wedges[k]!, side * this.ax * mid, side * this.az * mid, yaw, 0, 0);
    }
    this.sync();
  }

  /** The slab's prism as the slab is now (it crumples and slides), or nothing while it is out of the scene; call it once a step before the cars meet the ground. */
  sync(): void {
    const s = this.slab;
    if (!s) {
      this.disable(this.slabPrism);
      return;
    }
    this.resizePrism(this.slabPrism, s.hx(), BARRIER_HALF.z, 0, BARRIER_TOP);
    this.movePrism(this.slabPrism, s.group.position.x, s.group.position.z, this.yaw, s.vel.x, s.vel.z);
  }
}
