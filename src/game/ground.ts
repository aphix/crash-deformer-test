import type { SurfaceId } from "./race/catalog.ts";

/**
 * The world's ground: height, up-normal, grip and surface at a ground point (x, z).
 * Physics, wheels and FX read the active ground through `activeGround()`;
 * a race track swaps in its baked heightfield with `setGround` and restores
 * `FLAT_GROUND` (today's y = 0 asphalt plane, grip 1) when it leaves.
 */
export interface Ground {
  /** Surface height (m) at world (x, z). */
  heightAt(x: number, z: number): number;
  /** Writes the unit up-normal at (x, z) into `out` and returns it. */
  normalAt<T extends { x: number; y: number; z: number }>(x: number, z: number, out: T): T;
  /** Grip multiplier at (x, z): 1 = dry asphalt (today's μ), gravel ≈ 0.6, grass ≈ 0.5. */
  frictionAt(x: number, z: number): number;
  /** Surface material at (x, z) (`SURFACES` in race/catalog.ts has its grip, speed and colour). */
  surfaceAt(x: number, z: number): SurfaceId;
}

export const FLAT_GROUND: Ground = {
  heightAt: () => 0,
  normalAt: (_x, _z, out) => {
    out.x = 0;
    out.y = 1;
    out.z = 0;
    return out;
  },
  frictionAt: () => 1,
  surfaceAt: () => "asphalt",
};

let active: Ground = FLAT_GROUND;

export function activeGround(): Ground {
  return active;
}

/** `null` restores the flat plane. */
export function setGround(g: Ground | null): void {
  active = g ?? FLAT_GROUND;
}
