import * as THREE from "three";
import { PISTON, type PistonRig } from "./piston-rig.ts";

const HEAD_DEPTH = 0.16;
const ROD_RADIUS = 0.06;
const HOUSING_RADIUS = 0.17;
const HOUSING_LENGTH = 1.1;
/** Rod showing between the housing and the head at rest (m). */
const ROD_SHOW = 0.1;
const HEAD_COLOR = new THREE.Color(0x5d636b);
const SELECTED_COLOR = new THREE.Color(0xe8712a);

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _axis = new THREE.Vector3(0, 1, 0);

/**
 * The eight rams, instanced: housing, rod, steel head, honeycomb block and
 * stand are one draw each. Each ram lives in its axis frame (+Z inward).
 */
export class PistonBank {
  readonly group = new THREE.Group();
  private readonly housing: THREE.InstancedMesh;
  private readonly rod: THREE.InstancedMesh;
  private readonly head: THREE.InstancedMesh;
  private readonly honey: THREE.InstancedMesh;
  private readonly stand: THREE.InstancedMesh;
  private readonly yaw: Float32Array;
  private readonly meshes: THREE.InstancedMesh[];

  constructor(scene: THREE.Scene, rig: PistonRig) {
    const n = rig.heads.length;
    const box = new THREE.BoxGeometry(1, 1, 1);
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 18).rotateX(Math.PI / 2);
    const make = (geo: THREE.BufferGeometry, mat: THREE.Material): THREE.InstancedMesh => {
      const mesh = new THREE.InstancedMesh(geo, mat, n);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      return mesh;
    };
    this.housing = make(cyl, new THREE.MeshStandardMaterial({ color: 0xd9a21b, roughness: 0.5, metalness: 0.35 }));
    this.rod = make(cyl, new THREE.MeshStandardMaterial({ color: 0xd0d4da, roughness: 0.18, metalness: 0.95 }));
    this.head = make(box, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.7 }));
    this.honey = make(box, new THREE.MeshStandardMaterial({ color: 0xc9d1d6, roughness: 0.85, metalness: 0.25 }));
    this.stand = make(box, new THREE.MeshStandardMaterial({ color: 0x2c2f33, roughness: 0.8, metalness: 0.2 }));
    this.yaw = Float32Array.from(rig.heads, (h) => Math.atan2(h.nx, h.nz));
    for (let i = 0; i < n; i++) this.head.setColorAt(i, HEAD_COLOR);
    this.group.visible = false;
    this.meshes = [this.housing, this.rod, this.head, this.honey, this.stand];
    scene.add(this.group);
    this.sync(rig, 0);
  }

  /** Place one part: `along` is the centre along the ram's axis, sizes are full extents. */
  private put(mesh: THREE.InstancedMesh, i: number, ax: number, az: number, along: number, y: number, sx: number, sy: number, sz: number): void {
    _q.setFromAxisAngle(_axis, this.yaw[i]!);
    _pos.set(0, y, along).applyQuaternion(_q);
    _pos.x += ax;
    _pos.z += az;
    _scale.set(sx, sy, sz);
    mesh.setMatrixAt(i, _m.compose(_pos, _q, _scale));
  }

  sync(rig: PistonRig, selected: number): void {
    const honeyDepth = rig.honey;
    const w = rig.config.faceWidth;
    const hgt = rig.config.faceHeight;
    const y = PISTON.faceY;
    for (let i = 0; i < rig.heads.length; i++) {
      const h = rig.heads[i]!;
      const back = h.plate - HEAD_DEPTH;
      const housingFront = h.restPlate - HEAD_DEPTH - ROD_SHOW;
      const rodLen = Math.max(0.01, back - housingFront);
      const block = Math.max(0, honeyDepth - h.faceSet);
      this.put(this.head, i, h.ax, h.az, h.plate - HEAD_DEPTH * 0.5, y, w, hgt, HEAD_DEPTH);
      this.put(this.honey, i, h.ax, h.az, h.plate + block * 0.5, y, block > 0.004 ? w * 0.94 : 0, hgt * 0.94, Math.max(block, 1e-3));
      this.put(this.rod, i, h.ax, h.az, housingFront + rodLen * 0.5, y, ROD_RADIUS, ROD_RADIUS, rodLen);
      this.put(this.housing, i, h.ax, h.az, housingFront - HOUSING_LENGTH * 0.5, y, HOUSING_RADIUS, HOUSING_RADIUS, HOUSING_LENGTH);
      const standH = y - HOUSING_RADIUS;
      this.put(this.stand, i, h.ax, h.az, housingFront - HOUSING_LENGTH * 0.5, standH * 0.5, 0.24, standH, 0.6);
      this.head.setColorAt(i, i === selected ? SELECTED_COLOR : HEAD_COLOR);
    }
    for (const mesh of this.meshes) mesh.instanceMatrix.needsUpdate = true;
    if (this.head.instanceColor) this.head.instanceColor.needsUpdate = true;
  }
}
