/**
 * The one layering rule for everything drawn flat on the ground. A layer sits on a LEVEL of a fixed stack and the level
 * sets its depth offset, so where two layers overlap the higher level draws in front at any distance, whatever their
 * heights. A depth offset unit is one depth-buffer step wherever it is, while the world gap that step spans grows with
 * the square of the distance, so a few centimetres of lift stop ordering layers a few dozen metres out.
 *
 * Bottom to top: the terrain (and the sandbox / derby floor), run-off, the paved roads (concrete, asphalt, cobble) with their
 * paint and kerbs, the looser roads (a dirt or gravel track, a grass or sand ford lies over the road it crosses), then the
 * scenes' decals (rings, lamp pools, the derby lip) and their glow. Every road ribbon lies `ROAD_LIFT` over the ground,
 * so crossing roads are coplanar and ordered by level alone. A mesh is one level (every road of one surface is one
 * mesh: where its parts overlap they look the same). `ground-overlap.test-util.ts` scans every course for overlaps this leaves
 * ambiguous.
 */
const GROUND_STACK = [
  "terrain",
  "runoff",
  "concrete",
  "asphalt",
  "cobble",
  "marking",
  "kerb",
  "dirt",
  "gravel",
  "grass",
  "sand",
  "decal",
  "glow",
] as const;
export type GroundLevel = (typeof GROUND_STACK)[number];

/** Depth-buffer steps between neighbouring levels (`ground-overlap.test-util.ts` wants `MIN_STEPS` left over a height error of one). */
const LEVEL_STEPS = 4;
/** How far behind the run-off the terrain is pushed (steps): it must lose to a ribbon whose lift a crest or a crease eats. */
const TERRAIN_BACK = 16;

/** `polygonOffsetUnits` of a level (+ = pushed away from the camera). Run-off is 0; each level above pulls forward. */
function levelUnits(level: GroundLevel): number {
  const i = GROUND_STACK.indexOf(level);
  return i === 0 ? TERRAIN_BACK : -LEVEL_STEPS * (i - 1);
}

const SLOPE: Partial<Record<GroundLevel, number>> = { terrain: 1, marking: -1, kerb: -1, decal: -1, glow: -1 };

/**
 * Material state of a level. The units order layers; the slope term (`polygonOffsetFactor`) pushes the terrain back and
 * pulls the thin paint, kerbs and decals forward at grazing angles, but the road ribbons take none: a whole road drawn
 * closer by it would creep over far cars' tyres.
 */
export function levelOffset(level: GroundLevel): { polygonOffset: true; polygonOffsetFactor: number; polygonOffsetUnits: number } {
  return { polygonOffset: true, polygonOffsetFactor: SLOPE[level] ?? 0, polygonOffsetUnits: levelUnits(level) };
}

/**
 * Height (m) a line layer lies over the floor: the hardware applies a depth offset to polygons only, so a grid of lines
 * keeps clear by height instead. 2.5 cm is 8 depth steps at the 80 m of the farthest orbit camera.
 */
export const LINE_LIFT = 0.025;
