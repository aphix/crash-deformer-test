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
