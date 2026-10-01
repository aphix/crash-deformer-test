/**
 * The world's ground: height, up-normal and grip at a ground point (x, z).
 * Physics, wheels and FX read the active ground through `activeGround()`;
 * a race track swaps in its baked heightfield with `setGround` and restores
 * `FLAT_GROUND` (today's y = 0 plane, grip 1) when it leaves.
 */
export interface Ground {
  /** Surface height (m) at world (x, z). */
  heightAt(x: number, z: number): number;
  /** Writes the unit up-normal at (x, z) into `out` and returns it. */
  normalAt<T extends { x: number; y: number; z: number }>(x: number, z: number, out: T): T;
  /** Grip multiplier at (x, z): 1 = dry asphalt (today's μ), gravel ≈ 0.6, grass ≈ 0.5. */
  frictionAt(x: number, z: number): number;
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
};

let active: Ground = FLAT_GROUND;

export function activeGround(): Ground {
  return active;
}

/** `null` restores the flat plane. */
export function setGround(g: Ground | null): void {
  active = g ?? FLAT_GROUND;
}
