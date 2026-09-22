// @ts-nocheck
"use strict";
// Hand-kept CJS kernel (Müller 2005 shape matching). No TS transform.

function m3() {
  return new Float64Array(9);
}
function m3Id(out = m3()) {
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
function m3Copy(src, out = m3()) {
  out.set(src);
  return out;
}
function m3Zero(out) {
  out.fill(0);
  return out;
}
function m3Mul(a, b, out) {
  const a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3], a4 = a[4], a5 = a[5], a6 = a[6], a7 = a[7], a8 = a[8];
  const b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3], b4 = b[4], b5 = b[5], b6 = b[6], b7 = b[7], b8 = b[8];
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
function m3MulVecInto(m, x, y, z, out) {
  out.x = m[0] * x + m[1] * y + m[2] * z;
  out.y = m[3] * x + m[4] * y + m[5] * z;
  out.z = m[6] * x + m[7] * y + m[8] * z;
}
function m3MulVec(m, x, y, z) {
  return [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
}
function m3Transpose(m, out) {
  out[0] = m[0];
  out[1] = m[3];
  out[2] = m[6];
  out[3] = m[1];
  out[4] = m[4];
  out[5] = m[7];
  out[6] = m[2];
  out[7] = m[5];
  out[8] = m[8];
  return out;
}
function m3AddScaled(a, b, s, out) {
  for (let i = 0; i < 9; i++) out[i] = a[i] + b[i] * s;
  return out;
}
function m3Lerp(a, b, t, out) {
  const u = 1 - t;
  for (let i = 0; i < 9; i++) out[i] = a[i] * u + b[i] * t;
  return out;
}
function m3Det(m) {
  return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
}
function m3Invert(m, out) {
  const det = m3Det(m);
  if (Math.abs(det) < 1e-12) return false;
  const i = 1 / det;
  out[0] = (m[4] * m[8] - m[5] * m[7]) * i;
  out[1] = (m[2] * m[7] - m[1] * m[8]) * i;
  out[2] = (m[1] * m[5] - m[2] * m[4]) * i;
  out[3] = (m[5] * m[6] - m[3] * m[8]) * i;
  out[4] = (m[0] * m[8] - m[2] * m[6]) * i;
  out[5] = (m[2] * m[3] - m[0] * m[5]) * i;
  out[6] = (m[3] * m[7] - m[4] * m[6]) * i;
  out[7] = (m[1] * m[6] - m[0] * m[7]) * i;
  out[8] = (m[0] * m[4] - m[1] * m[3]) * i;
  return true;
}
function m3FrobeniusI(m) {
  const d0 = m[0] - 1, d4 = m[4] - 1, d8 = m[8] - 1;
  return Math.sqrt(d0 * d0 + m[1] * m[1] + m[2] * m[2] + m[3] * m[3] + d4 * d4 + m[5] * m[5] + m[6] * m[6] + m[7] * m[7] + d8 * d8);
}
function m3Finite(m) {
  for (let i = 0; i < 9; i++) if (!Number.isFinite(m[i])) return false;
  return true;
}
function m3MaxAbs(m) {
  let a = 0;
  for (let i = 0; i < 9; i++) a = Math.max(a, Math.abs(m[i]));
  return a;
}
function m3Polar(A, R, S) {
  if (!m3Finite(A) || m3MaxAbs(A) > 12 || m3FrobeniusI(A) > 8) {
    m3Id(R);
    m3Id(S);
    return;
  }
  m3Copy(A, R);
  for (let k = 0; k < 12; k++) {
    if (!m3Invert(R, _polarInv)) {
      m3Id(R);
      m3Id(S);
      return;
    }
    m3Transpose(_polarInv, _polarRt);
    let d = 0;
    for (let i = 0; i < 9; i++) {
      const n = 0.5 * (R[i] + _polarRt[i]);
      const e = n - R[i];
      d += e * e;
      R[i] = n;
    }
    if (d < 1e-20) break;
  }
  if (!m3Finite(R) || m3MaxAbs(R) > 4) {
    m3Id(R);
    m3Id(S);
    return;
  }
  m3Orthonormalize(R);
  if (m3Det(R) < 0) {
    R[2] = -R[2];
    R[5] = -R[5];
    R[8] = -R[8];
    m3Orthonormalize(R);
  }
  m3ClampRotation(R, 0.85);
  m3Orthonormalize(R);
  m3Transpose(R, _polarRt);
  m3Mul(_polarRt, A, S);
  S[1] = S[3] = 0.5 * (S[1] + S[3]);
  S[2] = S[6] = 0.5 * (S[2] + S[6]);
  S[5] = S[7] = 0.5 * (S[5] + S[7]);
  if (!m3Finite(S) || m3FrobeniusI(S) > 1.8) m3Id(S);
}
function m3Orthonormalize(R) {
  let x0 = R[0], y0 = R[3], z0 = R[6];
  let n = Math.hypot(x0, y0, z0) || 1;
  x0 /= n;
  y0 /= n;
  z0 /= n;
  let x1 = R[1], y1 = R[4], z1 = R[7];
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
function m3RotationAngle(R) {
  const tr = R[0] + R[4] + R[8];
  return Math.acos(Math.min(1, Math.max(-1, (tr - 1) * 0.5)));
}
function m3ClampRotation(R, maxRad) {
  const ang = m3RotationAngle(R);
  if (!(ang > maxRad) || ang < 1e-6) return;
  const t = maxRad / ang;
  R[0] = 1 + (R[0] - 1) * t;
  R[1] = R[1] * t;
  R[2] = R[2] * t;
  R[3] = R[3] * t;
  R[4] = 1 + (R[4] - 1) * t;
  R[5] = R[5] * t;
  R[6] = R[6] * t;
  R[7] = R[7] * t;
  R[8] = 1 + (R[8] - 1) * t;
  m3Orthonormalize(R);
}
function stabilizeR(c) {
  let dot = 0;
  for (let i = 0; i < 9; i++) dot += c.R[i] * c.Rprev[i];
  if (dot < 0.4) {
    for (let i = 0; i < 9; i++) c.R[i] = c.Rprev[i] * 0.82 + c.R[i] * 0.18;
    m3Orthonormalize(c.R);
    if (m3Det(c.R) < 0) {
      c.R[2] = -c.R[2];
      c.R[5] = -c.R[5];
      c.R[8] = -c.R[8];
      m3Orthonormalize(c.R);
    }
  }
  m3Copy(c.R, c.Rprev);
}
function m3OuterAdd(px, py, pz, qx, qy, qz, w, out) {
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
const _Apq = m3();
const _Aqq = m3();
const _tmp = m3();
const _tmp2 = m3();
const _I = m3Id();
const _polarInv = m3();
const _polarRt = m3();
const _vec = { x: 0, y: 0, z: 0 };
function makeCluster(particles, idx) {
  const n = idx.length;
  const c = {
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
    skinCmz: 0
  };
  let msum = 0;
  for (let i = 0; i < n; i++) {
    const p = particles[idx[i]];
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
    const p = particles[idx[i]];
    c.q0x[i] = c.qx[i] = p.x - c.cm0x;
    c.q0y[i] = c.qy[i] = p.y - c.cm0y;
    c.q0z[i] = c.qz[i] = p.z - c.cm0z;
  }
  rebuildAqqWeighted(c, particles);
  return c;
}
function rebuildAqqWeighted(c, particles) {
  m3Zero(_Aqq);
  for (let i = 0; i < c.idx.length; i++) {
    const p = particles[c.idx[i]];
    m3OuterAdd(c.qx[i], c.qy[i], c.qz[i], c.qx[i], c.qy[i], c.qz[i], p.mass, _Aqq);
  }
  _Aqq[0] += 1e-3;
  _Aqq[4] += 1e-3;
  _Aqq[8] += 1e-3;
  if (!m3Invert(_Aqq, c.AqqInv)) m3Id(c.AqqInv);
}
function matchCluster(c, particles, beta) {
  let msum = 0;
  c.cmx = 0;
  c.cmy = 0;
  c.cmz = 0;
  for (let k = 0; k < c.idx.length; k++) {
    const i = c.idx[k];
    const p = particles[i];
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
    const p = particles[c.idx[i]];
    m3OuterAdd(p.x - c.cmx, p.y - c.cmy, p.z - c.cmz, c.qx[i], c.qy[i], c.qz[i], p.mass, _Apq);
  }
  m3Mul(_Apq, c.AqqInv, c.A);
  if (!m3Finite(c.A) || m3MaxAbs(c.A) > 12) m3Id(c.A);
  m3Polar(c.A, c.R, c.S);
  stabilizeR(c);
  m3Lerp(_I, c.S, beta, _tmp);
  m3Mul(c.R, _tmp, c.M);
  if (!m3Finite(c.M) || m3MaxAbs(c.M) > 8) m3Id(c.M);
  m3Mul(c.M, c.Sp, c.skinM);
  if (!m3Finite(c.skinM) || m3MaxAbs(c.skinM) > 8) m3Id(c.skinM);
  if (!m3Invert(c.skinM, _tmp)) m3Id(_tmp);
  m3Transpose(_tmp, c.skinInvT);
}
function applyPlasticity(c, particles, dt, squash, contacting, buckle = 0.45) {
  if (squash < 0.03 && buckle < 0.03) return;
  const yieldC = 0.035 + (1 - squash) * 0.08 + (1 - buckle) * 0.04;
  const err = m3FrobeniusI(c.S);
  if (err < yieldC) return;
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
    const keep = 0.08;
    const mix = 1 + (s - 1) * keep;
    for (let i = 0; i < 9; i++) c.Sp[i] *= mix;
  }
  if (c.Sp[0] > 1.06) c.Sp[0] = 1.06;
  if (c.Sp[4] > 1.06) c.Sp[4] = 1.06;
  if (c.Sp[8] > 1.06) c.Sp[8] = 1.06;
  if (contacting) {
    const r00 = c.R[0], r11 = c.R[4], r22 = c.R[8];
    const tr = r00 + r11 + r22;
    const ang = Math.acos(Math.min(1, Math.max(-1, (tr - 1) * 0.5)));
    if (ang > 0.08) {
      m3Lerp(_I, c.R, creep * 0.45, _tmp);
      for (let i = 0; i < c.idx.length; i++) {
        m3MulVecInto(_tmp, c.q0x[i], c.q0y[i], c.q0z[i], _vec);
        c.q0x[i] = _vec.x;
        c.q0y[i] = _vec.y;
        c.q0z[i] = _vec.z;
      }
    }
  }
  for (let i = 0; i < c.idx.length; i++) {
    m3MulVecInto(c.Sp, c.q0x[i], c.q0y[i], c.q0z[i], _vec);
    c.qx[i] = _vec.x;
    c.qy[i] = _vec.y;
    c.qz[i] = _vec.z;
  }
  rebuildAqqWeighted(c, particles);
}
function resetCluster(c, particles) {
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
    const p = particles[i];
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
    const p = particles[c.idx[i]];
    c.q0x[i] = c.qx[i] = p.x - c.cm0x;
    c.q0y[i] = c.qy[i] = p.y - c.cm0y;
    c.q0z[i] = c.qz[i] = p.z - c.cm0z;
  }
  rebuildAqqWeighted(c, particles);
}
const _skinT = { x: 0, y: 0, z: 0 };
function transformSkinPointInto(c, x, y, z, out = _skinT) {
  const m = c.skinM;
  const dx = x - c.skinCm0x;
  const dy = y - c.skinCm0y;
  const dz = z - c.skinCm0z;
  out.x = m[0] * dx + m[1] * dy + m[2] * dz + c.skinCmx;
  out.y = m[3] * dx + m[4] * dy + m[5] * dz + c.skinCmy;
  out.z = m[6] * dx + m[7] * dy + m[8] * dz + c.skinCmz;
  return out;
}
function transformPoint(c, x, y, z) {
  const [px, py, pz] = m3MulVec(c.skinM, x - c.cm0x, y - c.cm0y, z - c.cm0z);
  return [px + c.cmx, py + c.cmy, pz + c.cmz];
}
function transformSkinPoint(c, x, y, z) {
  const [px, py, pz] = m3MulVec(c.skinM, x - c.skinCm0x, y - c.skinCm0y, z - c.skinCm0z);
  return [px + c.skinCmx, py + c.skinCmy, pz + c.skinCmz];
}
function transformNormal(c, x, y, z) {
  return m3MulVec(c.skinInvT, x, y, z);
}
function matchSkinLocal(c, rest, local, mass, beta) {
  let msum = 0;
  c.skinCm0x = 0;
  c.skinCm0y = 0;
  c.skinCm0z = 0;
  c.skinCmx = 0;
  c.skinCmy = 0;
  c.skinCmz = 0;
  for (let k = 0; k < c.idx.length; k++) {
    const i = c.idx[k];
    const r = rest[i];
    const p = local[i];
    const m = mass[i];
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
  for (let k = 0; k < c.idx.length; k++) {
    const i = c.idx[k];
    const r = rest[i];
    const p = local[i];
    const m = mass[i];
    m3MulVecInto(c.Sp, r.x - c.skinCm0x, r.y - c.skinCm0y, r.z - c.skinCm0z, _vec);
    m3OuterAdd(p.x - c.skinCmx, p.y - c.skinCmy, p.z - c.skinCmz, _vec.x, _vec.y, _vec.z, m, _Apq);
    m3OuterAdd(_vec.x, _vec.y, _vec.z, _vec.x, _vec.y, _vec.z, m, _Aqq);
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
function stiffnessIters(squash) {
  return Math.max(2, Math.min(5, Math.round(2 + (1.05 - squash) * 3)));
}
function goalAlpha(squash) {
  return 0.22 + (1 - squash) * 0.62;
}
function deformBeta(squash) {
  return Math.max(0, squash) * 0.9;
}

module.exports = {
  applyPlasticity,
  deformBeta,
  goalAlpha,
  m3,
  m3AddScaled,
  m3ClampRotation,
  m3Copy,
  m3Det,
  m3Finite,
  m3FrobeniusI,
  m3Id,
  m3Invert,
  m3Lerp,
  m3MaxAbs,
  m3Mul,
  m3MulVec,
  m3MulVecInto,
  m3Orthonormalize,
  m3Polar,
  m3RotationAngle,
  m3Transpose,
  m3Zero,
  makeCluster,
  matchCluster,
  matchSkinLocal,
  rebuildAqqWeighted,
  resetCluster,
  stabilizeR,
  stiffnessIters,
  transformNormal,
  transformPoint,
  transformSkinPoint,
  transformSkinPointInto,
};
