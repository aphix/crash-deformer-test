/** The scene picker's scenes (`CrashEngine.setScene`), and the values of the share URL's `scene=`. */
export const SCENE_IDS = ["fleet", "press", "pistons", "doors", "corkscrew", "derby", "race", "range", "survival"] as const;
export type SceneId = (typeof SCENE_IDS)[number];

/**
 * Scenes whose spawns roll random picks, drawn from the run's seed: the fleet's spots, speeds and balls, the
 * corkscrew car's speed, the derby's start bearing. The rest are fixed set-ups (the race rolls its own, unseeded).
 */
export const SEEDED_SCENES: Readonly<Partial<Record<SceneId, true>>> = { fleet: true, corkscrew: true, derby: true };

/** Single-player scenes: a netplay room (hosted or joined) cannot be in them, and a room's link never opens one. */
export const SOLO_SCENES: Readonly<Partial<Record<SceneId, true>>> = { survival: true };
