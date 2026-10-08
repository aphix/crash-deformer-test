// @ts-nocheck
"use strict";

/**
 * Number-only crash kernels. Plain JS — no TS transform, no THREE.
 * physics-util.ts re-exports these and adds Vector3 helpers.
 */

function clamp(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}

const CRASH = {
  pulseSec: 0.12,
  crushMeters: 0.65,
  muPeak: 0.9,
  muSlide: 0.75,
  muScuff: 0.4,
  grazeMps: 1.8,
  maxMassMps: 55,
};

const TRANSFER = {
  belowMiddle: 0.1,
  atMiddle: 0.5,
  above: 0.62,
  packed: 1,
};

const FRONTAL_REF = 14;

function regionSoftness(name) {
  if (name.startsWith("bumper")) return 1;
  if (name.startsWith("wing")) return 0.78;
  if (name === "engineL" || name === "engineR") return 0.16;
  if (name.startsWith("rail")) return 0.3;
  if (name.startsWith("door")) return 0.22;
  if (name === "tank" || name === "axleR") return 0.34;
  if (name === "roof" || name === "cell") return 0.08;
  if (name.startsWith("hub")) return 0.06;
  return 0.2;
}

function crushGate(closing, softness) {
  const v = closing > 0 ? closing : 0;
  const min = CRASH.grazeMps + (1 - softness) * 9;
  const fatal = 7 + (1 - softness) * 26;
  if (v <= min) return 0;
  return clamp((v - min) / Math.max(0.5, fatal - min), 0, 1);
}

function dtImpulseScale(dt) {
  return clamp(dt * 60, 0.04, 1.2);
}

function closingKeScale(closing) {
  const v = closing > 0 ? closing : 0;
  return clamp((v * v) / (FRONTAL_REF * FRONTAL_REF), 0, 2.4);
}

function regionCrushBands(name) {
  const soft = regionSoftness(name);
  const max = 0.12 + soft * 0.72;
  return { yield: max * 0.16, middle: max * 0.48, max };
}

function forceTransfer(travel, bands, packed) {
  if (packed) return TRANSFER.packed;
  const t = travel > 0 ? travel : 0;
  if (t < bands.middle) return TRANSFER.belowMiddle;
  if (t < bands.max) return TRANSFER.atMiddle;
  return TRANSFER.above;
}

function leftoverPass(remain, pass) {
  return (remain > 0 ? remain : 0) * clamp(pass, 0, 1);
}

function leftoverCrumple(travel) {
  return clamp(travel / 1.5, 0, 1);
}

/**
 * Dynamic crush (m) a struck end takes at an equivalent barrier speed `ebs`
 * (m/s): 0.52 m at 56 km/h, ~0.27 m at 28 km/h (NCAP/IIHS full-frontal) at
 * the default squash 0.32; the squash slider scales it by (0.6 + squash).
 */
function crushStroke(ebs, squash) {
  return (0.035 * (ebs > 0 ? ebs : 0) + 0.02) * (0.6 + squash);
}

function cancelClosing(closing, pass, invSum, dt, e) {
  if (e === undefined) e = 0;
  if (closing <= 1e-6 || invSum < 1e-12) return 0;
  const used = leftoverPass(closing, pass);
  const dtS = dtImpulseScale(dt);
  const bounce = 1 + clamp(e, 0, 0.08);
  const dv = Math.min(used * dtS * bounce, closing * bounce);
  return dv / invSum;
}

function satPushCap(dt) {
  return 0.01 + 0.08 * dtImpulseScale(dt);
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/**
 * Math.hypot of two or three numbers, bit for bit: V8's MathHypot (math.tq) scales by the largest |arg|,
 * Kahan-sums the squares and returns sqrt × largest. TurboFan never inlines the builtin, so each call
 * boxed its arguments and result and allocated a scratch array: ~3.4 MB/s of race-physics garbage.
 * With two args the first term is exact, so the compensation is 0. Infinity and NaN come back as `max` and
 * `x + y`: a never-run `return Infinity` is a global load with no feedback, and its tagged result made
 * TurboFan box every inlined result.
 */
function hypot2(x, y) {
  x = Math.abs(x);
  y = Math.abs(y);
  let max = 0;
  if (x > max) max = x;
  if (y > max) max = y;
  if (max > Number.MAX_VALUE) return max;
  if (x !== x || y !== y) return x + y;
  if (max === 0) return 0;
  const a = x / max;
  const b = y / max;
  return Math.sqrt(a * a + b * b) * max;
}

function hypot3(x, y, z) {
  x = Math.abs(x);
  y = Math.abs(y);
  z = Math.abs(z);
  let max = 0;
  if (x > max) max = x;
  if (y > max) max = y;
  if (z > max) max = z;
  if (max > Number.MAX_VALUE) return max;
  if (x !== x || y !== y || z !== z) return x + y + z;
  if (max === 0) return 0;
  const a = x / max;
  const b = y / max;
  const c = z / max;
  const s = a * a + b * b;
  const comp = s - a * a - b * b;
  return Math.sqrt(s + (c * c - comp)) * max;
}

/**
 * Math.sin / Math.cos return different last bits in V8 and SpiderMonkey (each takes its own libm), so a race replayed in
 * another browser drifted from frame 296 on. These two use only + − × ÷ and Math.abs/floor/fround, which IEEE 754 fixes
 * bit for bit on every engine: fdlibm's reduction by π/2 (three-part Cody-Waite, the 2nd and 3rd parts only when the
 * first cancelled) and its degree-13 sin and degree-14 cos kernels on [-π/4, π/4]; past 1.6e6 rad (2^20·π/2) the
 * reduction runs in BigInt. Measured against a 140-bit BigInt oracle (`trig.test.ts`): within 1 ulp of the correctly
 * rounded value, and equal to it for about 94 % of arguments, up to 1e20 rad. |x| of 2^100 or more and non-finite x give
 * NaN; ±0 comes back as itself.
 */
const INV_PIO2 = 6.36619772367581382433e-1;
const PIO2_1 = 1.5707963267341256e0;
const PIO2_1T = 6.077100506506192e-11;
const PIO2_2 = 6.0771005063039660e-11;
const PIO2_2T = 2.0222662487959506e-21;
const PIO2_3 = 2.0222662487111665e-21;
const PIO2_3T = 8.4784276603688996e-32;
const PIO4 = 0.7853981633974483;
const S1 = -1.66666666666666324348e-1;
const S2 = 8.33333333332248946124e-3;
const S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6;
const S5 = -2.50507602534068634195e-8;
const S6 = 1.58969099521155010221e-10;
const C1 = 4.16666666666666019037e-2;
const C2 = -1.38888888888741095749e-3;
const C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7;
const C5 = 2.08757232129817482790e-9;
const C6 = -1.13596475577881948265e-11;
const REDUCED = new Float64Array(2);

// Past this many quarter turns (2^20, 1.6e6 rad) n × PIO2_1 is no longer exact, so the reduction runs in BigInt (rare: the
// AI dice hash reaches 7e6 rad a few times in a thousand frames). BigInt arithmetic is exact, so it is as engine-independent.
const MEDIUM_QUADRANTS = 1048576;
const LARGE_BITS = 300n;
const LARGE_LIMIT = 2 ** 100;
const LARGE_SCALE = 2 ** -300;
const bitView = new DataView(new ArrayBuffer(8));
// π/2 = 8·arctan(1/5) − 2·arctan(1/239) (Machin), to LARGE_BITS fractional bits: 0.07 ms at load.
const HALF_PI_FIXED = (8n * arctanReciprocal(5n) - 2n * arctanReciprocal(239n)) >> 32n;

/** arctan(1/n) in fixed point at LARGE_BITS + 32 bits. */
function arctanReciprocal(n) {
  const one = 1n << (LARGE_BITS + 32n);
  let term = one / n;
  let sum = term;
  let odd = 1n;
  let sign = -1n;
  while (term !== 0n) {
    term /= n * n;
    odd += 2n;
    sum += sign * (term / odd);
    sign = -sign;
  }
  return sum;
}

function reduceLarge(ax) {
  if (ax >= LARGE_LIMIT) {
    REDUCED[0] = NaN;
    REDUCED[1] = 0;
    return 0;
  }
  bitView.setFloat64(0, ax);
  const bits = bitView.getBigUint64(0);
  const mantissa = (bits & 0xfffffffffffffn) | 0x10000000000000n;
  const shift = BigInt(Number((bits >> 52n) & 0x7ffn) - 1075) + LARGE_BITS;
  const fixed = shift >= 0n ? mantissa << shift : mantissa >> -shift;
  const quarterTurns = (fixed + (HALF_PI_FIXED >> 1n)) / HALF_PI_FIXED;
  const remainder = fixed - quarterTurns * HALF_PI_FIXED;
  const head = Number(remainder);
  REDUCED[0] = head * LARGE_SCALE;
  REDUCED[1] = Number(remainder - BigInt(head)) * LARGE_SCALE;
  return Number(quarterTurns & 3n);
}

/** n = nearest multiple of π/2 to `ax` (≥ 0); the remainder y0 + y1 (|y0| ≲ π/4) goes to REDUCED. */
function reducePio2(ax) {
  const n = Math.floor(ax * INV_PIO2 + 0.5);
  if (n >= MEDIUM_QUADRANTS) return reduceLarge(ax);
  let r = ax - n * PIO2_1;
  let w = n * PIO2_1T;
  let y0 = r - w;
  // 2^-16 and 2^-49: fdlibm's exponent gaps (16 and 49 bits lost) as magnitudes, so no bit reads.
  if (Math.abs(y0) < ax * 1.52587890625e-5) {
    let t = r;
    w = n * PIO2_2;
    r = t - w;
    w = n * PIO2_2T - ((t - r) - w);
    y0 = r - w;
    if (Math.abs(y0) < ax * 1.7763568394002505e-15) {
      t = r;
      w = n * PIO2_3;
      r = t - w;
      w = n * PIO2_3T - ((t - r) - w);
      y0 = r - w;
    }
  }
  REDUCED[0] = y0;
  REDUCED[1] = r - y0 - w;
  return n;
}

/** sin(x) for |x| ≤ π/4 with no tail: fdlibm's `iy = 0` form, one rounding fewer than `kernelSin(x, 0)`. */
function kernelSinSmall(x) {
  const z = x * x;
  const v = z * x;
  return x + v * (S1 + z * (S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)))));
}

/** sin(x + y) for |x| ≤ π/4, y the tail of x. */
function kernelSin(x, y) {
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  return x - ((z * (0.5 * y - v * r) - y) - v * S1);
}

/** cos(x + y) for |x| ≤ π/4, y the tail of x. */
function kernelCos(x, y) {
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  const ax = Math.abs(x);
  if (ax < 0.3) return 1 - (0.5 * z - (z * r - x * y));
  // Past 0.3 split 1 - z/2 so the big part (qx, ≈ |x|/4 on a 24-bit grid) subtracts exactly; fdlibm clears low bits of x/4.
  const qx = ax > 0.78125 ? 0.28125 : Math.fround(ax * 0.25);
  return 1 - qx - (0.5 * z - qx - (z * r - x * y));
}

function detSin(x) {
  if (x === 0) return x;
  const ax = Math.abs(x);
  let s;
  if (ax <= PIO4) {
    s = kernelSinSmall(ax);
  } else {
    const n = reducePio2(ax);
    const q = n & 3;
    if (q === 0) s = kernelSin(REDUCED[0], REDUCED[1]);
    else if (q === 1) s = kernelCos(REDUCED[0], REDUCED[1]);
    else if (q === 2) s = -kernelSin(REDUCED[0], REDUCED[1]);
    else s = -kernelCos(REDUCED[0], REDUCED[1]);
  }
  return x < 0 ? -s : s;
}

function detCos(x) {
  const ax = Math.abs(x);
  if (ax <= PIO4) return kernelCos(ax, 0);
  const n = reducePio2(ax);
  const q = n & 3;
  if (q === 0) return kernelCos(REDUCED[0], REDUCED[1]);
  if (q === 1) return -kernelSin(REDUCED[0], REDUCED[1]);
  if (q === 2) return -kernelCos(REDUCED[0], REDUCED[1]);
  return kernelSin(REDUCED[0], REDUCED[1]);
}

export {
  CRASH,
  TRANSFER,
  regionSoftness,
  crushGate,
  dtImpulseScale,
  closingKeScale,
  regionCrushBands,
  forceTransfer,
  leftoverPass,
  leftoverCrumple,
  crushStroke,
  cancelClosing,
  satPushCap,
  round4,
  hypot2,
  hypot3,
  detSin,
  detCos,
};
