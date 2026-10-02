import type { SurfaceId } from "./race/catalog.ts";

/**
 * The world's ground: height, up-normal, grip and surface at a ground point (x, z).
 * Physics, wheels and FX read the active ground through `activeGround()`;
 * a race track swaps in its baked heightfield with `setGround` and restores
 * `FLAT_GROUND` (today's y = 0 asphalt plane, grip 1) when it leaves.
 *
 * Where roads cross (a bridge over a road) there are two surfaces at one (x, z). Every query
 * takes the asking body's current height `y`: the answer is the highest surface at most
 * `STEP_UP` above it, so a car under a bridge sees the road and a car on it sees the deck.
 * Omitting `y` answers for the top surface.
 */
export interface Ground {
  /** Surface height (m) at world (x, z). */
  heightAt(x: number, z: number, y?: number): number;
  /** Writes the unit up-normal at (x, z) into `out` and returns it. */
  normalAt<T extends { x: number; y: number; z: number }>(x: number, z: number, out: T, y?: number): T;
  /** Grip multiplier at (x, z): 1 = dry asphalt (today's μ), gravel ≈ 0.6, grass ≈ 0.5. */
  frictionAt(x: number, z: number, y?: number): number;
  /** Surface material at (x, z) (`SURFACES` in race/catalog.ts has its grip, speed and colour). */
  surfaceAt(x: number, z: number, y?: number): SurfaceId;
}

/** A surface this far (m) above a body still counts as under it (kerbs, ramp lips, a wreck's dropped hub). */
export const STEP_UP = 1.2;

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
