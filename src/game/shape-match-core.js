// @ts-nocheck
"use strict";
// Hand-kept JS kernel (Müller 2005 shape matching). No TS transform.

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
  for (let i = 0; i < 9; i++) out[i] = src[i];
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
function m3Det(m) {
  return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
}
function m3FrobeniusI(m) {
  const d0 = m[0] - 1, d4 = m[4] - 1, d8 = m[8] - 1;
  return Math.sqrt(d0 * d0 + m[1] * m[1] + m[2] * m[2] + m[3] * m[3] + d4 * d4 + m[5] * m[5] + m[6] * m[6] + m[7] * m[7] + d8 * d8);
}
function m3Finite(m) {
  for (let i = 0; i < 9; i++) if (!Number.isFinite(m[i])) return false;
  return true;
}
/** Every entry finite and within ±lim. */
function m3Bounded(m, lim) {
  for (let i = 0; i < 9; i++) {
    const v = m[i];
    if (!(v <= lim && v >= -lim)) return false;
  }
  return true;
}
/** Inverse of the symmetric matrix [a00 a01 a02; a01 a11 a12; a02 a12 a22] into out; identity when singular. */
function symInvertInto(a00, a01, a02, a11, a12, a22, out) {
  const c00 = a11 * a22 - a12 * a12;
  const c01 = a02 * a12 - a01 * a22;
  const c02 = a01 * a12 - a02 * a11;
  const det = a00 * c00 + a01 * c01 + a02 * c02;
  if (!(Math.abs(det) >= 1e-12)) {
    m3Id(out);
    return;
  }
  const i = 1 / det;
  out[0] = c00 * i;
  out[1] = out[3] = c01 * i;
  out[2] = out[6] = c02 * i;
  out[4] = (a00 * a22 - a02 * a02) * i;
  out[5] = out[7] = (a01 * a02 - a00 * a12) * i;
  out[8] = (a00 * a11 - a01 * a01) * i;
}

/** Unit quaternion (x, y, z, w): the warm start of a rotation extraction. */
function quatId(out = new Float64Array(4)) {
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  out[3] = 1;
  return out;
}
function quatToMat(q, R) {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, yy = y * y2, zz = z * z2;
  const xy = x * y2, xz = x * z2, yz = y * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  R[0] = 1 - yy - zz;
  R[1] = xy - wz;
  R[2] = xz + wy;
  R[3] = xy + wz;
  R[4] = 1 - xx - zz;
  R[5] = yz - wx;
  R[6] = xz - wy;
  R[7] = yz + wx;
  R[8] = 1 - xx - yy;
  return R;
}

const ROT_MAX_ITER = 16;
const ROT_TOL2 = 1e-18; // step below 1e-9 rad: converged
const ROT_ACCEPT2 = 1e-8; // Newton step below 1e-4 rad leaves an O(|w|²) residual: stop after applying it
/**
 * Müller, Bender, Chentanez, Macklin 2016, "A Robust Method to Extract the
 * Rotational Part of Deformations": rotate q about the summed torque r_i × a_i
 * of A's columns on R(q)'s columns. det R = +1 by construction, no inverse, so
 * singular A is fine (the missing axis keeps the warm start's orientation).
 *
 * The paper's step divides the torque by tr(R^T A), which converges linearly
 * (factor ~1/3 per pass on an undeformed cluster). Where the Hessian
 * H = tr(B)·I − sym(B), B = A R^T, is positive definite (near the optimum) the
 * step is the Newton step H⁻¹·torque instead: quadratic, 1–2 passes from a
 * warm start. Far from it, the dominant column of Davenport's K (Shepperd's
 * start) replaces the warm start once if it aligns better; otherwise the
 * paper's step, turned by atan|w| so a pass never exceeds a quarter turn.
 *
 * flip = −1 negates A's third column (det A < 0), see m3Polar.
 */
function extractRotation(A, flip, q) {
  const a0 = A[0], a1 = A[1], a2 = A[2] * flip;
  const a3 = A[3], a4 = A[4], a5 = A[5] * flip;
  const a6 = A[6], a7 = A[7], a8 = A[8] * flip;
  let x = q[0], y = q[1], z = q[2], w = q[3];
  let restart = true;
  for (let it = 0; it < ROT_MAX_ITER; it++) {
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, yy = y * y2, zz = z * z2;
    const xy = x * y2, xz = x * z2, yz = y * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    const r0 = 1 - yy - zz, r1 = xy - wz, r2 = xz + wy;
    const r3 = xy + wz, r4 = 1 - xx - zz, r5 = yz - wx;
    const r6 = xz - wy, r7 = yz + wx, r8 = 1 - xx - yy;
    // B = A R^T: torque = (B21 − B12, B02 − B20, B10 − B01), Σ r_i·a_i = tr B.
    const b00 = a0 * r0 + a1 * r1 + a2 * r2;
    const b01 = a0 * r3 + a1 * r4 + a2 * r5;
    const b02 = a0 * r6 + a1 * r7 + a2 * r8;
    const b10 = a3 * r0 + a4 * r1 + a5 * r2;
    const b11 = a3 * r3 + a4 * r4 + a5 * r5;
    const b12 = a3 * r6 + a4 * r7 + a5 * r8;
    const b20 = a6 * r0 + a7 * r1 + a8 * r2;
    const b21 = a6 * r3 + a7 * r4 + a8 * r5;
    const b22 = a6 * r6 + a7 * r7 + a8 * r8;
    const tx = b21 - b12, ty = b02 - b20, tz = b10 - b01;
    const tr = b00 + b11 + b22;
    const h00 = tr - b00, h11 = tr - b11, h22 = tr - b22;
    const h01 = -0.5 * (b01 + b10), h02 = -0.5 * (b02 + b20), h12 = -0.5 * (b12 + b21);
    const c00 = h11 * h22 - h12 * h12;
    const c01 = h02 * h12 - h01 * h22;
    const c02 = h01 * h12 - h02 * h11;
    const det = h00 * c00 + h01 * c01 + h02 * c02;
    let ox = 0, oy = 0, oz = 0, o2 = Infinity;
    if (h00 > 0 && h00 * h11 > h01 * h01 && det > 0) {
      const c11 = h00 * h22 - h02 * h02;
      const c12 = h01 * h02 - h00 * h12;
      const c22 = h00 * h11 - h01 * h01;
      const id = 1 / det;
      ox = (c00 * tx + c01 * ty + c02 * tz) * id;
      oy = (c01 * tx + c11 * ty + c12 * tz) * id;
      oz = (c02 * tx + c12 * ty + c22 * tz) * id;
      o2 = ox * ox + oy * oy + oz * oz;
    }
    const newton = o2 < 1;
    let dx, dy, dz;
    if (newton) {
      if (o2 < ROT_TOL2) break;
      // exp(w) to second order: angle 2·atan(|w|/2).
      dx = ox * 0.5;
      dy = oy * 0.5;
      dz = oz * 0.5;
    } else {
      if (restart) {
        restart = false;
        // q^T K q = tr(R(q)^T A); the column of K + I with the largest diagonal is Shepperd's quaternion.
        const kxx = a0 - a4 - a8, kyy = a4 - a0 - a8, kzz = a8 - a0 - a4, kww = a0 + a4 + a8;
        const kxy = a1 + a3, kxz = a2 + a6, kyz = a5 + a7;
        const kxw = a7 - a5, kyw = a2 - a6, kzw = a3 - a1;
        let cx, cy, cz, cw;
        if (kww >= kxx && kww >= kyy && kww >= kzz) {
          cx = kxw;
          cy = kyw;
          cz = kzw;
          cw = kww + 1;
        } else if (kxx >= kyy && kxx >= kzz) {
          cx = kxx + 1;
          cy = kxy;
          cz = kxz;
          cw = kxw;
        } else if (kyy >= kzz) {
          cx = kxy;
          cy = kyy + 1;
          cz = kyz;
          cw = kyw;
        } else {
          cx = kxz;
          cy = kyz;
          cz = kzz + 1;
          cw = kzw;
        }
        const kx = kxx * cx + kxy * cy + kxz * cz + kxw * cw;
        const ky = kxy * cx + kyy * cy + kyz * cz + kyw * cw;
        const kz = kxz * cx + kyz * cy + kzz * cz + kzw * cw;
        const kw = kxw * cx + kyw * cy + kzw * cz + kww * cw;
        const c2 = cx * cx + cy * cy + cz * cz + cw * cw;
        if (cx * kx + cy * ky + cz * kz + cw * kw > tr * c2) {
          const s = 1 / Math.sqrt(c2);
          x = cx * s;
          y = cy * s;
          z = cz * s;
          w = cw * s;
          continue;
        }
      }
      const s = 1 / (Math.abs(tr) + 1e-9);
      ox = tx * s;
      oy = ty * s;
      oz = tz * s;
      o2 = ox * ox + oy * oy + oz * oz;
      if (o2 < ROT_TOL2) break;
      // Turn by atan|w|: dq = (ŵ·tan(θ/2), 1).
      const h = 1 / (1 + Math.sqrt(1 + o2));
      dx = ox * h;
      dy = oy * h;
      dz = oz * h;
    }
    // q ← dq ⊗ q, dq = (dx, dy, dz, 1); |dq ⊗ q| ≥ 1.
    const nx = x + dx * w + dy * z - dz * y;
    const ny = y - dx * z + dy * w + dz * x;
    const nz = z + dx * y - dy * x + dz * w;
    const nw = w - dx * x - dy * y - dz * z;
    const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw);
    x = nx * inv;
    y = ny * inv;
    z = nz * inv;
    w = nw * inv;
    if (newton && o2 < ROT_ACCEPT2) break;
  }
  q[0] = x;
  q[1] = y;
  q[2] = z;
  q[3] = w;
}

const ROT_CLAMP = 0.85;
const COS_ROT_CLAMP = Math.cos(ROT_CLAMP);
/**
 * A = R·S with R a proper rotation (|angle| clamped to 0.85 rad) and S = sym(R^T A)
 * (identity past |S − I| 1.8). q is the caller's warm start and receives the
 * unclamped rotation. det A < 0 keeps the polar factor with its third column
 * flipped (the cluster's own z), as the Newton polar + Gram–Schmidt it
 * replaces did, rather than the Frobenius-optimal half-turn about another axis.
 */
function m3Polar(A, q, R, S) {
  if (!m3Finite(A)) {
    m3Id(R);
    m3Id(S);
    return;
  }
  extractRotation(A, m3Det(A) < 0 ? -1 : 1, q);
  quatToMat(q, R);
  clampRotation(R, ROT_CLAMP, COS_ROT_CLAMP);
  const a0 = A[0], a1 = A[1], a2 = A[2], a3 = A[3], a4 = A[4], a5 = A[5], a6 = A[6], a7 = A[7], a8 = A[8];
  const r0 = R[0], r1 = R[1], r2 = R[2], r3 = R[3], r4 = R[4], r5 = R[5], r6 = R[6], r7 = R[7], r8 = R[8];
  const s0 = r0 * a0 + r3 * a3 + r6 * a6;
  const s4 = r1 * a1 + r4 * a4 + r7 * a7;
  const s8 = r2 * a2 + r5 * a5 + r8 * a8;
  const s01 = 0.5 * (r0 * a1 + r3 * a4 + r6 * a7 + (r1 * a0 + r4 * a3 + r7 * a6));
  const s02 = 0.5 * (r0 * a2 + r3 * a5 + r6 * a8 + (r2 * a0 + r5 * a3 + r8 * a6));
  const s12 = 0.5 * (r1 * a2 + r4 * a5 + r7 * a8 + (r2 * a1 + r5 * a4 + r8 * a7));
  const d0 = s0 - 1, d4 = s4 - 1, d8 = s8 - 1;
  if (!(d0 * d0 + d4 * d4 + d8 * d8 + 2 * (s01 * s01 + s02 * s02 + s12 * s12) <= 1.8 * 1.8)) {
    m3Id(S);
    return;
  }
  S[0] = s0;
  S[1] = S[3] = s01;
  S[2] = S[6] = s02;
  S[4] = s4;
  S[5] = S[7] = s12;
  S[8] = s8;
}
function m3Orthonormalize(R) {
  let x0 = R[0], y0 = R[3], z0 = R[6];
  let n = Math.sqrt(x0 * x0 + y0 * y0 + z0 * z0) || 1;
  x0 /= n;
  y0 /= n;
  z0 /= n;
  let x1 = R[1], y1 = R[4], z1 = R[7];
  const d = x1 * x0 + y1 * y0 + z1 * z0;
  x1 -= d * x0;
  y1 -= d * y0;
  z1 -= d * z0;
  n = Math.sqrt(x1 * x1 + y1 * y1 + z1 * z1) || 1;
  x1 /= n;
  y1 /= n;
  z1 /= n;
  // Third column = first × second, so det R = |c0|²|c1|² − (c0·c1)² ≥ 0: never a reflection.
  R[0] = x0;
  R[3] = y0;
  R[6] = z0;
  R[1] = x1;
  R[4] = y1;
  R[7] = z1;
  R[2] = y0 * z1 - z0 * y1;
  R[5] = z0 * x1 - x0 * z1;
  R[8] = x0 * y1 - y0 * x1;
}
function m3RotationAngle(R) {
  const tr = R[0] + R[4] + R[8];
  return Math.acos(Math.min(1, Math.max(-1, (tr - 1) * 0.5)));
}
function clampRotation(R, maxRad, cosMax) {
  const cosA = (R[0] + R[4] + R[8] - 1) * 0.5;
  if (!(cosA < cosMax)) return;
  const ang = Math.acos(Math.max(-1, cosA));
  if (ang < 1e-6) return;
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
function m3ClampRotation(R, maxRad) {
  clampRotation(R, maxRad, Math.cos(maxRad));
}
function stabilizeMat(R, Rprev) {
  let idle = 0;
  for (let i = 0; i < 9; i++) {
    const d = Rprev[i] - (i === 0 || i === 4 || i === 8 ? 1 : 0);
    idle += d * d;
  }
  if (idle < 1e-12) {
    m3Copy(R, Rprev);
    return;
  }
  let dot = 0;
  for (let i = 0; i < 9; i++) dot += R[i] * Rprev[i];
  if (dot < 0) {
    for (let i = 0; i < 9; i++) R[i] = -R[i];
    dot = -dot;
  }
  const t = dot < 0.35 ? 0.08 : dot < 0.7 ? 0.22 : 0.55;
  for (let i = 0; i < 9; i++) R[i] = Rprev[i] * (1 - t) + R[i] * t;
  m3Orthonormalize(R);
  m3Copy(R, Rprev);
}
function stabilizeR(c) {
  stabilizeMat(c.R, c.Rprev);
}

// Aqq + AQQ_EPS·I keeps flat clusters invertible.
const AQQ_EPS = 1e-3;
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
    planar: false,
    Sp: m3Id(),
    A: m3Id(),
    R: m3Id(),
    S: m3Id(),
    M: m3Id(),
    skinM: m3Id(),
    Rprev: m3Id(),
    rotQ: quatId(),
    skinR: m3Id(),
    skinRprev: m3Id(),
    skinRotQ: quatId(),
    skinCm0x: 0,
    skinCm0y: 0,
    skinCm0z: 0,
    skinCmx: 0,
    skinCmy: 0,
    skinCmz: 0
  };
  restCluster(c, particles);
  return c;
}
function restCluster(c, particles) {
  const idx = c.idx;
  let msum = 0, sx = 0, sy = 0, sz = 0;
  for (let i = 0; i < idx.length; i++) {
    const p = particles[idx[i]];
    sx += p.x * p.mass;
    sy += p.y * p.mass;
    sz += p.z * p.mass;
    msum += p.mass;
  }
  msum = Math.max(msum, 1e-8);
  c.cm0x = sx / msum;
  c.cm0y = sy / msum;
  c.cm0z = sz / msum;
  c.skinCm0x = c.skinCmx = c.cm0x;
  c.skinCm0y = c.skinCmy = c.cm0y;
  c.skinCm0z = c.skinCmz = c.cm0z;
  for (let i = 0; i < idx.length; i++) {
    const p = particles[idx[i]];
    c.q0x[i] = c.qx[i] = p.x - c.cm0x;
    c.q0y[i] = c.qy[i] = p.y - c.cm0y;
    c.q0z[i] = c.qz[i] = p.z - c.cm0z;
  }
  rebuildAqqWeighted(c, particles);
}
function rebuildAqqWeighted(c, particles) {
  const idx = c.idx, qx = c.qx, qy = c.qy, qz = c.qz;
  let a00 = 0, a01 = 0, a02 = 0, a11 = 0, a12 = 0, a22 = 0;
  for (let i = 0; i < idx.length; i++) {
    const m = particles[idx[i]].mass;
    const x = qx[i], y = qy[i], z = qz[i];
    const mx = m * x, my = m * y;
    a00 += mx * x;
    a01 += mx * y;
    a02 += mx * z;
    a11 += my * y;
    a12 += my * z;
    a22 += m * z * z;
  }
  // A flat rest shape (3 particles, or a coplanar quad like bumpers + engines) gives
  // A = Apq·Aqq⁻¹ of rank 2 at every pose; plastic Sp and contact turns keep it flat.
  // Such a cluster pins translation only (R = S = I): the rig is tuned for that, and
  // letting those clusters rotate moves the door-hinge, nose-gap and barrier-corner
  // scenarios across their thresholds.
  const tr = (a00 + a11 + a22) / 3;
  const det = a00 * (a11 * a22 - a12 * a12) - a01 * (a01 * a22 - a12 * a02) + a02 * (a01 * a12 - a11 * a02);
  c.planar = det <= 1e-6 * tr * tr * tr;
  symInvertInto(a00 + AQQ_EPS, a01, a02, a11 + AQQ_EPS, a12, a22 + AQQ_EPS, c.AqqInv);
}
/** out = Apq · inv, Apq row-major in p0..p8. */
function fitInto(p0, p1, p2, p3, p4, p5, p6, p7, p8, inv, out) {
  const i0 = inv[0], i1 = inv[1], i2 = inv[2], i3 = inv[3], i4 = inv[4], i5 = inv[5], i6 = inv[6], i7 = inv[7], i8 = inv[8];
  out[0] = p0 * i0 + p1 * i3 + p2 * i6;
  out[1] = p0 * i1 + p1 * i4 + p2 * i7;
  out[2] = p0 * i2 + p1 * i5 + p2 * i8;
  out[3] = p3 * i0 + p4 * i3 + p5 * i6;
  out[4] = p3 * i1 + p4 * i4 + p5 * i7;
  out[5] = p3 * i2 + p4 * i5 + p5 * i8;
  out[6] = p6 * i0 + p7 * i3 + p8 * i6;
  out[7] = p6 * i1 + p7 * i4 + p8 * i7;
  out[8] = p6 * i2 + p7 * i5 + p8 * i8;
}
/** out = R·(I + beta·(S − I)), S symmetric; identity unless every entry is within ±lim. */
function blendStretchInto(R, S, beta, lim, out) {
  const u = 1 - beta;
  const t0 = u + S[0] * beta, t4 = u + S[4] * beta, t8 = u + S[8] * beta;
  const t1 = S[1] * beta, t2 = S[2] * beta, t5 = S[5] * beta;
  const r0 = R[0], r1 = R[1], r2 = R[2], r3 = R[3], r4 = R[4], r5 = R[5], r6 = R[6], r7 = R[7], r8 = R[8];
  out[0] = r0 * t0 + r1 * t1 + r2 * t2;
  out[1] = r0 * t1 + r1 * t4 + r2 * t5;
  out[2] = r0 * t2 + r1 * t5 + r2 * t8;
  out[3] = r3 * t0 + r4 * t1 + r5 * t2;
  out[4] = r3 * t1 + r4 * t4 + r5 * t5;
  out[5] = r3 * t2 + r4 * t5 + r5 * t8;
  out[6] = r6 * t0 + r7 * t1 + r8 * t2;
  out[7] = r6 * t1 + r7 * t4 + r8 * t5;
  out[8] = r6 * t2 + r7 * t5 + r8 * t8;
  if (!m3Bounded(out, lim)) m3Id(out);
}
function matchCluster(c, particles, beta) {
  const idx = c.idx, qx = c.qx, qy = c.qy, qz = c.qz;
  let msum = 0, sx = 0, sy = 0, sz = 0, ux = 0, uy = 0, uz = 0;
  let p0 = 0, p1 = 0, p2 = 0, p3 = 0, p4 = 0, p5 = 0, p6 = 0, p7 = 0, p8 = 0;
  for (let k = 0; k < idx.length; k++) {
    const p = particles[idx[k]];
    const m = p.mass;
    const mx = p.x * m, my = p.y * m, mz = p.z * m;
    const a = qx[k], b = qy[k], d = qz[k];
    msum += m;
    sx += mx;
    sy += my;
    sz += mz;
    ux += m * a;
    uy += m * b;
    uz += m * d;
    p0 += mx * a;
    p1 += mx * b;
    p2 += mx * d;
    p3 += my * a;
    p4 += my * b;
    p5 += my * d;
    p6 += mz * a;
    p7 += mz * b;
    p8 += mz * d;
  }
  msum = Math.max(msum, 1e-8);
  const cmx = sx / msum, cmy = sy / msum, cmz = sz / msum;
  c.cmx = cmx;
  c.cmy = cmy;
  c.cmz = cmz;
  if (c.planar) {
    m3Id(c.R);
    m3Id(c.S);
  } else {
    // Σ m (x − cm) q^T = Σ m x q^T − cm (Σ m q)^T
    fitInto(p0 - cmx * ux, p1 - cmx * uy, p2 - cmx * uz, p3 - cmy * ux, p4 - cmy * uy, p5 - cmy * uz, p6 - cmz * ux, p7 - cmz * uy, p8 - cmz * uz, c.AqqInv, c.A);
    m3Polar(c.A, c.rotQ, c.R, c.S);
  }
  stabilizeMat(c.R, c.Rprev);
  blendStretchInto(c.R, c.S, beta, 8, c.M);
}
const COS_PLASTIC_ROT = Math.cos(0.08);
function applyPlasticity(c, particles, dt, squash, contacting, buckle = 0.45) {
  if (squash < 0.03 && buckle < 0.03) return;
  const yieldC = 0.035 + (1 - squash) * 0.08 + (1 - buckle) * 0.04;
  const S = c.S, Sp = c.Sp;
  const err = m3FrobeniusI(S);
  if (err < yieldC) return;
  const creep = Math.min(0.85, (0.35 + squash * 1.25 + buckle * 0.55) * Math.max(dt, 1 / 120) * 10);
  {
    // Sp ← Sp·(I + creep·(S − I))
    const u = 1 - creep;
    const t0 = u + S[0] * creep, t1 = S[1] * creep, t2 = S[2] * creep;
    const t3 = S[3] * creep, t4 = u + S[4] * creep, t5 = S[5] * creep;
    const t6 = S[6] * creep, t7 = S[7] * creep, t8 = u + S[8] * creep;
    for (let r = 0; r < 9; r += 3) {
      const s0 = Sp[r], s1 = Sp[r + 1], s2 = Sp[r + 2];
      Sp[r] = s0 * t0 + s1 * t3 + s2 * t6;
      Sp[r + 1] = s0 * t1 + s1 * t4 + s2 * t7;
      Sp[r + 2] = s0 * t2 + s1 * t5 + s2 * t8;
    }
  }
  const maxE = 0.18 + squash * 0.55 + buckle * 0.4;
  const pe = m3FrobeniusI(Sp);
  if (pe > maxE) {
    const t = maxE / pe;
    for (let i = 0; i < 9; i++) Sp[i] = (i === 0 || i === 4 || i === 8 ? 1 - t : 0) + Sp[i] * t;
  }
  const det = m3Det(Sp);
  if (det > 1e-6) {
    const s = Math.cbrt(1 / det);
    const keep = 0.08;
    const mix = 1 + (s - 1) * keep;
    for (let i = 0; i < 9; i++) Sp[i] *= mix;
  }
  if (Sp[0] > 1.06) Sp[0] = 1.06;
  if (Sp[4] > 1.06) Sp[4] = 1.06;
  if (Sp[8] > 1.06) Sp[8] = 1.06;
  // Contact with a real rotation (> 0.08 rad) creeps the rest shape toward it: q0 ← (I + k(R − I)) q0.
  const R = c.R;
  const k = creep * 0.45;
  const turn = contacting && (R[0] + R[4] + R[8] - 1) * 0.5 < COS_PLASTIC_ROT;
  const ku = 1 - k;
  const l0 = ku + R[0] * k, l1 = R[1] * k, l2 = R[2] * k;
  const l3 = R[3] * k, l4 = ku + R[4] * k, l5 = R[5] * k;
  const l6 = R[6] * k, l7 = R[7] * k, l8 = ku + R[8] * k;
  const sp0 = Sp[0], sp1 = Sp[1], sp2 = Sp[2], sp3 = Sp[3], sp4 = Sp[4], sp5 = Sp[5], sp6 = Sp[6], sp7 = Sp[7], sp8 = Sp[8];
  const idx = c.idx, q0x = c.q0x, q0y = c.q0y, q0z = c.q0z, qx = c.qx, qy = c.qy, qz = c.qz;
  let a00 = 0, a01 = 0, a02 = 0, a11 = 0, a12 = 0, a22 = 0;
  for (let i = 0; i < idx.length; i++) {
    let x = q0x[i], y = q0y[i], z = q0z[i];
    if (turn) {
      const rx = l0 * x + l1 * y + l2 * z;
      const ry = l3 * x + l4 * y + l5 * z;
      const rz = l6 * x + l7 * y + l8 * z;
      q0x[i] = x = rx;
      q0y[i] = y = ry;
      q0z[i] = z = rz;
    }
    const vx = sp0 * x + sp1 * y + sp2 * z;
    const vy = sp3 * x + sp4 * y + sp5 * z;
    const vz = sp6 * x + sp7 * y + sp8 * z;
    qx[i] = vx;
    qy[i] = vy;
    qz[i] = vz;
    const m = particles[idx[i]].mass;
    const mx = m * vx, my = m * vy;
    a00 += mx * vx;
    a01 += mx * vy;
    a02 += mx * vz;
    a11 += my * vy;
    a12 += my * vz;
    a22 += m * vz * vz;
  }
  symInvertInto(a00 + AQQ_EPS, a01, a02, a11 + AQQ_EPS, a12, a22 + AQQ_EPS, c.AqqInv);
}
function resetCluster(c, particles) {
  m3Id(c.Sp);
  m3Id(c.A);
  m3Id(c.R);
  m3Id(c.S);
  m3Id(c.M);
  m3Id(c.skinM);
  m3Id(c.Rprev);
  quatId(c.rotQ);
  m3Id(c.skinR);
  m3Id(c.skinRprev);
  quatId(c.skinRotQ);
  restCluster(c, particles);
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
const _normalT = { x: 0, y: 0, z: 0 };
/** (skinM⁻¹)^T n, built on demand (no frame path transforms normals); n unchanged when skinM is singular. */
function transformNormal(c, x, y, z, out = _normalT) {
  const m = c.skinM;
  const m0 = m[0], m1 = m[1], m2 = m[2], m3v = m[3], m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7], m8 = m[8];
  const c00 = m4 * m8 - m5 * m7, c01 = m5 * m6 - m3v * m8, c02 = m3v * m7 - m4 * m6;
  const det = m0 * c00 + m1 * c01 + m2 * c02;
  if (!(Math.abs(det) >= 1e-12)) {
    out.x = x;
    out.y = y;
    out.z = z;
    return out;
  }
  const i = 1 / det;
  out.x = (c00 * x + c01 * y + c02 * z) * i;
  out.y = ((m2 * m7 - m1 * m8) * x + (m0 * m8 - m2 * m6) * y + (m1 * m6 - m0 * m7) * z) * i;
  out.z = ((m1 * m5 - m2 * m4) * x + (m2 * m3v - m0 * m5) * y + (m0 * m4 - m1 * m3v) * z) * i;
  return out;
}
function matchSkinLocal(c, rest, local, mass, beta) {
  const idx = c.idx;
  let msum = 0, rx = 0, ry = 0, rz = 0, px = 0, py = 0, pz = 0;
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    const r = rest[i];
    const p = local[i];
    const m = mass[i];
    rx += r.x * m;
    ry += r.y * m;
    rz += r.z * m;
    px += p.x * m;
    py += p.y * m;
    pz += p.z * m;
    msum += m;
  }
  msum = Math.max(msum, 1e-8);
  const cr0 = rx / msum, cr1 = ry / msum, cr2 = rz / msum;
  const cp0 = px / msum, cp1 = py / msum, cp2 = pz / msum;
  c.skinCm0x = cr0;
  c.skinCm0y = cr1;
  c.skinCm0z = cr2;
  c.skinCmx = cp0;
  c.skinCmy = cp1;
  c.skinCmz = cp2;
  if (c.planar) {
    m3Id(c.skinR);
    m3Id(c.S);
    stabilizeMat(c.skinR, c.skinRprev);
    blendStretchInto(c.skinR, c.S, beta, 4, c.skinM);
    return;
  }
  const Sp = c.Sp;
  const sp0 = Sp[0], sp1 = Sp[1], sp2 = Sp[2], sp3 = Sp[3], sp4 = Sp[4], sp5 = Sp[5], sp6 = Sp[6], sp7 = Sp[7], sp8 = Sp[8];
  let p0 = 0, p1 = 0, p2 = 0, p3 = 0, p4 = 0, p5 = 0, p6 = 0, p7 = 0, p8 = 0;
  let a00 = AQQ_EPS, a01 = 0, a02 = 0, a11 = AQQ_EPS, a12 = 0, a22 = AQQ_EPS;
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    const r = rest[i];
    const p = local[i];
    const m = mass[i];
    const x = r.x - cr0, y = r.y - cr1, z = r.z - cr2;
    const vx = sp0 * x + sp1 * y + sp2 * z;
    const vy = sp3 * x + sp4 * y + sp5 * z;
    const vz = sp6 * x + sp7 * y + sp8 * z;
    const ex = (p.x - cp0) * m, ey = (p.y - cp1) * m, ez = (p.z - cp2) * m;
    p0 += ex * vx;
    p1 += ex * vy;
    p2 += ex * vz;
    p3 += ey * vx;
    p4 += ey * vy;
    p5 += ey * vz;
    p6 += ez * vx;
    p7 += ez * vy;
    p8 += ez * vz;
    const mx = m * vx, my = m * vy;
    a00 += mx * vx;
    a01 += mx * vy;
    a02 += mx * vz;
    a11 += my * vy;
    a12 += my * vz;
    a22 += m * vz * vz;
  }
  symInvertInto(a00, a01, a02, a11, a12, a22, _AqqInv);
  fitInto(p0, p1, p2, p3, p4, p5, p6, p7, p8, _AqqInv, c.A);
  m3Polar(c.A, c.skinRotQ, c.skinR, c.S);
  stabilizeMat(c.skinR, c.skinRprev);
  blendStretchInto(c.skinR, c.S, beta, 4, c.skinM);
}
const _AqqInv = m3();
function stiffnessIters(squash) {
  return Math.max(2, Math.min(5, Math.round(2 + (1.05 - squash) * 3)));
}
function goalAlpha(squash) {
  return 0.22 + (1 - squash) * 0.62;
}
function deformBeta(squash) {
  return Math.max(0, squash) * 0.9;
}

export {
  applyPlasticity,
  deformBeta,
  goalAlpha,
  m3,
  m3ClampRotation,
  m3Copy,
  m3Det,
  m3Finite,
  m3FrobeniusI,
  m3Id,
  m3Mul,
  m3Orthonormalize,
  m3Polar,
  m3RotationAngle,
  makeCluster,
  matchCluster,
  matchSkinLocal,
  quatId,
  rebuildAqqWeighted,
  resetCluster,
  stabilizeR,
  stiffnessIters,
  transformNormal,
  transformSkinPointInto,
};
