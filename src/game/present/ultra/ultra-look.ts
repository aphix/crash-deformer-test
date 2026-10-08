import type * as THREE from "three";
import type { SurfaceRole } from "./surface-tag.ts";

/**
 * The Ultra look's numbers. Sources of the idea: threejs-realistic-rendering (HDRI environment lighting, a shadow with a normal bias, PBR texture
 * sets, tone mapping with an exposure) built on the raster path; three-realtime-rt's ray-traced lighting cannot carry 32 deforming cars (docs/PERF_BENCH.md).
 */
export const LOOK = {
  /** `renderer.toneMappingExposure` while Ultra is on (the base look runs 1.45 under the studio env). */
  exposure: 1.45,
  /** Multiplier on the environment's day / night level (`WorldStage.envGain`). */
  envGain: 1,
  /** The sun's shadow: a map twice the base edge (the bias follows its texel: `setSunBias`) and a wider soft edge (texels). */
  shadow: { mapSize: 2048, radius: 3 },
  /** The photographs' normal-map strength and occlusion strength (1 is the scan as shot): the asphalt grit and concrete wear stay readable at chase distance. */
  normalScale: 2,
  aoIntensity: 2,
  /** `atan2(z, x)` of the sun's direction in `public/ultra/sky.hdr` (three's equirect convention): where its clamped sun disc sits. */
  skySunAzimuth: 0.6228,
} as const;

/** World metres one tile of each photographic set covers (Poly Haven's measured sizes). */
export const SURFACE_METRES: Readonly<Record<SurfaceRole, number>> = { asphalt: 2.08, concrete: 3, ground: 2.48 };

/**
 * The Y rotation (rad) `scene.environmentRotation` needs so the HDRI's sun disc lies on the same side as the sun light `sunDir`
 * (the sun's position less its target's). A material samples the environment at the inverse rotation of the world direction.
 */
export function envYaw(sunDir: THREE.Vector3): number {
  return LOOK.skySunAzimuth - Math.atan2(sunDir.z, sunDir.x);
}
