import { detAtan, detCos, detSin } from "../kernel/physics-core.js";
import {
  DEGREES_TO_RADIANS,
  HIGH_JUMP_KICKER,
  INCLINE_FOOT_RADIUS,
  LANDING_HEIGHT,
  LIP_BACK_FACE_PITCH_DEGREES,
  LONG_JUMP_INCLINE,
  RING_FLING_LANE,
  RUN_UP_LENGTH,
  START_HILL,
  THROW_YAW,
  type MinigameMode,
} from "./minigame-constants.ts";

/**
 * The floor of each station along its run, the same for every z. From the back: the flat start pad at y = 0, the start hill
 * down to the run-up, the flat run-up, then the climb to the lip at x = 0. Past the long jump's lip (its barrier) the floor is the
 * landing's level; the high jump's and Ring Fling's fall away behind the lip down to it.
 */

/** A climb's foot arc (a circle of `INCLINE_FOOT_RADIUS` tangent to the run-up, up to `pitch`) and the straight incline after it. */
type InclineSection = { sin: number; cos: number; slope: number; arcRun: number; arcRise: number; straightEnd: number };

function inclineSection(pitch: number, straightLength: number): InclineSection {
  const sin = detSin(pitch);
  const cos = detCos(pitch);
  const arcRun = INCLINE_FOOT_RADIUS * sin;
  return { sin, cos, slope: sin / cos, arcRun, arcRise: INCLINE_FOOT_RADIUS * (1 - cos), straightEnd: arcRun + straightLength };
}

const LONG_JUMP_SECTION = inclineSection(LONG_JUMP_INCLINE.pitchDegrees * DEGREES_TO_RADIANS, LONG_JUMP_INCLINE.length);
/** Where the long jump's crest arc, easing the incline into the level, ends, as run from the foot. */
const LONG_JUMP_TOP_END = LONG_JUMP_SECTION.straightEnd + LONG_JUMP_INCLINE.crestRadius * LONG_JUMP_SECTION.sin;
const LONG_JUMP_RUN = LONG_JUMP_TOP_END + LONG_JUMP_INCLINE.flatTail;
/** The long jump's whole climb, foot to lip: its floor is level with the pad at the barrier, so the run-up lies this far below it. */
const LONG_JUMP_RISE =
  LONG_JUMP_SECTION.arcRise + LONG_JUMP_INCLINE.length * LONG_JUMP_SECTION.slope + LONG_JUMP_INCLINE.crestRadius * (1 - LONG_JUMP_SECTION.cos);

const RING_FLING_SECTION = inclineSection(RING_FLING_LANE.inclinePitchDegrees * DEGREES_TO_RADIANS, RING_FLING_LANE.inclineLength);
const RING_FLING_HOP_HEIGHT =
  ((RING_FLING_LANE.inclineLength + RING_FLING_LANE.hopLength) * RING_FLING_LANE.machineHopInches) / RING_FLING_LANE.machineLaneInches;
const RING_FLING_RUN = RING_FLING_SECTION.straightEnd + RING_FLING_LANE.hopLength;

const HIGH_JUMP_PITCH = HIGH_JUMP_KICKER.lipPitchDegrees * DEGREES_TO_RADIANS;
const HIGH_JUMP_RUN = HIGH_JUMP_KICKER.radius * detSin(HIGH_JUMP_PITCH);

const LIP_BACK_FACE_SLOPE = detSin(LIP_BACK_FACE_PITCH_DEGREES * DEGREES_TO_RADIANS) / detCos(LIP_BACK_FACE_PITCH_DEGREES * DEGREES_TO_RADIANS);

/** Horizontal length (m) of the climb: from its foot to the lip. */
function climbRun(mode: MinigameMode): number {
  if (mode === "longJump") return LONG_JUMP_RUN;
  if (mode === "highJump") return HIGH_JUMP_RUN;
  return RING_FLING_RUN;
}

/** Height (m) of the circle of `radius` m, tangent to the level, `run` m along it. */
function circleRise(radius: number, run: number): number {
  return radius - Math.sqrt(radius * radius - run * run);
}

/** Height (m) the foot arc and the straight incline have risen at `run` m from the foot. */
function inclineRise(section: InclineSection, run: number): number {
  if (run < section.arcRun) return circleRise(INCLINE_FOOT_RADIUS, run);
  return section.arcRise + (run - section.arcRun) * section.slope;
}

/** Height (m) the long jump's crest has risen `run` m past the incline's end: a circle turning the incline's pitch down to the level. */
function crestRise(run: number): number {
  const sinHere = LONG_JUMP_SECTION.sin - run / LONG_JUMP_INCLINE.crestRadius;
  return LONG_JUMP_INCLINE.crestRadius * (Math.sqrt(1 - sinHere * sinHere) - LONG_JUMP_SECTION.cos);
}

/** Height (m) the climb has risen above the run-up at `run` m from its foot. */
function climbRise(mode: MinigameMode, run: number): number {
  if (mode === "longJump") {
    if (run >= LONG_JUMP_TOP_END) return LONG_JUMP_RISE;
    if (run <= LONG_JUMP_SECTION.straightEnd) return inclineRise(LONG_JUMP_SECTION, run);
    return inclineRise(LONG_JUMP_SECTION, LONG_JUMP_SECTION.straightEnd) + crestRise(run - LONG_JUMP_SECTION.straightEnd);
  }
  if (mode === "highJump") return circleRise(HIGH_JUMP_KICKER.radius, run);
  const hopRun = run - RING_FLING_SECTION.straightEnd;
  if (hopRun <= 0) return inclineRise(RING_FLING_SECTION, run);
  const hopShare = hopRun / RING_FLING_LANE.hopLength;
  return inclineRise(RING_FLING_SECTION, run) + RING_FLING_HOP_HEIGHT * (1 - detCos((Math.PI / 2) * hopShare));
}

/** How far (m) the run-up lies below the pad: the start hill's drop. The long jump's is its whole climb, so its lip is level with the pad. */
function runUpDrop(mode: MinigameMode): number {
  return mode === "longJump" ? LONG_JUMP_RISE : START_HILL.drop;
}

/** x of the start hill's top, where the pad ends. */
function hillTopX(mode: MinigameMode): number {
  return -climbRun(mode) - RUN_UP_LENGTH[mode] - START_HILL.length;
}

/** x of the pad's back end: the station's far edge behind the parked car. */
export function stationBackX(mode: MinigameMode): number {
  return hillTopX(mode) - START_HILL.padLength;
}

/** x (m) of the climb's foot, where the run-up ends. */
export function climbFootX(mode: MinigameMode): number {
  return -climbRun(mode);
}

/** Height (m above the pad) of the lip: the floor at x = 0. The long jump's is the pad's level. */
export function lipHeight(mode: MinigameMode): number {
  return -runUpDrop(mode) + climbRise(mode, climbRun(mode));
}

/** x (m) past the lip where the floor behind it has fallen to the landing's level: 0 for the long jump, whose floor goes on level. */
export function stationFrontX(mode: MinigameMode): number {
  return mode === "longJump" ? 0 : (lipHeight(mode) - LANDING_HEIGHT) / LIP_BACK_FACE_SLOPE;
}

/** Floor height (m above the pad) of the station `mode` at local (x, z): the run's profile, the same across the lane. */
export function floorHeightAt(mode: MinigameMode, localX: number, _localZ: number): number {
  if (localX >= 0) return mode === "longJump" ? LANDING_HEIGHT : Math.max(LANDING_HEIGHT, lipHeight(mode) - localX * LIP_BACK_FACE_SLOPE);
  const hillTop = hillTopX(mode);
  if (localX <= hillTop) return 0;
  const hillShare = (localX - hillTop) / START_HILL.length;
  const drop = runUpDrop(mode);
  if (hillShare < 1) return (-drop * (1 - detCos(Math.PI * hillShare))) / 2;
  const climbFoot = -climbRun(mode);
  if (localX <= climbFoot) return -drop;
  return -drop + climbRise(mode, localX - climbFoot);
}

/** Angle (rad) the floor climbs at the lip: the long jump's is level. */
export function lipPitch(mode: MinigameMode): number {
  if (mode === "longJump") return 0;
  if (mode === "highJump") return HIGH_JUMP_PITCH;
  return detAtan(RING_FLING_SECTION.slope + ((Math.PI / 2) * RING_FLING_HOP_HEIGHT) / RING_FLING_LANE.hopLength);
}

/** Where the parked car stands: the middle of the pad, on the lane's middle, facing down the run. */
export function stationStartPose(mode: MinigameMode): { x: number; z: number; yaw: number } {
  return { x: stationBackX(mode) + START_HILL.padLength / 2, z: 0, yaw: THROW_YAW };
}
