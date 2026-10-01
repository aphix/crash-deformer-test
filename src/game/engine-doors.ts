import * as THREE from "three";
import { RAM, type DoorRig } from "./door-rig.ts";

const HEAD = 0;
const POST = 1;
const RAIL = 2;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();

/** The door scene's ram: head, its post and the floor rail of its lane in one instanced draw. */
export class DoorRam {
  readonly group = new THREE.Group();
  private readonly mesh: THREE.InstancedMesh;

  constructor(scene: THREE.Scene) {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.45 });
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, 3);
    this.mesh.setColorAt(HEAD, new THREE.Color(0xe8a21b));
    this.mesh.setColorAt(POST, new THREE.Color(0x5d636b));
    this.mesh.setColorAt(RAIL, new THREE.Color(0x2c2f33));
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
    this.group.visible = false;
    scene.add(this.group);
  }

  private put(i: number, x: number, y: number, z: number, sx: number, sy: number, sz: number): void {
    this.mesh.setMatrixAt(i, _m.compose(_pos.set(x, y, z), _q, _scale.set(sx, sy, sz)));
  }

  sync(rig: DoorRig): void {
    const lane = rig.lane;
    rig.centre(_pos);
    const { x, z } = _pos;
    this.put(HEAD, x, (lane.bottom + lane.top) * 0.5, z, lane.width, lane.top - lane.bottom, RAM.length);
    this.put(POST, x, lane.bottom * 0.5, z, 0.1, lane.bottom, 0.1);
    // Rail from the start of the run to its end, under the head's line.
    const from = -lane.dir * (RAM.start + RAM.length);
    const to = lane.dir * RAM.end;
    this.put(RAIL, x, 0.015, (from + to) * 0.5, 0.16, 0.03, Math.abs(to - from));
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
