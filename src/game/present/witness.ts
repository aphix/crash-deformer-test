import * as THREE from "three";

/**
 * Slack (m) grown onto every tested sphere, on top of the caller's own radius: a roof shadow thrown into view, bloom
 * glow bleeding in, and the camera moving a little since the cone was read.
 */
const WITNESS_PAD = 1.5;

/**
 * How far (m) an effect's particles get from where they are spawned, for `Witness.sees`: sparks fly ≤ 4.6 m/s for
 * 0.63 s; debris ≤ 13 m/s over a 1.2 s hop; glass dots ≤ 5.5 m/s sideways for 2.2 s, shards riding the car; smoke
 * rises ≤ 2.2 m/s for 1.7 s and drifts (`engine-fx.ts`).
 */
export const FX_REACH = { sparks: 4, debris: 14, glass: 12, smoke: 6 } as const;

/**
 * "Could the camera be witnessing this?" The one broad test behind every cosmetic skip (docs/CODEMAPS/architecture.md,
 * frame flow). A sphere is witnessed when, grown by `WITNESS_PAD`, it touches the camera's view frustum (the far plane
 * is the draw distance). Walls, glass and every other occluder are ignored on purpose, so "no" is always safe to
 * act on and "yes" is only ever wrong about being drawn. It only reads the camera; the sim never asks it anything.
 */
export class Witness {
  /** Off: everything is witnessed (the A/B probes' "no cone at all" arm). */
  enabled = true;
  /** FX spawns `sees` has refused / allowed since the last reset of the counters (the probes read them). */
  skipped = 0;
  allowed = 0;
  /** FX gating only (not the skin LoD, which is mesh state and always catches up): off lets every spawn through. */
  gateFx = true;
  private readonly frustum = new THREE.Frustum();
  private readonly pv = new THREE.Matrix4();
  private aimed = false;

  /** Read the camera as it is now; call it again after the rigs have aimed: a decision is only as good as its last read. */
  aim(camera: THREE.Camera): void {
    camera.updateMatrixWorld();
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv);
    this.aimed = true;
  }

  /** True when the sphere (`center`, `radius`) may be in view. Before the first `aim`, or `enabled` off, everything is. */
  mayWitness(center: THREE.Vector3, radius: number): boolean {
    if (!this.aimed || !this.enabled) return true;
    const r = radius + WITNESS_PAD;
    const planes = this.frustum.planes;
    for (let i = 0; i < 6; i++) {
      const p = planes[i]!;
      if (p.normal.x * center.x + p.normal.y * center.y + p.normal.z * center.z + p.constant < -r) return false;
    }
    return true;
  }

  /** An FX spawn's gate: `mayWitness` of `reach` (m: how far its particles or glow get from `at`), always yes with `gateFx` off. */
  sees(at: THREE.Vector3, reach: number): boolean {
    if (!this.gateFx || this.mayWitness(at, reach)) {
      this.allowed++;
      return true;
    }
    this.skipped++;
    return false;
  }
}
