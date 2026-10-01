/**
 * Meshless shape matching (Müller et al., SIGGRAPH 2005).
 *
 * Hot path lives in shape-match-core.js (plain JS — no TS transform).
 * This file is the typed façade.
 */
export type Mat3 = Float64Array;
/** Unit quaternion, (x, y, z, w). */
export type Quat = Float64Array;

export interface ShapeParticle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  mass: number;
}

export interface ShapeCluster {
  idx: number[];
  q0x: Float64Array;
  q0y: Float64Array;
  q0z: Float64Array;
  qx: Float64Array;
  qy: Float64Array;
  qz: Float64Array;
  cm0x: number;
  cm0y: number;
  cm0z: number;
  cmx: number;
  cmy: number;
  cmz: number;
  AqqInv: Mat3;
  /** Rest shape is flat (slab or triangle): its fit takes the turned normal n as the third axis. */
  planar: boolean;
  /** Unit normal of the plastic rest plane (planar clusters). */
  n: Float64Array;
  Sp: Mat3;
  A: Mat3;
  R: Mat3;
  S: Mat3;
  M: Mat3;
  skinM: Mat3;
  Rprev: Mat3;
  /** Unclamped rotation of the last fit: warm start of the next extraction. */
  rotQ: Quat;
  skinR: Mat3;
  skinRprev: Mat3;
  skinRotQ: Quat;
  skinCm0x: number;
  skinCm0y: number;
  skinCm0z: number;
  skinCmx: number;
  skinCmy: number;
  skinCmz: number;
}

export {
  m3,
  m3Id,
  m3Copy,
  m3Mul,
  m3Det,
  m3FrobeniusI,
  m3Finite,
  quatId,
  m3Polar,
  m3Orthonormalize,
  m3RotationAngle,
  m3ClampRotation,
  stabilizeR,
  makeCluster,
  rebuildAqqWeighted,
  matchCluster,
  applyPlasticity,
  resetCluster,
  transformSkinPointInto,
  transformNormal,
  matchSkinLocal,
  stiffnessIters,
  goalAlpha,
  deformBeta,
} from "./shape-match-core.js";
