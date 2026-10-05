import { HAVANA } from "./tracks/havana.ts";

/**
 * A closed arena for the pursuit measurement (docs/SURVIVAL.md), not a course that ships: Havana's own plaza (the D ring, the lawn,
 * the hill, the monument) inside a square of its own stucco blocks, with nothing outside it (no boulevard, no traffic routes). The ring is the
 * course's only road, so every drop-in the pack makes is on it, inside the walls. The player starts on the ring's east straight
 * with the formation behind it, as on Havana's boulevard. Same engine, same pack, same busted and wreck rules; a player cannot leave.
 */
export const ARENA_HALF = 80;
/** The stucco block's side (m): the rim stands on the arena's edge, its inner faces at `ARENA_HALF`. */
const BLOCK = 12;

type Json = { props: { prefab: string; x: number; z: number }[]; along: { route?: string }[]; traffic: object; survival: { start: { x: number; z: number; yaw: number }; formation: { x: number; z: number; yaw: number }[] } };
const base = HAVANA as Json;

const rim: { prefab: string; x: number; z: number }[] = [];
for (let a = -ARENA_HALF - BLOCK / 2; a <= ARENA_HALF + BLOCK / 2 + 1e-6; a += BLOCK) {
  const edge = ARENA_HALF + BLOCK / 2;
  rim.push({ prefab: "stucco", x: a, z: -edge }, { prefab: "stucco", x: a, z: edge });
  if (Math.abs(a) < edge - 1e-6) rim.push({ prefab: "stucco", x: -edge, z: a }, { prefab: "stucco", x: edge, z: a });
}

/** Havana's start and formation, slid from the boulevard onto the ring's east straight (x = 55): the player at z = −2, the five cops 11 to 33 m behind it. */
const slide = base.survival.start.z;
export const ARENA: unknown = {
  ...base,
  id: "survival-arena",
  props: [...base.props.filter((p) => p.prefab !== "stucco"), ...rim],
  along: base.along.filter((a) => a.route === undefined),
  traffic: { count: 0, lanes: [], routes: [] },
  survival: {
    start: { x: 55, z: -2, yaw: Math.PI },
    formation: base.survival.formation.map((f) => ({ x: 55 + f.x, z: -2 + (f.z - slide), yaw: f.yaw })),
  },
};
