/** The scene picker's scenes (`CrashEngine.setScene`), and the values of the share URL's `scene=`. */
export const SCENE_IDS = ["fleet", "press", "pistons", "doors", "corkscrew", "stack", "derby", "race", "range", "survival"] as const;
export type SceneId = (typeof SCENE_IDS)[number];

/**
 * Scenes whose spawns roll random picks, drawn from the run's seed: the fleet's spots, speeds and balls, the
 * corkscrew car's speed, the derby's start bearing. The rest are fixed set-ups (the race rolls its own, unseeded).
 */
export const SEEDED_SCENES: Readonly<Partial<Record<SceneId, true>>> = { fleet: true, corkscrew: true, derby: true };

/** Single-player scenes: a netplay room (hosted or joined) cannot be in them, and a room's link never opens one. */
export const SOLO_SCENES: Readonly<Partial<Record<SceneId, true>>> = { survival: true };

/**
 * The fleet props (jersey barrier, ramp balls, jump ramps) a scene sets for itself. The user's own choice (`showBarrier`
 * ...) is never written by a scene: the scene's value is in force while it is the scene, the user's comes back with the
 * fleet. No entry: the user's choice stands.
 */
type FleetProps = { barrier: boolean; balls: boolean; ramps: boolean };
const NO_PROPS: FleetProps = { barrier: false, balls: false, ramps: false };
const SCENE_PROPS: Readonly<Partial<Record<SceneId, FleetProps>>> = {
  press: NO_PROPS,
  pistons: NO_PROPS,
  doors: NO_PROPS,
  corkscrew: NO_PROPS,
  stack: NO_PROPS,
  derby: NO_PROPS,
  race: NO_PROPS,
  survival: NO_PROPS,
  // The range's wall is the run's target.
  range: { barrier: true, balls: false, ramps: false },
};

/** Whether fleet prop `key` is up in `scene` when the user's choice for it is `user` (`CrashEngine.barrierUp`, `ballsUp`, `rampsUp`). */
export function fleetProp(scene: SceneId, key: keyof FleetProps, user: boolean): boolean {
  return SCENE_PROPS[scene]?.[key] ?? user;
}
