/**
 * The Range minigames' shared numbers. A station is laid out in its own frame: +x is the throw direction, x = 0 the lip (the
 * long jump's jersey barrier, the high jump's and Ring Fling's ramp lip), z = 0 the lane's middle, y measured from the pad (world y = 0).
 */

export const MINIGAME_MODES = ["longJump", "highJump", "ringFling"] as const;
export type MinigameMode = (typeof MINIGAME_MODES)[number];

export const MODE_LABELS: Readonly<Record<MinigameMode, string>> = {
  longJump: "Long jump",
  highJump: "High jump",
  ringFling: "Ring Fling",
};

/** Throws in one Ring Fling set: the panel's stepper runs from `min` to `max`. */
export const THROWS_PER_SET = { default: 5, min: 1, max: 10 } as const;

/** Sim seconds the thrown driver must lie still before his throw counts as at rest. */
export const REST_HOLD = 1;

/** Height (m above the pad) of the landing floor past the lip: the pad's level. */
export const LANDING_HEIGHT = 0;

/** World (x, z) of each station's lip; every station throws along +x. The long jump's is the world origin: the jersey barrier stands there. */
export const STATION_ANCHORS: Readonly<Record<MinigameMode, { x: number; z: number }>> = {
  longJump: { x: 0, z: 0 },
  highJump: { x: 0, z: 90 },
  ringFling: { x: 0, z: 170 },
};

/** Stations keep within this many metres of their anchor's z. */
export const STATION_HALF_WIDTH = 12;

/** A parked car faces the throw direction: forward is (sin yaw, 0, cos yaw), so +x is a quarter turn. */
export const THROW_YAW = Math.PI / 2;

export const DEGREES_TO_RADIANS = Math.PI / 180;

/**
 * Every station starts the same: a flat pad (length along the throw), then a hill that falls `drop` m over `length` m (a
 * cosine ease, so it starts and ends level and the parked car sees at most 1.5 * drop / length of slope) into the flat run-up.
 * The long jump's drop is the rise of its incline instead (its floor is level with the pad at the barrier).
 */
export const START_HILL = { padLength: 6, drop: 3, length: 24 } as const;

/** Flat run-up (m) between the start hill's foot and the climb's foot, per mode. */
export const RUN_UP_LENGTH: Readonly<Record<MinigameMode, number>> = {
  longJump: 36,
  highJump: 40,
  ringFling: 30,
};

/** The climb's foot is an arc of this radius (m) blending the run-up into the incline: no tyre meets a crease. */
export const INCLINE_FOOT_RADIUS = 40;

/**
 * Long jump: the straight incline's pitch (deg) and horizontal length (m), then a crest arc of `crestRadius` m easing it into the level
 * (a car stays on a crest only while its speed squared over the radius is under gravity: 40 m/s needs more than 163 m), then the level
 * run of `flatTail` m (the car is flat when it meets the barrier).
 */
export const LONG_JUMP_INCLINE = { pitchDegrees: 7, length: 24, crestRadius: 180, flatTail: 5 } as const;

/** High jump: the kicker is one circular arc of `radius` m, tangent to the run-up, curving up to `lipPitchDegrees` at the lip. */
export const HIGH_JUMP_KICKER = { radius: 20, lipPitchDegrees: 60 } as const;

/**
 * Ring Fling: the incline (pitch, deg, and length, m, from the foot's arc to the hop's start) and the ball-hop: a quarter-wave
 * kick of `hopLength` m ending at the lip at its steepest. The hop's height is the machine's: 3.35 in on a 120 in lane.
 */
export const RING_FLING_LANE = {
  inclinePitchDegrees: 5,
  inclineLength: 32,
  hopLength: 4,
  machineHopInches: 3.35,
  machineLaneInches: 120,
} as const;

/** Behind the high jump's and Ring Fling's lip the floor falls away at this pitch (deg) down to the landing's level: the car drops behind the lip. */
export const LIP_BACK_FACE_PITCH_DEGREES = 60;
