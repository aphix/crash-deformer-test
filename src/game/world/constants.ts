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
