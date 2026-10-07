/** Names several scene files and their consumers share. */

/** The ground stack's levels that are not a road or terrain surface (`SURFACE`, world): `ground-stack.ts` lists every level in draw order. */
export const GROUND_LEVEL = {
  terrain: "terrain",
  deck: "deck",
  runoff: "runoff",
  marking: "marking",
  kerb: "kerb",
  decal: "decal",
  glow: "glow",
} as const;
