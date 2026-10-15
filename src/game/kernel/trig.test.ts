import { describe, it } from "node:test";
import assert from "node:assert/strict";
import "./three-trig.ts";
import { Euler, Object3D, Quaternion, Vector3 } from "three";
import { detAcos, detAsin, detAtan, detAtan2, detCos, detSin, sinCosAt } from "./physics-core.js";
import { assertSameNumbers } from "../vehicle/test-support.ts";

// The oracle: sin and cos by Taylor series in 140-bit fixed point (BigInt), the argument reduced by a 140-bit π, so each result
// is the correctly rounded double. It uses no Math function and no code from the kernel under test.
const PRECISION = 140n;
const ONE = 1n << PRECISION;
const arctanOfReciprocal = (n: bigint): bigint => {
  let term = ONE / n;
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
};
const HALF_PI = (16n * arctanOfReciprocal(5n) - 4n * arctanOfReciprocal(239n)) >> 1n;
const view = new DataView(new ArrayBuffer(8));
const toFixed = (x: number): bigint => {
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const mantissa = exponent === 0 ? bits & ((1n << 52n) - 1n) : (bits & ((1n << 52n) - 1n)) | (1n << 52n);
  const shift = BigInt((exponent === 0 ? -1074 : exponent - 1075)) + PRECISION;
  const magnitude = shift >= 0n ? mantissa << shift : mantissa >> -shift;
  return bits >> 63n !== 0n ? -magnitude : magnitude;
};
const multiply = (a: bigint, b: bigint): bigint => (a * b) >> PRECISION;
const oracle = (x: number): { sin: number; cos: number } => {
  const fixed = toFixed(x);
  const magnitude = fixed < 0n ? -fixed : fixed;
  let quadrant = (magnitude + (HALF_PI >> 1n)) / HALF_PI;
  const remainder = magnitude - quadrant * HALF_PI;
  const square = multiply(remainder, remainder);
  let sin = remainder;
  let cos = ONE;
  let sinTerm = remainder;
  let cosTerm = ONE;
  for (let i = 1n; i < 40n && (sinTerm !== 0n || cosTerm !== 0n); i++) {
    cosTerm = -multiply(cosTerm, square) / ((2n * i - 1n) * (2n * i));
    sinTerm = -multiply(sinTerm, square) / (2n * i * (2n * i + 1n));
    cos += cosTerm;
    sin += sinTerm;
  }
  quadrant %= 4n;
  const [s, c] = quadrant === 0n ? [sin, cos] : quadrant === 1n ? [cos, -sin] : quadrant === 2n ? [-sin, -cos] : [-cos, sin];
  return { sin: Number(fixed < 0n ? -s : s) / 2 ** 140, cos: Number(c) / 2 ** 140 };
};

const float = new Float64Array(1);
const integers = new BigInt64Array(float.buffer);
const ordinal = (x: number): bigint => {
  float[0] = x;
  const bits = integers[0]!;
  return bits < 0n ? -(bits & 0x7fffffffffffffffn) : bits;
};
const ulpApart = (a: number, b: number): number => Number(ordinal(a) - ordinal(b));

// A fixed 32-bit linear congruential sequence: the same inputs on every run and engine.
const sequence = (seed: number, count: number, scale: number): number[] => {
  const out: number[] = [];
  let state = seed;
  for (let i = 0; i < count; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out.push((state / 4294967296 * 2 - 1) * scale);
  }
  return out;
};
const NEAR_QUARTER_TURNS = sequence(11, 400, 1000).map((k) => Math.round(k) * (Math.PI / 2) + k * 1e-12);

const inputSets = [
  { it: "an angle within a quarter turn of zero (a steering or yaw angle)", inputs: sequence(1, 1500, 0.8) },
  { it: "an angle up to two turns either way (a heading)", inputs: sequence(2, 1500, 4 * Math.PI) },
  { it: "an angle of a few hundred radians (a heading that was never wrapped)", inputs: sequence(3, 1500, 300) },
  { it: "an argument of a hundred thousand radians (the AI's shader-style dice hash)", inputs: sequence(4, 1500, 1e5) },
  { it: "an argument up to a million radians (the quick reduction's reach)", inputs: sequence(5, 1500, 1e6) },
  { it: "an argument of up to ten million radians (the dice hash reaches 7 million)", inputs: sequence(9, 1500, 1e7) },
  { it: "an argument of up to a million million radians (far past the quick reduction)", inputs: sequence(8, 300, 1e12) },
  { it: "an angle within 1e-9 of a multiple of a quarter turn (where a reduction loses most digits)", inputs: NEAR_QUARTER_TURNS },
  { it: "an angle of a millionth of a radian or less (a tiny pose correction)", inputs: sequence(6, 800, 1e-6) },
];

describe("given the game's own sine and cosine (the same bits in every browser, which the engines' built-in ones are not)", () => {
  for (const testCase of inputSets) {
    it(`when asked for ${testCase.it}, then sine and cosine are within 1 unit in the last place of the correctly rounded value, and equal to it for at least 90 % of the angles`, () => {
      let worst = 0;
      let exactCount = 0;
      for (const x of testCase.inputs) {
        const exact = oracle(x);
        worst = Math.max(worst, Math.abs(ulpApart(detSin(x), exact.sin)), Math.abs(ulpApart(detCos(x), exact.cos)));
        if (detSin(x) === exact.sin && detCos(x) === exact.cos) exactCount++;
      }
      assert.ok(worst <= 1, `worst error ${worst} ulp`);
      assert.ok(exactCount >= 0.9 * testCase.inputs.length, `exactly rounded for ${exactCount} of ${testCase.inputs.length}`);
    });
  }

  it("when asked for the angles that have exact answers, then it returns those answers", () => {
    assert.equal(Object.is(detSin(0), 0), true);
    assert.equal(Object.is(detSin(-0), -0), true);
    assert.equal(detCos(0), 1);
    assert.equal(detCos(-0), 1);
    assert.equal(detSin(Math.PI / 2), 1);
    assert.equal(detCos(Math.PI), -1);
  });

  it("when asked for an angle and its mirror, then sine flips sign and cosine is unchanged", () => {
    for (const x of sequence(7, 500, 50)) {
      assert.equal(detSin(-x), -detSin(x));
      assert.equal(detCos(-x), detCos(x));
    }
  });

  it("when asked for an angle that is not a finite number, then it returns not-a-number", () => {
    for (const x of [NaN, Infinity, -Infinity]) {
      assert.ok(Number.isNaN(detSin(x)) && Number.isNaN(detCos(x)));
    }
  });

  it("when sinCosAt is given an angle, then it writes the bits of detSin and detCos, for every input set and the special values", () => {
    const pair = new Float64Array(4);
    const angles = [0, -0, NaN, Infinity, -Infinity, Math.PI / 4, -Math.PI / 4, Math.PI / 2, Math.PI, -3 * Math.PI / 2, 0.3, 0.78125, ...inputSets.flatMap((set) => set.inputs)];
    for (const x of angles) {
      pair[2] = x;
      sinCosAt(pair, 2);
      assert.equal(Object.is(pair[2], detSin(x)) && Object.is(pair[3], detCos(x)), true, `angle ${x}: ${pair[2]}, ${pair[3]} against ${detSin(x)}, ${detCos(x)}`);
    }
  });

  const knownValues = [
    { it: "half a radian", angle: 0.5, sin: 0.479425538604203, cos: 0.8775825618903728 },
    { it: "one radian", angle: 1, sin: 0.8414709848078965, cos: 0.5403023058681398 },
    { it: "two radians", angle: 2, sin: 0.9092974268256817, cos: -0.4161468365471424 },
    { it: "three radians", angle: 3, sin: 0.1411200080598672, cos: -0.9899924966004454 },
    { it: "ten radians", angle: 10, sin: -0.5440211108893698, cos: -0.8390715290764524 },
  ];
  for (const testCase of knownValues) {
    it(`when asked for ${testCase.it}, then it returns the correctly rounded published value`, () => {
      assert.equal(detSin(testCase.angle), testCase.sin);
      assert.equal(detCos(testCase.angle), testCase.cos);
    });
  }
});

// The inverse functions' oracle: arctangent of a 140-bit fixed-point ratio by six halvings (atan t = 2·atan(t / (1 + √(1 + t²))))
// and a Taylor series, then the quadrant. asin x = atan2(x, √(1 − x²)) and acos x = atan2(√(1 − x²), x), the root in BigInt too.
// Inputs stay between 1e-9 and 1e9 in magnitude so every fixed-point value keeps over 100 bits.
const HALVINGS = 6;
const integerSquareRoot = (n: bigint): bigint => {
  if (n < 2n) return n;
  let root = 1n << BigInt((n.toString(2).length + 1) >> 1);
  let next = (root + n / root) >> 1n;
  while (next < root) {
    root = next;
    next = (root + n / root) >> 1n;
  }
  return root;
};
const arctanOfFixed = (ratio: bigint): bigint => {
  if (ratio > ONE) return HALF_PI - arctanOfFixed((ONE * ONE) / ratio);
  let u = ratio;
  for (let i = 0; i < HALVINGS; i++) u = (u * ONE) / (ONE + integerSquareRoot(ONE * ONE + u * u));
  const square = multiply(u, u);
  let sum = u;
  let term = u;
  for (let k = 1n; term !== 0n; k++) {
    term = -multiply(term, square);
    sum += term / (2n * k + 1n);
  }
  return sum << BigInt(HALVINGS);
};
const arctan2OfFixed = (fy: bigint, fx: bigint): bigint => {
  const height = fy < 0n ? -fy : fy;
  const width = fx < 0n ? -fx : fx;
  const angle = fx === 0n ? HALF_PI : arctanOfFixed((height * ONE) / width);
  const folded = fx < 0n ? 2n * HALF_PI - angle : angle;
  return fy < 0n ? -folded : folded;
};
const fixedToNumber = (fixed: bigint): number => Number(fixed) / 2 ** 140;
const atan2Oracle = (y: number, x: number): number => fixedToNumber(arctan2OfFixed(toFixed(y), toFixed(x)));
const atanOracle = (x: number): number => atan2Oracle(x, 1);
const complementRoot = (x: number): bigint => integerSquareRoot(ONE * ONE - toFixed(x) * toFixed(x));
const asinOracle = (x: number): number => fixedToNumber(arctan2OfFixed(toFixed(x), complementRoot(x)));
const acosOracle = (x: number): number => fixedToNumber(arctan2OfFixed(complementRoot(x), toFixed(x)));

/** ±(0.5 … 1) · 10^e, e a whole number of decades within ±`decades`: the magnitudes a ratio or a coordinate takes. */
const spread = (seed: number, count: number, decades: number): number[] => {
  const mantissas = sequence(seed, count, 0.5);
  const exponents = sequence(seed + 100, count, decades);
  const signs = sequence(seed + 200, count, 1);
  return mantissas.map((m, i) => (signs[i]! < 0 ? -1 : 1) * (0.75 + m) * 10 ** Math.round(exponents[i]!));
};
const pairsOf = (ys: number[], xs: number[]): Array<{ y: number; x: number }> => ys.map((y, i) => ({ y, x: xs[i]! }));
const DIRECTIONS = 4000;
const AXIS_NEIGHBOURS = sequence(41, 500, 1e-6);
const FOLD_RATIOS = [0.4375, 0.6875, 1.1875, 2.4375];
const FOLD_JITTER = sequence(42, 400, 1e-9);
const FOLD_WIDTHS = sequence(43, 400, 50);
const pointSets = [
  { it: "a point anywhere in a unit square (all four quadrants)", points: pairsOf(sequence(21, 4000, 1), sequence(22, 4000, 1)) },
  { it: "an offset of up to 500 metres either way (what an AI steers by)", points: pairsOf(sequence(23, 3000, 500), sequence(24, 3000, 500)) },
  { it: "a direction taken evenly around the full circle", points: Array.from({ length: DIRECTIONS }, (_, k) => ({ y: 3 * Math.sin(2 * Math.PI * (k + 0.37) / DIRECTIONS), x: 3 * Math.cos(2 * Math.PI * (k + 0.37) / DIRECTIONS) })) },
  { it: "a point within a millionth of an axis (a heading that is almost exactly along or across)", points: AXIS_NEIGHBOURS.flatMap((e, i) => [{ y: e, x: 1 + i / 500 }, { y: -e, x: -1 - i / 500 }, { y: 1 + i / 500, x: e }, { y: -1 - i / 500, x: -e }]) },
  { it: "a point whose slope sits within a billionth of one of the argument folds (0.4375, 0.6875, 1.1875, 2.4375)", points: FOLD_RATIOS.flatMap((ratio) => FOLD_JITTER.map((e, i) => ({ y: ratio * FOLD_WIDTHS[i]! * (1 + e), x: FOLD_WIDTHS[i]! }))) },
  { it: "a point on the diagonal, each coordinate within a billionth of the other", points: FOLD_JITTER.flatMap((e, i) => [{ y: FOLD_WIDTHS[i]! * (1 + e), x: FOLD_WIDTHS[i]! }, { y: FOLD_WIDTHS[i]!, x: -FOLD_WIDTHS[i]! * (1 + e) }]) },
  { it: "coordinates a billion times larger or smaller than each other (slopes from 1e-18 to 1e18, past the vertical shortcut)", points: pairsOf(spread(25, 3000, 9), spread(26, 3000, 9)) },
];
const unitValues = [
  { it: "a value anywhere in [-1, 1]", values: sequence(31, 4000, 1) },
  { it: "a value within a thousandth of 1 or -1 (where the square root form takes over)", values: sequence(32, 2000, 1e-3).map((e, i) => (i % 2 === 0 ? 1 : -1) * (1 - Math.abs(e))) },
  { it: "a value within a billionth of 1 or -1", values: sequence(33, 1000, 1e-9).map((e, i) => (i % 2 === 0 ? 1 : -1) * (1 - Math.abs(e))) },
  { it: "a value within a millionth of the switch at 0.975 or of one half", values: sequence(34, 1000, 1e-6).map((e, i) => [0.975, -0.975, 0.5, -0.5][i % 4]! + e) },
  { it: "a value of a millionth or less (a tiny slope)", values: sequence(35, 1000, 1e-6) },
];
const slopes = [
  { it: "a slope anywhere in [-3, 3]", values: sequence(36, 3000, 3) },
  { it: "a slope of any size from 1e-9 to 1e9", values: spread(37, 3000, 9) },
  { it: "a slope within a billionth of one of the argument folds", values: FOLD_RATIOS.flatMap((ratio) => FOLD_JITTER.map((e, i) => (i % 2 === 0 ? 1 : -1) * ratio * (1 + e))) },
];

describe("given the game's own inverse trigonometry (the same bits in every browser, which the engines' built-in ones are not)", () => {
  for (const testCase of pointSets) {
    it(`when asked for the angle of ${testCase.it}, then atan2 is within 1 unit in the last place of the correctly rounded value, and equal to it for at least 75 % of the points`, () => {
      let worst = 0;
      let exactCount = 0;
      for (const { y, x } of testCase.points) {
        const exact = atan2Oracle(y, x);
        worst = Math.max(worst, Math.abs(ulpApart(detAtan2(y, x), exact)));
        if (detAtan2(y, x) === exact) exactCount++;
      }
      assert.ok(worst <= 1, `worst error ${worst} ulp`);
      assert.ok(exactCount >= 0.75 * testCase.points.length, `exactly rounded for ${exactCount} of ${testCase.points.length}`);
    });
  }

  for (const testCase of slopes) {
    it(`when asked for the arctangent of ${testCase.it}, then it is within 1 unit in the last place of the correctly rounded value, and equal to it for at least 90 % of the slopes`, () => {
      let worst = 0;
      let exactCount = 0;
      for (const x of testCase.values) {
        const exact = atanOracle(x);
        worst = Math.max(worst, Math.abs(ulpApart(detAtan(x), exact)));
        if (detAtan(x) === exact) exactCount++;
      }
      assert.ok(worst <= 1, `worst error ${worst} ulp`);
      assert.ok(exactCount >= 0.9 * testCase.values.length, `exactly rounded for ${exactCount} of ${testCase.values.length}`);
    });
  }

  for (const testCase of unitValues) {
    it(`when asked for the arcsine and arccosine of ${testCase.it}, then both are within 1 unit in the last place of the correctly rounded value, and both equal to it for at least 70 % of the values`, () => {
      let worst = 0;
      let exactCount = 0;
      for (const x of testCase.values) {
        const exactSine = asinOracle(x);
        const exactCosine = acosOracle(x);
        worst = Math.max(worst, Math.abs(ulpApart(detAsin(x), exactSine)), Math.abs(ulpApart(detAcos(x), exactCosine)));
        if (detAsin(x) === exactSine && detAcos(x) === exactCosine) exactCount++;
      }
      assert.ok(worst <= 1, `worst error ${worst} ulp`);
      assert.ok(exactCount >= 0.7 * testCase.values.length, `exactly rounded for ${exactCount} of ${testCase.values.length}`);
    });
  }

  const quarter = Math.PI / 2;
  const edgeAngles = [
    { it: "a positive y over a positive zero x", y: 1, x: 0, expected: quarter },
    { it: "a negative y over a negative zero x", y: -1, x: -0, expected: -quarter },
    { it: "positive zero over positive zero", y: 0, x: 0, expected: 0 },
    { it: "negative zero over positive zero", y: -0, x: 0, expected: -0 },
    { it: "positive zero over negative zero", y: 0, x: -0, expected: Math.PI },
    { it: "negative zero over negative zero", y: -0, x: -0, expected: -Math.PI },
    { it: "positive zero over a negative x", y: 0, x: -3, expected: Math.PI },
    { it: "negative zero over a negative x", y: -0, x: -3, expected: -Math.PI },
    { it: "positive zero over a positive x", y: 0, x: 3, expected: 0 },
    { it: "negative zero over a positive x", y: -0, x: 3, expected: -0 },
    { it: "a finite y over positive infinity", y: 2, x: Infinity, expected: 0 },
    { it: "a negative y over positive infinity", y: -2, x: Infinity, expected: -0 },
    { it: "a finite y over negative infinity", y: 2, x: -Infinity, expected: Math.PI },
    { it: "a negative y over negative infinity", y: -2, x: -Infinity, expected: -Math.PI },
    { it: "positive infinity over a negative x", y: Infinity, x: -5, expected: quarter },
    { it: "negative infinity over a positive x", y: -Infinity, x: 5, expected: -quarter },
    { it: "positive infinity over positive infinity", y: Infinity, x: Infinity, expected: Math.PI / 4 },
    { it: "positive infinity over negative infinity", y: Infinity, x: -Infinity, expected: 2.356194490192345 },
    { it: "negative infinity over positive infinity", y: -Infinity, x: Infinity, expected: -Math.PI / 4 },
    { it: "negative infinity over negative infinity", y: -Infinity, x: -Infinity, expected: -2.356194490192345 },
    { it: "a y a million million million times x, x negative", y: 5e20, x: -3, expected: quarter },
    { it: "the smallest positive y over a negative x", y: 5e-324, x: -1, expected: Math.PI },
    { it: "the smallest negative y over a positive x", y: -5e-324, x: 1, expected: -5e-324 },
    { it: "a not-a-number y", y: NaN, x: 1, expected: NaN },
    { it: "a not-a-number x", y: 1, x: NaN, expected: NaN },
    { it: "not-a-number over infinity", y: NaN, x: Infinity, expected: NaN },
  ];
  for (const testCase of edgeAngles) {
    it(`when asked for the angle of ${testCase.it}, then atan2 returns ${testCase.expected} (the sign of zero and the quadrant as ECMAScript fixes them)`, () => {
      assert.equal(Object.is(detAtan2(testCase.y, testCase.x), testCase.expected), true, `got ${detAtan2(testCase.y, testCase.x)}`);
    });
  }

  const edgeInverses = [
    { it: "zero", x: 0, atan: 0, asin: 0, acos: quarter },
    { it: "negative zero", x: -0, atan: -0, asin: -0, acos: quarter },
    { it: "one", x: 1, atan: Math.PI / 4, asin: quarter, acos: 0 },
    { it: "minus one", x: -1, atan: -Math.PI / 4, asin: -quarter, acos: Math.PI },
    { it: "a value past one", x: 1.0000000000000002, atan: 0.7853981633974484, asin: NaN, acos: NaN },
    { it: "a value past minus one", x: -2, atan: -1.1071487177940904, asin: NaN, acos: NaN },
    { it: "positive infinity", x: Infinity, atan: quarter, asin: NaN, acos: NaN },
    { it: "negative infinity", x: -Infinity, atan: -quarter, asin: NaN, acos: NaN },
    { it: "not a number", x: NaN, atan: NaN, asin: NaN, acos: NaN },
  ];
  for (const testCase of edgeInverses) {
    it(`when asked for the arctangent, arcsine and arccosine of ${testCase.it}, then it returns the exact answers (and not-a-number outside [-1, 1] for the last two)`, () => {
      assert.equal(Object.is(detAtan(testCase.x), testCase.atan), true, `atan ${detAtan(testCase.x)}`);
      assert.equal(Object.is(detAsin(testCase.x), testCase.asin), true, `asin ${detAsin(testCase.x)}`);
      assert.equal(Object.is(detAcos(testCase.x), testCase.acos), true, `acos ${detAcos(testCase.x)}`);
    });
  }

  it("when asked for a point and its mirror in y, then atan2 flips sign; and for a value and its negative, then atan and asin flip sign and acos is π minus itself to within one unit of π's last place", () => {
    const xs = sequence(51, 500, 50);
    const ys = sequence(52, 500, 50);
    for (let i = 0; i < xs.length; i++) {
      assert.equal(detAtan2(-ys[i]!, xs[i]!), -detAtan2(ys[i]!, xs[i]!), "atan2 mirror in y");
      assert.equal(detAtan(-xs[i]!), -detAtan(xs[i]!), "atan odd");
      const unit = xs[i]! / 50;
      assert.equal(detAsin(-unit), -detAsin(unit), "asin odd");
      assert.ok(Math.abs(detAcos(-unit) - (Math.PI - detAcos(unit))) <= 2 ** -51, "acos reflects about the quarter turn");
    }
  });

  const knownValues = [
    { it: "the slope of one half", value: 0.5, atan: 0.4636476090008061, asin: 0.5235987755982989, acos: 1.0471975511965979 },
    { it: "the slope of two thirds", value: 2 / 3, atan: 0.5880026035475675, asin: 0.7297276562269663, acos: 0.8410686705679303 },
  ];
  for (const testCase of knownValues) {
    it(`when asked for the arctangent, arcsine and arccosine of ${testCase.it}, then it returns the correctly rounded published values`, () => {
      assert.equal(detAtan(testCase.value), testCase.atan);
      assert.equal(detAsin(testCase.value), testCase.asin);
      assert.equal(detAcos(testCase.value), testCase.acos);
    });
  }
});

describe("given three's quaternion from Euler angles, from an axis and angle, and its slerp, with the game's own trig installed", () => {
  // 1000 triples: headings up to two turns, pitch and roll within a quarter turn, as a car pose is.
  const pitches = sequence(13, 1000, 0.8);
  const rolls = sequence(14, 1000, 0.8);
  const triples = sequence(12, 1000, 4 * Math.PI).map((heading, i) => [pitches[i]!, heading, rolls[i]!] as const);
  // Each component is a sum of two triple products of factors no larger than 1, so a factor 1 ulp (2^-53 of at most 1) off moves
  // the component by at most 2^-53; six such factors and the three roundings per term that may then land differently bound the
  // gap between two evaluations at 12 · 2^-53.
  const ONE_ULP_FACTORS = 12 * 2 ** -53;
  /** three's 'YXZ' formula, the order every car pose uses (`rotation.set(pitch, yaw, roll, "YXZ")`). */
  const yxz = (x: number, y: number, z: number, sin: (a: number) => number, cos: (a: number) => number): number[] => {
    const c1 = cos(x / 2), c2 = cos(y / 2), c3 = cos(z / 2), s1 = sin(x / 2), s2 = sin(y / 2), s3 = sin(z / 2);
    return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 - s1 * s2 * c3, c1 * c2 * c3 + s1 * s2 * s3];
  };
  const q = new Quaternion();
  const euler = new Euler();
  const read = (): number[] => [q.x, q.y, q.z, q.w];

  it("when a car pose is set in 'YXZ' order, then every component is bit-equal to three's formula fed with the game's own sine and cosine (the same bits in every engine)", () => {
    for (const [x, y, z] of triples) {
      q.setFromEuler(euler.set(x, y, z, "YXZ"));
      assertSameNumbers(read(), yxz(x, y, z, detSin, detCos), `(${x}, ${y}, ${z})`);
    }
  });

  it("when a car pose is set in 'YXZ' order, then every component is within six factors one unit off of the formula on correctly rounded trig, and of the same formula on the engine's own trig (a car keeps the pose it had)", () => {
    for (const [x, y, z] of triples) {
      q.setFromEuler(euler.set(x, y, z, "YXZ"));
      const exact = yxz(x, y, z, (a) => oracle(a).sin, (a) => oracle(a).cos);
      const before = yxz(x, y, z, Math.sin, Math.cos);
      const now = read();
      for (let k = 0; k < 4; k++) {
        assert.ok(Math.abs(now[k]! - exact[k]!) <= ONE_ULP_FACTORS, `component ${k} of (${x}, ${y}, ${z}) is ${Math.abs(now[k]! - exact[k]!)} from the exact formula`);
        assert.ok(Math.abs(now[k]! - before[k]!) <= ONE_ULP_FACTORS, `component ${k} of (${x}, ${y}, ${z}) is ${Math.abs(now[k]! - before[k]!)} from the engine's own`);
      }
    }
  });

  it("when the engine's Math.sin and Math.cos round differently (each nudged one unit up, as another browser's may), then a pose, a turn about an axis and a slerp come out bit for bit the same", () => {
    const up = (v: number): number => (v === 0 ? v : v + Math.abs(v) * 2 ** -52);
    const sin = Math.sin;
    const cos = Math.cos;
    const axis = new Vector3(1, 2, 2).normalize();
    const run = (): number[] => {
      const out: number[] = [];
      for (const [x, y, z] of triples.slice(0, 200)) {
        q.setFromEuler(euler.set(x, y, z, "YXZ"));
        out.push(...read());
        q.setFromAxisAngle(axis, y);
        out.push(...read());
        q.setFromEuler(euler.set(x, 0, z, "YXZ")).slerp(new Quaternion().setFromEuler(euler.set(z, y, x, "YXZ")), 0.37);
        out.push(...read());
      }
      return out;
    };
    const plain = run();
    try {
      Math.sin = (a: number) => up(sin(a));
      Math.cos = (a: number) => up(cos(a));
      const nudged = run();
      assertSameNumbers(nudged, plain, "with the engine's trig nudged");
      // The control: the nudge does change the same formula on the engine's trig, so the bars above can fail.
      const [x, y, z] = triples[0]!;
      assert.notEqual(yxz(x, y, z, Math.sin, Math.cos)[3], yxz(x, y, z, sin, cos)[3]);
    } finally {
      Math.sin = sin;
      Math.cos = cos;
    }
  });

  it("when an object's rotation is set as Euler angles, then the angles read back exactly as set (the quaternion follows the angles, not the reverse)", () => {
    const o = new Object3D();
    for (const [x, y, z] of triples.slice(0, 200)) {
      o.rotation.set(x, y, z, "YXZ");
      assertSameNumbers([o.rotation.x, o.rotation.y, o.rotation.z], [x, y, z], `(${x}, ${y}, ${z})`);
    }
  });

  it("when a part turns about an axis, then the quaternion is the axis times the game's sine of the half angle, and its cosine", () => {
    const axis = new Vector3(1, 2, 2).normalize();
    for (const angle of sequence(15, 500, 4 * Math.PI)) {
      q.setFromAxisAngle(axis, angle);
      const s = detSin(angle / 2);
      assertSameNumbers(read(), [axis.x * s, axis.y * s, axis.z * s, detCos(angle / 2)], `angle ${angle}`);
    }
  });

  it("when an Euler order the game never uses is given, then the quaternion still follows three's formula for it ('XYZ')", () => {
    const [x, y, z] = triples[0]!;
    q.setFromEuler(euler.set(x, y, z, "XYZ"));
    const c1 = detCos(x / 2), c2 = detCos(y / 2), c3 = detCos(z / 2), s1 = detSin(x / 2), s2 = detSin(y / 2), s3 = detSin(z / 2);
    assertSameNumbers(read(), [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3], "XYZ");
  });
});
