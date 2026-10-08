import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { canvasTexture, cinderBlock, concrete } from "./lab-art.ts";
import { PARTS } from "./ragdoll-body.ts";
import { DummyMesh } from "./ragdoll-mesh.ts";
import { driverLook, type DriverLook } from "./driver-look.ts";
import type { SprayBitmap } from "./spray.ts";

/** The garage (m): the room's half width, its back wall, its height; where the driver stands; and what the camera circles. */
export const GARAGE = {
  halfW: 6,
  back: -5,
  height: 3.6,
  turntableR: 2.8,
  /** The driver stands here beside the car, facing +z (the same way as the car): his rest frame is this point's. */
  person: new THREE.Vector3(1.9, 0, 0.6),
  look: new THREE.Vector3(0.7, 0.8, 0.2),
  /** The driver the garage shows under the player's picks (a race draws his unpicked clothes from its own seed). */
  driver: driverLook(0, 0),
} as const;

/** One painted-block tile and one concrete slab (m), as the Lab's garage draws them. */
const BLOCK_TILE = 0.8;
const SLAB_TILE = 3;
const TURNTABLE_STEEL = 0x3d4147;

/**
 * The garage's set, drawn only: a concrete floor, painted block on the back and both side walls, a work light under the
 * ceiling, the car's turntable, and the player's driver standing beside it (`stand`).
 */
export class GarageArt {
  readonly group = new THREE.Group();
  readonly dummy = new DummyMesh(1);
  private readonly own: THREE.Texture[];

  constructor() {
    this.group.name = "garage";
    this.group.visible = false;
    const { halfW, back, height } = GARAGE;
    const blocks = canvasTexture(256, 256, cinderBlock);
    blocks.repeat.set((halfW * 2) / BLOCK_TILE, height / BLOCK_TILE);
    const sides = [
      new THREE.PlaneGeometry(halfW * 2, height).translate(0, height / 2, back),
      new THREE.PlaneGeometry(halfW * 2, height).rotateY(-Math.PI / 2).translate(halfW, height / 2, back + halfW),
      new THREE.PlaneGeometry(halfW * 2, height).rotateY(Math.PI / 2).translate(-halfW, height / 2, back + halfW),
    ];
    const walls = new THREE.Mesh(mergeGeometries(sides)!, new THREE.MeshStandardMaterial({ map: blocks, roughness: 0.95, metalness: 0 }));
    for (const g of sides) g.dispose();
    walls.receiveShadow = true;
    const slab = canvasTexture(512, 512, concrete);
    slab.repeat.set((halfW * 2) / SLAB_TILE, (halfW * 2) / SLAB_TILE);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(halfW * 2, halfW * 2).rotateX(-Math.PI / 2).translate(0, 0.002, back + halfW),
      new THREE.MeshStandardMaterial({ map: slab, roughness: 0.9, metalness: 0 }),
    );
    floor.receiveShadow = true;
    const turntable = new THREE.Mesh(
      new THREE.CylinderGeometry(GARAGE.turntableR, GARAGE.turntableR, 0.01, 48).translate(0, 0.005, 0),
      new THREE.MeshStandardMaterial({ color: TURNTABLE_STEEL, roughness: 0.5, metalness: 0.6 }),
    );
    turntable.receiveShadow = true;
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.06, 0.3).translate(0, height - 0.25, 0), new THREE.MeshBasicMaterial({ color: 0xfff6e0 }));
    this.dummy.castShadow = true;
    this.dummy.frustumCulled = false;
    this.group.add(walls, floor, turntable, lamp, this.dummy);
    this.own = [blocks, slab];
  }

  /** The player's driver standing beside the car in `look`, wearing `spray`. */
  stand(look: DriverLook, spray: SprayBitmap): void {
    this.dummy.dress(0, false, look);
    this.dummy.spray(0, spray);
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    for (const [k, part] of PARTS.entries()) this.dummy.pose(0, k, p.fromArray(part.c).add(GARAGE.person), q);
  }

  dispose(): void {
    this.group.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    });
    for (const t of this.own) t.dispose();
  }
}
