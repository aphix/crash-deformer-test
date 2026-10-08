import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detCos, detSin } from "./physics-core.js";

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
