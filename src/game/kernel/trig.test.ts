import { describe, it } from "node:test";
import assert from "node:assert/strict";
import "./three-trig.ts";
import { Euler, Object3D, Quaternion, Vector3 } from "three";
import { detCos, detSin, sinCosAt } from "./physics-core.js";
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
