import * as THREE from "three";
import { PREFABS, type PrefabId } from "../world/catalog.ts";
import type { Ground } from "../world/ground.ts";
import type { Placed } from "../world/placements.ts";
import { prefabParts, type PrefabMaterials } from "./prefabs.ts";
import { GRAVITY } from "./track-mesh.ts";

/** Knock state: in place, flying / tumbling, knocked and at rest. */
const AT_REST = 0;
const FLYING = 1;
const DOWN = 2;

const _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Placement `p`'s standing matrix into `out`. */
function restMatrix(p: Placed, out: THREE.Matrix4): THREE.Matrix4 {
  return out.compose(_p.set(p.x, p.y, p.z), _q.setFromAxisAngle(_up, p.yaw), _s.set(p.sx, p.sy, p.sz));
}

/**
 * Placed props drawn, one InstancedMesh per part of each prefab, and the knockable ones flying off when a car knocks them
 * (`knock`): each tumbles and comes to rest on the ground, its matrix written into its prefab's meshes at its slot. A course's
 * (`TrackArt`) and the Lab's (`LabArt`) props.
 */
export class PropTumble {
  private readonly placed: readonly Placed[];
  private readonly ground: Ground;
  private readonly meshes: Partial<Record<PrefabId, THREE.InstancedMesh[]>> = {};
  /** Per placement: instance slot in its prefab's meshes. */
  private readonly slot: Int32Array;
  private readonly state: Uint8Array;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly spin: Float32Array;
  private readonly rot: Float32Array;
  /** Indices of flying props: [0, flyingCount). */
  private readonly flying: Int32Array;
  private flyingCount = 0;
  private readonly m4 = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly dq = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly sc = new THREE.Vector3();
  private readonly axis = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly identity = new THREE.Quaternion();

  /**
   * Each placement standing in its slot of its prefab's meshes (`prefabParts` in `mats`), coloured where `tint` says; `add` takes
   * each mesh as it is made (`shared`: its part's material when that is the scene's, else null). `ground` is where a knocked prop lands.
   */
  constructor(
    placed: readonly Placed[],
    ground: Ground,
    mats: PrefabMaterials,
    add: (mesh: THREE.InstancedMesh, id: PrefabId, shared: THREE.Material | null) => void,
    tint: (id: PrefabId, i: number, out: THREE.Color) => boolean = () => false,
  ) {
    this.placed = placed;
    this.ground = ground;
    const byPrefab: Partial<Record<PrefabId, number[]>> = {};
    for (const [idx, pl] of placed.entries()) (byPrefab[pl.prefab] ??= []).push(idx);
    this.slot = new Int32Array(placed.length);
    const col = new THREE.Color();
    for (const id of Object.keys(byPrefab) as PrefabId[]) {
      const list = byPrefab[id]!;
      this.meshes[id] = prefabParts(id, mats).map((part, pi) => {
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, list.length);
        // Knocked props leave the instances' original bounds.
        mesh.frustumCulled = PREFABS[id].body !== "knock";
        for (const [s, idx] of list.entries()) {
          this.slot[idx] = s;
          mesh.setMatrixAt(s, restMatrix(placed[idx]!, this.m4));
          if (pi === 0 && tint(id, idx, col)) mesh.setColorAt(s, col);
        }
        mesh.computeBoundingSphere();
        add(mesh, id, part.shared ? part.material : null);
        return mesh;
      });
    }
    this.state = new Uint8Array(placed.length);
    this.pos = new Float32Array(placed.length * 3);
    this.vel = new Float32Array(placed.length * 3);
    this.spin = new Float32Array(placed.length * 3);
    this.rot = new Float32Array(placed.length * 4);
    this.flying = new Int32Array(placed.length);
  }

  /** Send knockable prop `index` (into `placed`) flying with velocity (vx, vy, vz) m/s; it tumbles and comes to rest on the ground. */
  knock(index: number, vx: number, vy: number, vz: number): void {
    const p = this.placed[index]!;
    if (PREFABS[p.prefab].body !== "knock") return;
    const size = PREFABS[p.prefab].size;
    const i3 = index * 3;
    if (this.state[index] === AT_REST) {
      const hy = size[1] * p.sy * 0.5;
      this.pos[i3] = p.x;
      this.pos[i3 + 1] = p.y + hy;
      this.pos[i3 + 2] = p.z;
      this.q.setFromAxisAngle(this.up, p.yaw).toArray(this.rot, index * 4);
    }
    if (this.state[index] !== FLYING) this.flying[this.flyingCount++] = index;
    this.state[index] = FLYING;
    this.vel[i3] = vx;
    this.vel[i3 + 1] = vy;
    this.vel[i3 + 2] = vz;
    // Roll about the horizontal axis across the motion, plus a deterministic twist.
    const r = Math.max(0.3, size[1] * p.sy * 0.5);
    const twist = (Math.imul(index + 1, 2654435761) >>> 0) / 4294967296 - 0.5;
    this.spin[i3] = (vz / r) * 0.6;
    this.spin[i3 + 1] = twist * 6;
    this.spin[i3 + 2] = (-vx / r) * 0.6;
  }

  /** Animate knocked props (no allocation). */
  update(dt: number): void {
    if (this.flyingCount === 0 || dt <= 0) return;
    const { pos, vel, spin, rot, q, dq, m4 } = this;
    for (let f = 0; f < this.flyingCount; f++) {
      const i = this.flying[f]!;
      const p = this.placed[i]!;
      const size = PREFABS[p.prefab].size;
      const hx = size[0] * p.sx * 0.5;
      const hy = size[1] * p.sy * 0.5;
      const hz = size[2] * p.sz * 0.5;
      const i3 = i * 3;
      vel[i3 + 1]! -= GRAVITY * dt;
      pos[i3]! += vel[i3]! * dt;
      pos[i3 + 1]! += vel[i3 + 1]! * dt;
      pos[i3 + 2]! += vel[i3 + 2]! * dt;
      q.fromArray(rot, i * 4);
      const w = Math.hypot(spin[i3]!, spin[i3 + 1]!, spin[i3 + 2]!);
      if (w > 1e-6) {
        this.axis.set(spin[i3]! / w, spin[i3 + 1]! / w, spin[i3 + 2]! / w);
        q.premultiply(dq.setFromAxisAngle(this.axis, w * dt));
      }
      m4.makeRotationFromQuaternion(q);
      const e = m4.elements;
      // Lowest point of the oriented box below its centre.
      const reach = Math.abs(e[1]!) * hx + Math.abs(e[5]!) * hy + Math.abs(e[9]!) * hz;
      // The surface at or just above the prop's own level: a bridge deck only when it is on it.
      const floor = this.ground.heightAt(pos[i3]!, pos[i3 + 2]!, pos[i3 + 1]! - reach);
      if (pos[i3 + 1]! - reach <= floor) {
        pos[i3 + 1] = floor + reach;
        if (vel[i3 + 1]! < 0) vel[i3 + 1] = vel[i3 + 1]! < -1.5 ? -vel[i3 + 1]! * 0.3 : 0;
        const slide = Math.max(0, 1 - 3 * dt);
        vel[i3]! *= slide;
        vel[i3 + 2]! *= slide;
        const roll = Math.max(0, 1 - 4 * dt);
        spin[i3]! *= roll;
        spin[i3 + 1]! *= roll;
        spin[i3 + 2]! *= roll;
        // Settle onto the box face nearest to down.
        let best = 0;
        for (let a = 1; a < 3; a++) if (Math.abs(e[a * 4 + 1]!) > Math.abs(e[best * 4 + 1]!)) best = a;
        const sign = e[best * 4 + 1]! < 0 ? -1 : 1;
        this.axis.set(e[best * 4]! * sign, e[best * 4 + 1]! * sign, e[best * 4 + 2]! * sign);
        dq.setFromUnitVectors(this.axis, this.up);
        q.premultiply(dq.slerp(this.identity, 1 - Math.min(1, 5 * dt)));
        const v2 = vel[i3]! ** 2 + vel[i3 + 1]! ** 2 + vel[i3 + 2]! ** 2;
        if (v2 < 0.04 && w < 0.3) {
          this.state[i] = DOWN;
          this.flying[f] = this.flying[--this.flyingCount]!;
          f--;
        }
      }
      q.toArray(rot, i * 4);
      m4.makeRotationFromQuaternion(q);
      this.v.set(pos[i3]! - e[4]! * hy, pos[i3 + 1]! - e[5]! * hy, pos[i3 + 2]! - e[6]! * hy);
      m4.compose(this.v, q, this.sc.set(p.sx, p.sy, p.sz));
      const meshes = this.meshes[p.prefab]!;
      for (let k = 0; k < meshes.length; k++) {
        meshes[k]!.setMatrixAt(this.slot[i]!, m4);
        meshes[k]!.instanceMatrix.needsUpdate = true;
      }
    }
  }

  /** Every knocked prop back in place (a restart). */
  reset(): void {
    for (let i = 0; i < this.placed.length; i++) {
      if (this.state[i] === AT_REST) continue;
      this.state[i] = AT_REST;
      restMatrix(this.placed[i]!, this.m4);
      const meshes = this.meshes[this.placed[i]!.prefab]!;
      for (let k = 0; k < meshes.length; k++) {
        meshes[k]!.setMatrixAt(this.slot[i]!, this.m4);
        meshes[k]!.instanceMatrix.needsUpdate = true;
      }
    }
    this.flyingCount = 0;
  }
}
