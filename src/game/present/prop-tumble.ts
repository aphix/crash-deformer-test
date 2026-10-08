import * as THREE from "three";
import { PREFABS, type PrefabId } from "../world/catalog.ts";
import type { Placed } from "../world/placements.ts";
import { prefabParts, type PrefabMaterials } from "./prefabs.ts";

const _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Placement `p`'s standing matrix into `out`. */
function restMatrix(p: Placed, out: THREE.Matrix4): THREE.Matrix4 {
  return out.compose(_p.set(p.x, p.y, p.z), _q.setFromAxisAngle(_up, p.yaw), _s.set(p.sx, p.sy, p.sz));
}

/**
 * Placed props drawn, one InstancedMesh per part of each prefab, each placement at its slot: standing where it was put, a
 * knocked one where the dummies' world has it tumbling (`RagdollSystem.knockProp` moves it, `place`). A course's
 * (`TrackArt`) and the Lab's (`LabArt`) props.
 */
export class PropTumble {
  private readonly placed: readonly Placed[];
  private readonly meshes: Partial<Record<PrefabId, THREE.InstancedMesh[]>> = {};
  /** Per placement: instance slot in its prefab's meshes. */
  private readonly slot: Int32Array;
  /** Per placement: drawn off its spot since the last `reset`. */
  private readonly moved: Uint8Array;
  private readonly m4 = new THREE.Matrix4();
  private readonly sc = new THREE.Vector3();

  /**
   * Each placement standing in its slot of its prefab's meshes (`prefabParts` in `mats`), coloured where `tint` says; `add` takes
   * each mesh as it is made (`shared`: its part's material when that is the scene's, else null).
   */
  constructor(
    placed: readonly Placed[],
    mats: PrefabMaterials,
    add: (mesh: THREE.InstancedMesh, id: PrefabId, shared: THREE.Material | null) => void,
    tint: (id: PrefabId, i: number, out: THREE.Color) => boolean = () => false,
  ) {
    this.placed = placed;
    const byPrefab: Partial<Record<PrefabId, number[]>> = {};
    for (const [idx, pl] of placed.entries()) (byPrefab[pl.prefab] ??= []).push(idx);
    this.slot = new Int32Array(placed.length);
    this.moved = new Uint8Array(placed.length);
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
  }

  /** Draw placement `index` with its base at `base`, turned `q` (no allocation). */
  place(index: number, base: THREE.Vector3, q: THREE.Quaternion): void {
    const p = this.placed[index]!;
    this.moved[index] = 1;
    this.write(index, this.m4.compose(base, q, this.sc.set(p.sx, p.sy, p.sz)));
  }

  /** Every prop drawn back in place (a restart). */
  reset(): void {
    for (let i = 0; i < this.placed.length; i++) {
      if (!this.moved[i]) continue;
      this.moved[i] = 0;
      this.write(i, restMatrix(this.placed[i]!, this.m4));
    }
  }

  private write(index: number, m: THREE.Matrix4): void {
    const meshes = this.meshes[this.placed[index]!.prefab]!;
    for (let k = 0; k < meshes.length; k++) {
      meshes[k]!.setMatrixAt(this.slot[index]!, m);
      meshes[k]!.instanceMatrix.needsUpdate = true;
    }
  }
}
