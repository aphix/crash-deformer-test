/** Names several world files and their consumers share. */

/** The ground surfaces a course names (`SURFACE_IDS` in catalog.ts lists them in table order). */
export const SURFACE = {
  asphalt: "asphalt",
  concrete: "concrete",
  cobble: "cobble",
  dirt: "dirt",
  gravel: "gravel",
  grass: "grass",
  sand: "sand",
} as const;

/** The prop and scenery ids a course places (`PrefabId`): `PREFAB_IDS` in catalog.ts lists them in table order, `present/prefabs.ts` draws each. */
export const PREFAB = {
  cone: "cone",
  tyreStack: "tyre-stack",
  hayBale: "hay-bale",
  crate: "crate",
  barrierBlock: "barrier-block",
  rock: "rock",
  tree: "tree",
  building: "building",
  grandstand: "grandstand",
  billboard: "billboard",
  lamp: "lamp",
  gantry: "gantry",
  chevron: "chevron",
  monument: "monument",
  stucco: "stucco",
  palm: "palm",
  wall: "wall",
  dumpster: "dumpster",
  obelisk: "obelisk",
  capitol: "capitol",
  marble: "marble",
  whiteHouse: "white-house",
  fountain: "fountain",
  fence: "fence",
  pool: "reflecting-pool",
  basin: "basin",
  lincoln: "lincoln",
  capitolPool: "capitol-pool",
  grantMemorial: "grant-memorial",
  peaceMonument: "peace-monument",
  garfieldMonument: "garfield-monument",
  flagpole: "flagpole",
} as const;

/**
 * Chevron signs at a shortcut junction that turns more than `CHEVRON_TURN` (rad): `placeProps` stands a run of `CHEVRON_RUN` boards, one
 * per `CHEVRON_GAP` m slot, at its mouth and at its rejoin. Guessed, tuned by eye: the owner's "> > > > >" at a near-90 degree split reads at the pace
 * the AI drives (18 m/s), where four boards are 18 m of line, a second of it.
 */
export const CHEVRON_RUN = 4;
export const CHEVRON_GAP = 6;
/** Slots a run tries to find its `CHEVRON_RUN` boards in: a cross street or a bridge takes a slot, rarely two. */
export const CHEVRON_SLOTS = 2 * CHEVRON_RUN;
/** A fork turning less than this (30 degrees) reads as the road bending on, so it gets no sign. Guessed. */
export const CHEVRON_TURN = Math.PI / 6;
/** Clear ground (m) between a run-off's outer edge and the nearest edge of a board: ten times the 0.1 m the intrusion bar allows, so a board never reads as on the run-off. Guessed. */
export const CHEVRON_STANDOFF = 1;

/** The campaign's course ids, the `id` of each `tracks/*.json` (`CAMPAIGN` in tracks/index.ts races them in order). */
export const TRACK_ID = {
  oval: "oval",
  rally: "rally",
  city: "city",
  stunt: "stunt",
  fourCount: "four-count",
  damSpine: "dam-spine",
  razorShelf: "razor-shelf",
  breakerYard: "breaker-yard",
  nationalMall: "national-mall",
} as const;

/** The id of the bench strip's generated course (`stripCourse`), also the `trackId` of its race program. */
export const BENCH_STRIP_ID = "bench";

/**
 * The speed (m/s) under which a body touching a solid is at rest on it: the face it leaves through is then the nearest (a
 * body moving faster leaves through the face it came in by, `exitFace`), and a wreck on a solid has stopped driving into it.
 */
export const SOLID_AT_REST = 0.2;

/**
 * The longest (s) a body can have been inside a solid by the face it entered through: a physics step is at most this long (the
 * frame accumulator's cap), so a point that is deeper than that much travel along a face's normal did not cross that face in
 * its last step, whatever its drift now says (a wreck settling into a flank drifts at a few cm/s, and walking that back along
 * its drift crosses a face metres away). It leaves through the nearest face instead, as a body at rest does.
 */
export const ENTRY_WINDOW = 0.05;
