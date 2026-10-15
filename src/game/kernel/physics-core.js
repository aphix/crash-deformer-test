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

/** Closing speed (m/s) at which the crush gate reaches 1 (about 50 km/h); the gate grows with its square. */
const FRONTAL_REF = 14;

/** The name prefixes that tell a body part's family: mass nodes (`bumperFL`), cages and sensors (`bumperFront`), detach parts (`mirrorL`), glass and panels (`doorL`, `quarterR`). */
const PART_FAMILY = Object.freeze({ bumper: "bumper", wing: "wing", rail: "rail", door: "door", hub: "hub", mirror: "mirror", quarter: "quarter" });

function regionSoftness(name) {
  if (name.startsWith(PART_FAMILY.bumper)) return 1;
  if (name.startsWith(PART_FAMILY.wing)) return 0.78;
  if (name === "engineL" || name === "engineR") return 0.16;
  if (name.startsWith(PART_FAMILY.rail)) return 0.3;
  if (name.startsWith(PART_FAMILY.door)) return 0.22;
  if (name === "tank" || name === "axleR") return 0.34;
  if (name === "roof" || name === "cell") return 0.08;
  if (name.startsWith(PART_FAMILY.hub)) return 0.06;
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

/**
 * `detSin(v[i])` into `v[i]` and `detCos(v[i])` into `v[i + 1]`, one reduction for both, the same bits as the two calls: the
 * kernels' operations written out here in their order (`kernelSinSmall`, `kernelSin`, `kernelCos`), and the angle in and the
 * pair out through the typed array, so a call that is not inlined boxes no argument, no result and no kernel result (each
 * `detSin`/`detCos` call left out of its caller's inlining budget boxed two numbers, and its kernel call another).
 */
function sinCosAt(v, i) {
  const x = v[i];
  const ax = Math.abs(x);
  const near = ax <= PIO4;
  let q = 0;
  let a = ax;
  let t = 0;
  if (!near) {
    q = reducePio2(ax) & 3;
    a = REDUCED[0];
    t = REDUCED[1];
  }
  const z = a * a;
  const w = z * a;
  const ks = near
    ? a + w * (S1 + z * (S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)))))
    : a - ((z * (0.5 * t - w * (S2 + z * (S3 + z * (S4 + z * (S5 + z * S6))))) - t) - w * S1);
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  const aa = Math.abs(a);
  let kc;
  if (aa < 0.3) kc = 1 - (0.5 * z - (z * r - a * t));
  else {
    const qx = aa > 0.78125 ? 0.28125 : Math.fround(aa * 0.25);
    kc = 1 - qx - (0.5 * z - qx - (z * r - a * t));
  }
  let s;
  let c;
  if (q === 0) { s = ks; c = kc; }
  else if (q === 1) { s = kc; c = -ks; }
  else if (q === 2) { s = -ks; c = -kc; }
  else { s = -kc; c = ks; }
  if (x === 0) s = x;
  v[i] = x < 0 ? -s : s;
  v[i + 1] = c;
}

/**
 * Math.atan2 / atan / asin / acos differ in the last bit between V8 and SpiderMonkey as well. These four are fdlibm's
 * s_atan.c, e_atan2.c, e_asin.c and e_acos.c written with + − × ÷ and sqrt only (all correctly rounded by IEEE 754, so the
 * same bits in every engine): the argument folded into [-0.2, 0.2] around atan(0), atan(1/2), atan(1) or atan(3/2) (or
 * [0, 0.5] for asin and acos, past that through sqrt) and one odd polynomial or rational kernel. The ±0, ±Infinity, NaN
 * and sign-of-zero cases follow ECMAScript's Math.atan2. Measured against a 140-bit BigInt oracle (`trig.test.ts`).
 */
const ATAN_HI = [4.63647609000806093515e-1, 7.85398163397448278999e-1, 9.82793723247329054082e-1, 1.57079632679489655800e0];
const ATAN_LO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
const AT0 = 3.33333333333329318027e-1;
const AT1 = -1.99999999998764832476e-1;
const AT2 = 1.42857142725034663711e-1;
const AT3 = -1.11111104054623557880e-1;
const AT4 = 9.09088713343650656196e-2;
const AT5 = -7.69187620504482999495e-2;
const AT6 = 6.66107313738753120669e-2;
const AT7 = -5.83357013379057348645e-2;
const AT8 = 4.97687799461593236017e-2;
const AT9 = -3.65315727442169155270e-2;
const AT10 = 1.62858201153657823623e-2;
// Past 2^66 atan(t) is π/2 to the last bit; under 2^-29 it is t (asin: under 2^-27); asin switches formula at fdlibm's 0.975.
// atan2 past |y/x| = 2^60 is ±π/2 whatever the sign of x (π/2 + 2^-60 rounds to π/2).
const ATAN2_VERTICAL = 2 ** 60;
const ATAN_HUGE = 2 ** 66;
const ATAN_TINY = 2 ** -29;
const ASIN_TINY = 2 ** -27;
const ASIN_NEAR_ONE = 0.974999904632568359375;
const PI = 3.14159265358979311600e0;
const PI_LO = 1.2246467991473532e-16;
const PIO2_HI = 1.57079632679489655800e0;
const PIO2_LO = 6.12323399573676603587e-17;
const PIO4_HI = 7.85398163397448278999e-1;
const AS_P0 = 1.66666666666666657415e-1;
const AS_P1 = -3.25565818622400915405e-1;
const AS_P2 = 2.01212532134862925881e-1;
const AS_P3 = -4.00555345006794114027e-2;
const AS_P4 = 7.91534994289814532176e-4;
const AS_P5 = 3.47933107596021167570e-5;
const AS_Q1 = -2.40339491173441421878e0;
const AS_Q2 = 2.02094576023350569471e0;
const AS_Q3 = -6.88283971605453293030e-1;
const AS_Q4 = 7.70381505559019352791e-2;

/** atan(t) for t ≥ 0, Infinity and NaN included (NaN in, NaN out). */
function atanPositive(t) {
  if (t > ATAN_HUGE) return PIO2_HI + PIO2_LO;
  let id = -1;
  let u = t;
  if (t < 0.4375) {
    if (t < ATAN_TINY) return t;
  } else if (t < 1.1875) {
    if (t < 0.6875) {
      id = 0;
      u = (2 * t - 1) / (2 + t);
    } else {
      id = 1;
      u = (t - 1) / (t + 1);
    }
  } else if (t < 2.4375) {
    id = 2;
    u = (t - 1.5) / (1 + 1.5 * t);
  } else {
    id = 3;
    u = -1 / t;
  }
  const z = u * u;
  const w = z * z;
  const s1 = z * (AT0 + w * (AT2 + w * (AT4 + w * (AT6 + w * (AT8 + w * AT10)))));
  const s2 = w * (AT1 + w * (AT3 + w * (AT5 + w * (AT7 + w * AT9))));
  if (id < 0) return u - u * (s1 + s2);
  return ATAN_HI[id] - ((u * (s1 + s2) - ATAN_LO[id]) - u);
}

function detAtan(x) {
  return x < 0 ? -atanPositive(-x) : atanPositive(x);
}

/** Math.atan2(y, x): the angle of the point (x, y) from the +x axis, in (-π, π]. */
function detAtan2(y, x) {
  const ay = Math.abs(y);
  const ax = Math.abs(x);
  let ratio = ay / ax;
  if (ratio !== ratio) {
    if (x !== x || y !== y) return NaN;
    if (ax === 0) {
      const angle = 1 / x < 0 ? PI : 0;
      return 1 / y < 0 ? -angle : angle;
    }
    ratio = 1;
  }
  if (ratio > ATAN2_VERTICAL) return y < 0 ? -PIO2_HI : PIO2_HI;
  let angle = atanPositive(ratio);
  if (x < 0) angle = PI - (angle - PI_LO);
  return y < 0 || (y === 0 && 1 / y < 0) ? -angle : angle;
}

/** fdlibm's rational kernel R(t) = p(t) / q(t) shared by asin and acos. */
function asinRational(t) {
  const p = t * (AS_P0 + t * (AS_P1 + t * (AS_P2 + t * (AS_P3 + t * (AS_P4 + t * AS_P5)))));
  const q = 1 + t * (AS_Q1 + t * (AS_Q2 + t * (AS_Q3 + t * AS_Q4)));
  return p / q;
}

/** `s` with the low 32 bits of its mantissa cleared (fdlibm's SET_LOW_WORD(s, 0)). */
function clearLowWord(s) {
  bitView.setFloat64(0, s);
  bitView.setUint32(4, 0);
  return bitView.getFloat64(0);
}

function detAsin(x) {
  const ax = Math.abs(x);
  if (ax >= 1) return ax === 1 ? x * PIO2_HI + x * PIO2_LO : NaN;
  if (ax < 0.5) {
    if (ax < ASIN_TINY) return x;
    return x + x * asinRational(x * x);
  }
  const t = (1 - ax) * 0.5;
  const s = Math.sqrt(t);
  let angle;
  if (ax >= ASIN_NEAR_ONE) {
    angle = PIO2_HI - (2 * (s + s * asinRational(t)) - PIO2_LO);
  } else {
    const w = clearLowWord(s);
    const c = (t - w * w) / (s + w);
    const p = 2 * s * asinRational(t) - (PIO2_LO - 2 * c);
    angle = PIO4_HI - (p - (PIO4_HI - 2 * w));
  }
  return x > 0 ? angle : -angle;
}

function detAcos(x) {
  const ax = Math.abs(x);
  if (ax >= 1) {
    if (ax !== 1) return NaN;
    return x > 0 ? 0 : PI + 2 * PIO2_LO;
  }
  if (ax < 0.5) {
    if (ax <= 2 ** -57) return PIO2_HI + PIO2_LO;
    return PIO2_HI - (x - (PIO2_LO - x * asinRational(x * x)));
  }
  if (x < 0) {
    const z = (1 + x) * 0.5;
    const s = Math.sqrt(z);
    return PI - 2 * (s + (asinRational(z) * s - PIO2_LO));
  }
  const z = (1 - x) * 0.5;
  const s = Math.sqrt(z);
  const df = clearLowWord(s);
  const c = (z - df * df) / (s + df);
  return 2 * (df + (asinRational(z) * s + c));
}

export {
  CRASH,
  TRANSFER,
  PART_FAMILY,
  regionSoftness,
  crushGate,
  dtImpulseScale,
  closingKeScale,
  regionCrushBands,
  forceTransfer,
  leftoverCrumple,
  crushStroke,
  satPushCap,
  round4,
  hypot2,
  hypot3,
  detSin,
  detCos,
  sinCosAt,
  detAtan,
  detAtan2,
  detAsin,
  detAcos,
};
