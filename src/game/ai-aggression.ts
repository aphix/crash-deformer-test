/**
 * The aggression model every AI shares (race rivals, derby drivers). The field's slider is a
 * maximum: each rival rolls its own value in [0, max] (`fieldAggression`) and keeps it for a whole
 * campaign. `mood` turns that value and both cars' damage into "go for it" (> 0) or "keep clear" (< 0).
 */

function hash01(id: number, k: number): number {
  const x = Math.sin(id * 127.1 + k * 311.7 + 17.13) * 43758.5453;
  return x - Math.floor(x);
}

/** Rival `id`'s aggression in a field whose slider is `max`: uniform in [0, max], fixed by `seed`. */
export function fieldAggression(max: number, seed: number, id: number): number {
  const m = max < 0 ? 0 : max > 1 ? 1 : max;
  return m * hash01(id * 13 + seed * 7919, 3);
}

/**
 * How much a driver of `aggression` wants a fight with another car: > 0 attack, < 0 keep clear.
 * 0 never attacks (avoids every hit); 1 always does, whatever its own state; 0.5 attacks only a car
 * more wrecked than itself, and thinks twice the more wrecked it is. Damage: 0 mint … 1 dead.
 */
export function mood(aggression: number, selfDamage: number, otherDamage: number): number {
  if (aggression <= 0) return -1;
  return 2 * aggression - 1 + 0.8 * (otherDamage - selfDamage) - (1 - aggression) * selfDamage;
}
