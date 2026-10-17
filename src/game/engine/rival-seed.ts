/**
 * The seed car `slot`'s rival spray is drawn from, or null for a bare car. In a derby (`derby` non-null) every car is a rival keyed on the
 * round unless a seated netplay peer drives it; anywhere else the race decides (`RaceField.rivalSeed`).
 */
export function rivalSeedOf(
  slot: number,
  race: { rivalSeed(slot: number): number | null },
  derby: { round: number; seated: ReadonlySet<number> } | null,
): number | null {
  if (!derby) return race.rivalSeed(slot);
  return derby.seated.has(slot) ? null : derby.round;
}
