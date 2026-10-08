import { mulberry32 } from "../world/placements.ts";
import type { PersonPick } from "../match/look-data.ts";

/**
 * A driver's look: tee, trousers, hair, a cap (its colour, null for none), a moustache, and whether she is a woman.
 * Cosmetic only. A drawn driver is a pure function of (the race's look seed, the car's slot), through its own
 * `mulberry32` stream and never the sim's RNG, so sim digests do not move, and every peer, replay and highlight clip that
 * knows the seed draws the same driver; a player's own picks (`look-pick.ts`) then override fields of it.
 */
export type DriverLook = { woman: boolean; shirt: number; pants: number; hair: number; hat: number | null; mustache: boolean };

/** A drawn driver's trousers: FlatOut's jeans (sRGB). */
export const JEANS = 0x3a4d6d;

/** Chance a civilian driver is a woman (owner: rare, 1 in 10). */
export const WOMAN_RATE = 0.1;

/**
 * Tees (sRGB), picked to read against asphalt, sand and the cars' paint (no sand tans, no road greys, no skin tones):
 * red, orange, mustard, leaf green, teal, sky, royal blue, violet, pink, white, cream, charcoal, olive, maroon,
 * navy-grey, lilac.
 */
export const SHIRTS: readonly number[] = [
  0xc0392b, 0xe0762c, 0xe2b53a, 0x58a04e, 0x2a9d8f, 0x4aa3df, 0x3a63c9, 0x7b4fa6, 0xd9638a, 0xe9e9e2, 0xe3d9b8, 0x2f3238, 0x6b7a3a, 0x7a2a35, 0x3d5a80,
  0xb08ed6,
];

/** Natural hair (black to blond and grey, with ginger and auburn) and the odd dyed one (blue, pink): 2 of 18. */
export const HAIRS: readonly number[] = [
  0x18120f, 0x18120f, 0x2a1d15, 0x2a1d15, 0x3a2618, 0x3a2618, 0x5a3a22, 0x5a3a22, 0x7a4a2a, 0x8a3a20, 0xb5532a, 0xd2b062, 0xa88a50, 0xe3d4a0, 0x9a9a9a,
  0xcfcfcf, 0x2d6cdf, 0xff6fa8,
];

/** The look of the driver in car `slot` of the race with look seed `seed`. */
export function driverLook(seed: number, slot: number): DriverLook {
  const rand = mulberry32(Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(slot + 1, 0xc2b2ae35));
  // Draws in a fixed order, so adding a field later never moves the ones before it.
  const woman = rand() < WOMAN_RATE;
  const shirt = SHIRTS[Math.floor(rand() * SHIRTS.length)]!;
  const hair = HAIRS[Math.floor(rand() * HAIRS.length)]!;
  return { woman, shirt, pants: JEANS, hair, hat: null, mustache: false };
}

/** The driver `base` (his drawn look) with the player's picks over it. The cap and the moustache are the player's alone. */
export function pickedLook(base: DriverLook, pick: PersonPick): DriverLook {
  return {
    woman: pick.woman ?? base.woman,
    shirt: pick.shirt ?? base.shirt,
    pants: pick.pants ?? base.pants,
    hair: pick.hair ?? base.hair,
    hat: pick.hat,
    mustache: pick.mustache,
  };
}
