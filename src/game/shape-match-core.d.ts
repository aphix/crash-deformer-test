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

export function m3(): Mat3;
export function m3Id(out?: Mat3): Mat3;
export function m3Mul(a: Mat3, b: Mat3, out: Mat3): Mat3;
export function m3Det(m: Mat3): number;
export function m3FrobeniusI(m: Mat3): number;
export function quatId(out?: Quat): Quat;
export function m3Polar(A: Mat3, q: Quat, R: Mat3, S: Mat3): void;
export function m3RotationAngle(R: Mat3): number;
export function makeCluster(particles: ShapeParticle[], idx: number[]): ShapeCluster;
export function rebuildAqqWeighted(c: ShapeCluster, particles: ShapeParticle[]): void;
export function matchCluster(c: ShapeCluster, particles: ShapeParticle[], beta: number): void;
export function applyPlasticity(c: ShapeCluster, particles: ShapeParticle[], dt: number, squash: number, buckle?: number): void;
export function resetCluster(c: ShapeCluster, particles: ShapeParticle[]): void;
export function transformSkinPointInto(
  c: ShapeCluster,
  x: number,
  y: number,
  z: number,
  out?: { x: number; y: number; z: number },
): { x: number; y: number; z: number };
export function transformNormal(
  c: ShapeCluster,
  x: number,
  y: number,
  z: number,
  out?: { x: number; y: number; z: number },
): { x: number; y: number; z: number };
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
