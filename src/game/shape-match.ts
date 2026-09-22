/**
 * Meshless shape matching (Müller et al., SIGGRAPH 2005).
 *
 * Control particles take collisions. Each overlapping cluster finds the
 * optimal linear transform A = Apq Aqq^{-1}, splits it with polar
 * decomposition A = R S, and pulls particles toward those goals.
 * Plasticity updates the rest offsets (and, when yielding, bakes rotation
 * into the rest CoM) so crumpled metal does not spring back.
 */

export type Mat3 = Float64Array;

export function m3(): Mat3 {
  return new Float64Array(9);
}

export function m3Id(out: Mat3 = m3()): Mat3 {
  out[0] = 1;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
  out[4] = 1;
  out[5] = 0;
  out[6] = 0;
  out[7] = 0;
  out[8] = 1;
  return out;
}

export function m3Copy(src: Mat3, out: Mat3 = m3()): Mat3 {
  out.set(src);
  return out;
}

export function m3Zero(out: Mat3): Mat3 {
  out.fill(0);
  return out;
}

export function m3Mul(a: Mat3, b: Mat3, out: Mat3): Mat3 {
  const a0 = a[0]!,
    a1 = a[1]!,
    a2 = a[2]!,
    a3 = a[3]!,
    a4 = a[4]!,
    a5 = a[5]!,
    a6 = a[6]!,
    a7 = a[7]!,
    a8 = a[8]!;
  const b0 = b[0]!,
    b1 = b[1]!,
    b2 = b[2]!,
    b3 = b[3]!,
    b4 = b[4]!,
    b5 = b[5]!,
    b6 = b[6]!,
    b7 = b[7]!,
    b8 = b[8]!;
  out[0] = a0 * b0 + a1 * b3 + a2 * b6;
  out[1] = a0 * b1 + a1 * b4 + a2 * b7;
  out[2] = a0 * b2 + a1 * b5 + a2 * b8;
  out[3] = a3 * b0 + a4 * b3 + a5 * b6;
  out[4] = a3 * b1 + a4 * b4 + a5 * b7;
  out[5] = a3 * b2 + a4 * b5 + a5 * b8;
  out[6] = a6 * b0 + a7 * b3 + a8 * b6;
  out[7] = a6 * b1 + a7 * b4 + a8 * b7;
  out[8] = a6 * b2 + a7 * b5 + a8 * b8;
  return out;
}

export function m3MulVecInto(m: Mat3, x: number, y: number, z: number, out: { x: number; y: number; z: number }): void {
  out.x = m[0]! * x + m[1]! * y + m[2]! * z;
  out.y = m[3]! * x + m[4]! * y + m[5]! * z;
  out.z = m[6]! * x + m[7]! * y + m[8]! * z;
}

export function m3MulVec(m: Mat3, x: number, y: number, z: number): [number, number, number] {
  return [m[0]! * x + m[1]! * y + m[2]! * z, m[3]! * x + m[4]! * y + m[5]! * z, m[6]! * x + m[7]! * y + m[8]! * z];
}

export function m3Transpose(m: Mat3, out: Mat3): Mat3 {
  out[0] = m[0]!;
  out[1] = m[3]!;
  out[2] = m[6]!;
  out[3] = m[1]!;
  out[4] = m[4]!;
  out[5] = m[7]!;
  out[6] = m[2]!;
  out[7] = m[5]!;
  out[8] = m[8]!;
  return out;
}

export function m3AddScaled(a: Mat3, b: Mat3, s: number, out: Mat3): Mat3 {
  for (let i = 0; i < 9; i++) out[i] = a[i]! + b[i]! * s;
  return out;
}

export function m3Lerp(a: Mat3, b: Mat3, t: number, out: Mat3): Mat3 {
  const u = 1 - t;
  for (let i = 0; i < 9; i++) out[i] = a[i]! * u + b[i]! * t;
  return out;
}

export function m3Det(m: Mat3): number {
  return (
    m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) -
    m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!) +
    m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!)
  );
}

export function m3Invert(m: Mat3, out: Mat3): boolean {
  const det = m3Det(m);
  if (Math.abs(det) < 1e-12) return false;
  const i = 1 / det;
  out[0] = (m[4]! * m[8]! - m[5]! * m[7]!) * i;
  out[1] = (m[2]! * m[7]! - m[1]! * m[8]!) * i;
  out[2] = (m[1]! * m[5]! - m[2]! * m[4]!) * i;
  out[3] = (m[5]! * m[6]! - m[3]! * m[8]!) * i;
  out[4] = (m[0]! * m[8]! - m[2]! * m[6]!) * i;
  out[5] = (m[2]! * m[3]! - m[0]! * m[5]!) * i;
  out[6] = (m[3]! * m[7]! - m[4]! * m[6]!) * i;
  out[7] = (m[1]! * m[6]! - m[0]! * m[7]!) * i;
  out[8] = (m[0]! * m[4]! - m[1]! * m[3]!) * i;
  return true;
}

export function m3FrobeniusI(m: Mat3): number {
  const d0 = m[0]! - 1,
    d4 = m[4]! - 1,
    d8 = m[8]! - 1;
  return Math.sqrt(d0 * d0 + m[1]! * m[1]! + m[2]! * m[2]! + m[3]! * m[3]! + d4 * d4 + m[5]! * m[5]! + m[6]! * m[6]! + m[7]! * m[7]! + d8 * d8);
}

export function m3Finite(m: Mat3): boolean {
  for (let i = 0; i < 9; i++) if (!Number.isFinite(m[i]!)) return false;
  return true;
}

export function m3MaxAbs(m: Mat3): number {
  let a = 0;
  for (let i = 0; i < 9; i++) a = Math.max(a, Math.abs(m[i]!));
  return a;
}

/** Polar decomposition A = R S via Higham/Newton. S is the symmetric stretch. */
export function m3Polar(A: Mat3, R: Mat3, S: Mat3): void {
  if (!m3Finite(A) || m3MaxAbs(A) > 12 || m3FrobeniusI(A) > 8) {
    m3Id(R);
    m3Id(S);
    return;
  }
  m3Copy(A, R);
  const inv = m3();
  const Rt = m3();
  for (let k = 0; k < 12; k++) {
    if (!m3Invert(R, inv)) {
      m3Id(R);
      m3Id(S);
      return;
    }
    m3Transpose(inv, Rt);
    for (let i = 0; i < 9; i++) R[i] = 0.5 * (R[i]! + Rt[i]!);
  }
  if (!m3Finite(R) || m3MaxAbs(R) > 4) {
    m3Id(R);
    m3Id(S);
    return;
  }
  m3Orthonormalize(R);
  if (m3Det(R) < 0) {
    R[2] = -R[2]!;
    R[5] = -R[5]!;
    R[8] = -R[8]!;
    m3Orthonormalize(R);
  }
  m3ClampRotation(R, 0.85);
  m3Orthonormalize(R);
  m3Transpose(R, Rt);
  m3Mul(Rt, A, S);
  S[1] = S[3] = 0.5 * (S[1]! + S[3]!);
  S[2] = S[6] = 0.5 * (S[2]! + S[6]!);
  S[5] = S[7] = 0.5 * (S[5]! + S[7]!);
  if (!m3Finite(S) || m3FrobeniusI(S) > 1.8) m3Id(S);
}

/** Gram-Schmidt on columns so Higham's iterate is a real rotation, not a flip. */
export function m3Orthonormalize(R: Mat3): void {
  let x0 = R[0]!,
    y0 = R[3]!,
    z0 = R[6]!;
  let n = Math.hypot(x0, y0, z0) || 1;
  x0 /= n;
  y0 /= n;
  z0 /= n;
  let x1 = R[1]!,
    y1 = R[4]!,
    z1 = R[7]!;
  const d = x1 * x0 + y1 * y0 + z1 * z0;
  x1 -= d * x0;
  y1 -= d * y0;
  z1 -= d * z0;
  n = Math.hypot(x1, y1, z1) || 1;
  x1 /= n;
  y1 /= n;
  z1 /= n;
  const x2 = y0 * z1 - z0 * y1;
  const y2 = z0 * x1 - x0 * z1;
  const z2 = x0 * y1 - y0 * x1;
  R[0] = x0;
  R[3] = y0;
  R[6] = z0;
  R[1] = x1;
  R[4] = y1;
  R[7] = z1;
  R[2] = x2;
  R[5] = y2;
  R[8] = z2;
}

export function m3RotationAngle(R: Mat3): number {
  const tr = R[0]! + R[4]! + R[8]!;
  return Math.acos(Math.min(1, Math.max(-1, (tr - 1) * 0.5)));
}

/** Pull R toward identity if it flipped past `maxRad` (stops inside-out mesh). */
export function m3ClampRotation(R: Mat3, maxRad: number): void {
  const ang = m3RotationAngle(R);
  if (!(ang > maxRad) || ang < 1e-6) return;
  const t = maxRad / ang;
  R[0] = 1 + (R[0]! - 1) * t;
  R[1] = R[1]! * t;
  R[2] = R[2]! * t;
  R[3] = R[3]! * t;
  R[4] = 1 + (R[4]! - 1) * t;
  R[5] = R[5]! * t;
  R[6] = R[6]! * t;
  R[7] = R[7]! * t;
  R[8] = 1 + (R[8]! - 1) * t;
  m3Orthonormalize(R);
}

/** Keep polar R from flipping 180° for a single frame (skin flicker in slomo). */
export function stabilizeR(c: ShapeCluster): void {
  let dot = 0;
  for (let i = 0; i < 9; i++) dot += c.R[i]! * c.Rprev[i]!;
  if (dot < 0.4) {
    for (let i = 0; i < 9; i++) c.R[i] = c.Rprev[i]! * 0.82 + c.R[i]! * 0.18;
    m3Orthonormalize(c.R);
    if (m3Det(c.R) < 0) {
      c.R[2] = -c.R[2]!;
      c.R[5] = -c.R[5]!;
      c.R[8] = -c.R[8]!;
      m3Orthonormalize(c.R);
    }
  }
  m3Copy(c.R, c.Rprev);
}

function m3OuterAdd(px: number, py: number, pz: number, qx: number, qy: number, qz: number, w: number, out: Mat3): void {
  out[0] += w * px * qx;
  out[1] += w * px * qy;
  out[2] += w * px * qz;
  out[3] += w * py * qx;
  out[4] += w * py * qy;
  out[5] += w * py * qz;
  out[6] += w * pz * qx;
  out[7] += w * pz * qy;
  out[8] += w * pz * qz;
}

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
  skinCm0x: number;
  skinCm0y: number;
  skinCm0z: number;
  skinCmx: number;
  skinCmy: number;
  skinCmz: number;
}

const _Apq = m3();
const _Aqq = m3();
const _tmp = m3();
const _tmp2 = m3();
const _I = m3Id();

export function makeCluster(particles: ShapeParticle[], idx: number[]): ShapeCluster {
  const n = idx.length;
  const c: ShapeCluster = {
    idx: idx.slice(),
    q0x: new Float64Array(n),
    q0y: new Float64Array(n),
    q0z: new Float64Array(n),
    qx: new Float64Array(n),
    qy: new Float64Array(n),
    qz: new Float64Array(n),
    cm0x: 0,
    cm0y: 0,
    cm0z: 0,
    cmx: 0,
    cmy: 0,
    cmz: 0,
    AqqInv: m3(),
    Sp: m3Id(),
    A: m3Id(),
    R: m3Id(),
    S: m3Id(),
    M: m3Id(),
    skinM: m3Id(),
    skinInvT: m3Id(),
    Rprev: m3Id(),
    skinCm0x: 0,
    skinCm0y: 0,
    skinCm0z: 0,
    skinCmx: 0,
    skinCmy: 0,
    skinCmz: 0,
  };
  let msum = 0;
  for (let i = 0; i < n; i++) {
    const p = particles[idx[i]!]!;
    c.cm0x += p.x * p.mass;
    c.cm0y += p.y * p.mass;
    c.cm0z += p.z * p.mass;
    msum += p.mass;
  }
  msum = Math.max(msum, 1e-8);
  c.cm0x /= msum;
  c.cm0y /= msum;
  c.cm0z /= msum;
  c.skinCm0x = c.skinCmx = c.cm0x;
  c.skinCm0y = c.skinCmy = c.cm0y;
  c.skinCm0z = c.skinCmz = c.cm0z;
  for (let i = 0; i < n; i++) {
    const p = particles[idx[i]!]!;
    c.q0x[i] = c.qx[i] = p.x - c.cm0x;
    c.q0y[i] = c.qy[i] = p.y - c.cm0y;
    c.q0z[i] = c.qz[i] = p.z - c.cm0z;
  }
  rebuildAqqWeighted(c, particles);
  return c;
}

export function rebuildAqqWeighted(c: ShapeCluster, particles: ShapeParticle[]): void {
  m3Zero(_Aqq);
  for (let i = 0; i < c.idx.length; i++) {
    const p = particles[c.idx[i]!]!;
    m3OuterAdd(c.qx[i]!, c.qy[i]!, c.qz[i]!, c.qx[i]!, c.qy[i]!, c.qz[i]!, p.mass, _Aqq);
  }
  _Aqq[0] += 1e-3;
  _Aqq[4] += 1e-3;
  _Aqq[8] += 1e-3;
  if (!m3Invert(_Aqq, c.AqqInv)) m3Id(c.AqqInv);
}

export function matchCluster(c: ShapeCluster, particles: ShapeParticle[], beta: number): void {
  let msum = 0;
  c.cmx = 0;
  c.cmy = 0;
  c.cmz = 0;
  for (const i of c.idx) {
    const p = particles[i]!;
    c.cmx += p.x * p.mass;
    c.cmy += p.y * p.mass;
    c.cmz += p.z * p.mass;
    msum += p.mass;
  }
  msum = Math.max(msum, 1e-8);
  c.cmx /= msum;
  c.cmy /= msum;
  c.cmz /= msum;

  m3Zero(_Apq);
  for (let i = 0; i < c.idx.length; i++) {
    const p = particles[c.idx[i]!]!;
    m3OuterAdd(p.x - c.cmx, p.y - c.cmy, p.z - c.cmz, c.qx[i]!, c.qy[i]!, c.qz[i]!, p.mass, _Apq);
  }
  m3Mul(_Apq, c.AqqInv, c.A);
  if (!m3Finite(c.A) || m3MaxAbs(c.A) > 12) m3Id(c.A);
  m3Polar(c.A, c.R, c.S);
  stabilizeR(c);
  // Müller: T = (1-β) R + β A = R ((1-β) I + β S). Never lerp toward a
  // reflected/huge A — that is what inverted the mesh.
  m3Lerp(_I, c.S, beta, _tmp);
  m3Mul(c.R, _tmp, c.M);
  if (!m3Finite(c.M) || m3MaxAbs(c.M) > 8) m3Id(c.M);
  m3Mul(c.M, c.Sp, c.skinM);
  if (!m3Finite(c.skinM) || m3MaxAbs(c.skinM) > 8) m3Id(c.skinM);
  if (!m3Invert(c.skinM, _tmp)) m3Id(_tmp);
  m3Transpose(_tmp, c.skinInvT);
}

export function applyPlasticity(
  c: ShapeCluster,
  particles: ShapeParticle[],
  dt: number,
  squash: number,
  contacting: boolean,
  buckle = 0.45,
): void {
  if (squash < 0.03 && buckle < 0.03) return;
  const yieldC = 0.035 + (1 - squash) * 0.08 + (1 - buckle) * 0.04;
  const err = m3FrobeniusI(c.S);
  if (err < yieldC) return;
  // Bugbear/Rajala 2008: metal yield is a lock, not a creep. High creep just looks like putty.
  const creep = Math.min(0.85, (0.35 + squash * 1.25 + buckle * 0.55) * Math.max(dt, 1 / 120) * 10);
  m3Lerp(_I, c.S, creep, _tmp);
  m3Mul(c.Sp, _tmp, _tmp2);
  m3Copy(_tmp2, c.Sp);
  const maxE = 0.18 + squash * 0.55 + buckle * 0.4;
  const pe = m3FrobeniusI(c.Sp);
  if (pe > maxE) {
    const t = maxE / pe;
    m3Lerp(_I, c.Sp, t, c.Sp);
  }
  const det = m3Det(c.Sp);
  if (det > 1e-6) {
    const s = Math.cbrt(1 / det);
    // Rajala: volume restore is optional and destabilizes linear metal crush. Keep a
    // whisper so det(Sp) cannot vanish, but do not fatten the cabin like rubber.
    const keep = 0.08;
    const mix = 1 + (s - 1) * keep;
    for (let i = 0; i < 9; i++) c.Sp[i]! *= mix;
  }
  // Accordion, not balloon: crash-box steel shortens, it does not get 40% wider.
  if (c.Sp[0]! > 1.06) c.Sp[0] = 1.06;
  if (c.Sp[4]! > 1.06) c.Sp[4] = 1.06;
  if (c.Sp[8]! > 1.06) c.Sp[8] = 1.06;
  if (contacting) {
    const r00 = c.R[0]!,
      r11 = c.R[4]!,
      r22 = c.R[8]!;
    const tr = r00 + r11 + r22;
    const ang = Math.acos(Math.min(1, Math.max(-1, (tr - 1) * 0.5)));
    if (ang > 0.08) {
      m3Lerp(_I, c.R, creep * 0.45, _tmp);
      for (let i = 0; i < c.idx.length; i++) {
        const [x, y, z] = m3MulVec(_tmp, c.q0x[i]!, c.q0y[i]!, c.q0z[i]!);
        c.q0x[i] = x;
        c.q0y[i] = y;
        c.q0z[i] = z;
      }
    }
  }
  for (let i = 0; i < c.idx.length; i++) {
    const [x, y, z] = m3MulVec(c.Sp, c.q0x[i]!, c.q0y[i]!, c.q0z[i]!);
    c.qx[i] = x;
    c.qy[i] = y;
    c.qz[i] = z;
  }
  rebuildAqqWeighted(c, particles);
}

export function resetCluster(c: ShapeCluster, particles: ShapeParticle[]): void {
  m3Id(c.Sp);
  m3Id(c.A);
  m3Id(c.R);
  m3Id(c.S);
  m3Id(c.M);
  m3Id(c.skinM);
  m3Id(c.skinInvT);
  m3Id(c.Rprev);
  let msum = 0;
  c.cm0x = c.cm0y = c.cm0z = 0;
  for (const i of c.idx) {
    const p = particles[i]!;
    c.cm0x += p.x * p.mass;
    c.cm0y += p.y * p.mass;
    c.cm0z += p.z * p.mass;
    msum += p.mass;
  }
  msum = Math.max(msum, 1e-8);
  c.cm0x /= msum;
  c.cm0y /= msum;
  c.cm0z /= msum;
  c.skinCm0x = c.skinCmx = c.cm0x;
  c.skinCm0y = c.skinCmy = c.cm0y;
  c.skinCm0z = c.skinCmz = c.cm0z;
  for (let i = 0; i < c.idx.length; i++) {
    const p = particles[c.idx[i]!]!;
    c.q0x[i] = c.qx[i] = p.x - c.cm0x;
    c.q0y[i] = c.qy[i] = p.y - c.cm0y;
    c.q0z[i] = c.qz[i] = p.z - c.cm0z;
  }
  rebuildAqqWeighted(c, particles);
}

const _skinT = { x: 0, y: 0, z: 0 };

export function transformSkinPointInto(
  c: ShapeCluster,
  x: number,
  y: number,
  z: number,
  out: { x: number; y: number; z: number } = _skinT,
): { x: number; y: number; z: number } {
  const m = c.skinM;
  const dx = x - c.skinCm0x;
  const dy = y - c.skinCm0y;
  const dz = z - c.skinCm0z;
  out.x = m[0]! * dx + m[1]! * dy + m[2]! * dz + c.skinCmx;
  out.y = m[3]! * dx + m[4]! * dy + m[5]! * dz + c.skinCmy;
  out.z = m[6]! * dx + m[7]! * dy + m[8]! * dz + c.skinCmz;
  return out;
}

export function transformPoint(c: ShapeCluster, x: number, y: number, z: number): [number, number, number] {
  const [px, py, pz] = m3MulVec(c.skinM, x - c.cm0x, y - c.cm0y, z - c.cm0z);
  return [px + c.cmx, py + c.cmy, pz + c.cmz];
}

/** Talk pipeline: apply the cell matrix in rest-local space. */
export function transformSkinPoint(c: ShapeCluster, x: number, y: number, z: number): [number, number, number] {
  const [px, py, pz] = m3MulVec(c.skinM, x - c.skinCm0x, y - c.skinCm0y, z - c.skinCm0z);
  return [px + c.skinCmx, py + c.skinCmy, pz + c.skinCmz];
}

export function transformNormal(c: ShapeCluster, x: number, y: number, z: number): [number, number, number] {
  return m3MulVec(c.skinInvT, x, y, z);
}

/**
 * Least-squares cell matrix from rest-local vs live-local, using the
 * plastic stretch Sp. Does not touch the world-space matching state.
 */
export function matchSkinLocal(
  c: ShapeCluster,
  rest: { x: number; y: number; z: number }[],
  local: { x: number; y: number; z: number }[],
  mass: number[],
  beta: number,
): void {
  let msum = 0;
  c.skinCm0x = 0;
  c.skinCm0y = 0;
  c.skinCm0z = 0;
  c.skinCmx = 0;
  c.skinCmy = 0;
  c.skinCmz = 0;
  for (const i of c.idx) {
    const r = rest[i]!;
    const p = local[i]!;
    const m = mass[i]!;
    c.skinCm0x += r.x * m;
    c.skinCm0y += r.y * m;
    c.skinCm0z += r.z * m;
    c.skinCmx += p.x * m;
    c.skinCmy += p.y * m;
    c.skinCmz += p.z * m;
    msum += m;
  }
  msum = Math.max(msum, 1e-8);
  c.skinCm0x /= msum;
  c.skinCm0y /= msum;
  c.skinCm0z /= msum;
  c.skinCmx /= msum;
  c.skinCmy /= msum;
  c.skinCmz /= msum;

  m3Zero(_Apq);
  m3Zero(_Aqq);
  for (const i of c.idx) {
    const r = rest[i]!;
    const p = local[i]!;
    const m = mass[i]!;
    const [qx, qy, qz] = m3MulVec(c.Sp, r.x - c.skinCm0x, r.y - c.skinCm0y, r.z - c.skinCm0z);
    m3OuterAdd(p.x - c.skinCmx, p.y - c.skinCmy, p.z - c.skinCmz, qx, qy, qz, m, _Apq);
    m3OuterAdd(qx, qy, qz, qx, qy, qz, m, _Aqq);
  }
  _Aqq[0] += 1e-3;
  _Aqq[4] += 1e-3;
  _Aqq[8] += 1e-3;
  if (!m3Invert(_Aqq, _tmp2)) m3Id(_tmp2);
  m3Mul(_Apq, _tmp2, c.A);
  if (!m3Finite(c.A) || m3MaxAbs(c.A) > 12) m3Id(c.A);
  m3Polar(c.A, c.R, c.S);
  stabilizeR(c);
  m3Lerp(_I, c.S, beta, _tmp);
  m3Mul(c.R, _tmp, c.skinM);
  if (!m3Finite(c.skinM) || m3MaxAbs(c.skinM) > 4) m3Id(c.skinM);
  if (!m3Invert(c.skinM, _tmp)) m3Id(_tmp);
  m3Transpose(_tmp, c.skinInvT);
}

export function stiffnessIters(squash: number): number {
  return Math.max(2, Math.min(5, Math.round(2 + (1.05 - squash) * 3)));
}

export function goalAlpha(squash: number): number {
  return 0.22 + (1 - squash) * 0.62;
}

export function deformBeta(squash: number): number {
  return Math.max(0, squash) * 0.9;
}
