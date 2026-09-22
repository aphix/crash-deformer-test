/**
 * Meshless shape matching (Müller et al., SIGGRAPH 2005).
 *
 * Hot path lives in shape-match-core.js (plain JS — no TS transform).
 * This file is the typed façade.
 */
export type Mat3 = Float64Array;

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
  Sp: Mat3;
  A: Mat3;
  R: Mat3;
  S: Mat3;
  M: Mat3;
  skinM: Mat3;
  skinInvT: Mat3;
  Rprev: Mat3;
  skinR: Mat3;
  skinRprev: Mat3;
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
  m3Zero,
  m3Mul,
  m3MulVecInto,
  m3MulVec,
  m3Transpose,
  m3AddScaled,
  m3Lerp,
  m3Det,
  m3Invert,
  m3FrobeniusI,
  m3Finite,
  m3MaxAbs,
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
  transformPoint,
  transformSkinPoint,
  transformNormal,
  matchSkinLocal,
  stiffnessIters,
  goalAlpha,
  deformBeta,
} from "./shape-match-core.js";
