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

/** The Lab's preset ids (`LabPresetId`): `LAB_PRESETS` in lab.ts lists them in picker order, and the engine, the bench plan and the HUD name the one that is up. */
export const LAB_PRESET = { pad: "pad", wall: "wall", cards: "cards", glass: "glass" } as const;
/** The piston scene's shot a fresh rig and the HUD's piston panel both start at. */
export const PISTON_SHOT = { speedKph: 40, massKg: 1500, hopSeconds: 6.5 } as const;
/** Face-up: the car's up axis within about 25 degrees of vertical (`matrixWorld` Y component). */
export const UPRIGHT = 0.9;

/**
 * The derby arena every field plays in (`scenes/derby-ground.ts` builds it, `derby-arena.ts` draws it): one fixed size, a ring
 * wall of `wallPieces` flat boxes whose inner faces stand `radius` m from the middle, a 1 m ground grid reaching `gridHalf` m each way.
 * `spawnInset`: `layoutDerby`'s ring sits this far inside the wall.
 */
export const DERBY_ARENA = {
  radius: 38,
  wallThickness: 1,
  wallHeight: 10,
  wallPieces: 48,
  wallMitre: 0.3,
  gridHalf: 40,
  spawnInset: 5.2,
  packPitch: 8,
} as const;
