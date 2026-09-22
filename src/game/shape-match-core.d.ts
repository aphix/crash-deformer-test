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

export function m3(): Mat3;
export function m3Id(out?: Mat3): Mat3;
export function m3Copy(src: Mat3, out?: Mat3): Mat3;
export function m3Zero(out: Mat3): Mat3;
export function m3Mul(a: Mat3, b: Mat3, out: Mat3): Mat3;
export function m3MulVecInto(
  m: Mat3,
  x: number,
  y: number,
  z: number,
  out: { x: number; y: number; z: number },
): void;
export function m3MulVec(m: Mat3, x: number, y: number, z: number): [number, number, number];
export function m3Transpose(m: Mat3, out: Mat3): Mat3;
export function m3AddScaled(a: Mat3, b: Mat3, s: number, out: Mat3): Mat3;
export function m3Lerp(a: Mat3, b: Mat3, t: number, out: Mat3): Mat3;
export function m3Det(m: Mat3): number;
export function m3Invert(m: Mat3, out: Mat3): boolean;
export function m3FrobeniusI(m: Mat3): number;
export function m3Finite(m: Mat3): boolean;
export function m3MaxAbs(m: Mat3): number;
export function m3Polar(A: Mat3, R: Mat3, S: Mat3): void;
export function m3Orthonormalize(R: Mat3): void;
export function m3RotationAngle(R: Mat3): number;
export function m3ClampRotation(R: Mat3, maxRad: number): void;
export function stabilizeR(c: ShapeCluster): void;
export function makeCluster(particles: ShapeParticle[], idx: number[]): ShapeCluster;
export function rebuildAqqWeighted(c: ShapeCluster, particles: ShapeParticle[]): void;
export function matchCluster(c: ShapeCluster, particles: ShapeParticle[], beta: number): void;
export function applyPlasticity(
  c: ShapeCluster,
  particles: ShapeParticle[],
  dt: number,
  squash: number,
  contacting: boolean,
  buckle?: number,
): void;
export function resetCluster(c: ShapeCluster, particles: ShapeParticle[]): void;
export function transformSkinPointInto(
  c: ShapeCluster,
  x: number,
  y: number,
  z: number,
  out?: { x: number; y: number; z: number },
): { x: number; y: number; z: number };
export function transformPoint(c: ShapeCluster, x: number, y: number, z: number): [number, number, number];
export function transformSkinPoint(c: ShapeCluster, x: number, y: number, z: number): [number, number, number];
export function transformNormal(c: ShapeCluster, x: number, y: number, z: number): [number, number, number];
export function matchSkinLocal(
  c: ShapeCluster,
  rest: { x: number; y: number; z: number }[],
  local: { x: number; y: number; z: number }[],
  mass: number[],
  beta: number,
): void;
export function stiffnessIters(squash: number): number;
export function goalAlpha(squash: number): number;
export function deformBeta(squash: number): number;
