import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BODY_HARD, BODY_I, BODY_M, BODY_SIZE, BODY_VX, BODY_VZ, BODY_W, BODY_X, BODY_Z,
  bodyContact, CT_DEPTH, CT_E, CT_JMAX, CT_MU, CT_NX, CT_NZ, CT_SIZE, CT_X, CT_Z,
  OUT_CLOSING, OUT_CRUSH_J, OUT_EBS_A, OUT_EBS_B, OUT_J, OUT_JT, OUT_MEFF, OUT_PLASTIC_J, OUT_PUSH_A, OUT_PUSH_B, OUT_SIZE,
} from "./body-contact.ts";

/** A body as plain data: centre (x, z), velocity, yaw rate, mass and yaw inertia, the hardness of its face. */
type Body = { m: number; i: number; x: number; z: number; vx: number; vz: number; w: number; hard: number };

const SEDAN = { m: 858, i: 945, hard: 1 } as const;
const PLATE = { m: Infinity, i: Infinity, hard: 1 } as const;
const AT_REST = { vx: 0, vz: 0, w: 0 } as const;

/** Everything a case sets: two bodies, the point and normal (out of B into A) they touch with, and how the contact behaves. */
type Case = {
  it: string;
  a: Body;
  b: Body;
  /** Contact point (x, z) and the unit normal out of B into A. */
  point: readonly [number, number];
  normal: readonly [number, number];
  e: number;
  mu: number;
  jmax: number;
  depth: number;
};

const defaults = { e: 0, mu: 0, jmax: Infinity, depth: 0 } as const;

const rows = new Float64Array(2 * BODY_SIZE);
const ct = new Float64Array(CT_SIZE);
const out = new Float64Array(OUT_SIZE);

function load(c: Case): void {
  const bodies = [c.a, c.b];
  for (let k = 0; k < 2; k++) {
    const body = bodies[k]!;
    const o = k * BODY_SIZE;
    rows[o + BODY_M] = body.m;
    rows[o + BODY_I] = body.i;
    rows[o + BODY_X] = body.x;
    rows[o + BODY_Z] = body.z;
    rows[o + BODY_VX] = body.vx;
    rows[o + BODY_VZ] = body.vz;
    rows[o + BODY_W] = body.w;
    rows[o + BODY_HARD] = body.hard;
  }
  ct[CT_X] = c.point[0];
  ct[CT_Z] = c.point[1];
  ct[CT_NX] = c.normal[0];
  ct[CT_NZ] = c.normal[1];
  ct[CT_DEPTH] = c.depth;
  ct[CT_E] = c.e;
  ct[CT_MU] = c.mu;
  ct[CT_JMAX] = c.jmax;
}

/** Velocity of body `o`'s point (px, pz): its own plus the spin's. */
function pointVelocity(o: number, px: number, pz: number): [number, number] {
  const rx = px - rows[o + BODY_X]!;
  const rz = pz - rows[o + BODY_Z]!;
  return [rows[o + BODY_VX]! + rows[o + BODY_W]! * rz, rows[o + BODY_VZ]! - rows[o + BODY_W]! * rx];
}

/** Linear momentum (kg m/s, x and z) and angular momentum about (px, pz) (kg m²/s, about +y) of body `o`. */
function momentum(o: number, px: number, pz: number): [number, number, number] {
  const m = rows[o + BODY_M]!;
  const rx = rows[o + BODY_X]! - px;
  const rz = rows[o + BODY_Z]! - pz;
  const vx = rows[o + BODY_VX]!;
  const vz = rows[o + BODY_VZ]!;
  return [m * vx, m * vz, rows[o + BODY_I]! * rows[o + BODY_W]! + m * (rz * vx - rx * vz)];
}

function kineticEnergy(o: number): number {
  const m = rows[o + BODY_M]!;
  return 0.5 * m * (rows[o + BODY_VX]! ** 2 + rows[o + BODY_VZ]! ** 2) + 0.5 * rows[o + BODY_I]! * rows[o + BODY_W]! ** 2;
}

function near(actual: number, expected: number, tol: number, what: string): void {
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} vs ${expected} (±${tol})`);
}

/** The owner's hit (clip 2026-10-07): A's front-right corner into B's rear wheel, A at 27.19 m/s, B at rest. */
const OWNER_HIT: Case = {
  it: "",
  a: { ...SEDAN, x: -2.08, z: 0.51, vx: 27.19, vz: 0, w: 0 },
  b: { ...SEDAN, x: 0.76, z: -1.65, ...AT_REST },
  point: [0, 0],
  normal: [-1, 0],
  ...defaults,
};

describe("given two bodies that touch at a point and press into each other", () => {
  const exchangeCases: Case[] = [
    { ...OWNER_HIT, it: "a car driving into the rear wheel of another, 1.65 m behind its centre" },
    { it: "two equal cars head-on through their centres, 10 m/s each", a: { ...SEDAN, x: -2, z: 0, vx: 10, vz: 0, w: 0 }, b: { ...SEDAN, x: 2, z: 0, vx: -10, vz: 0, w: 0 }, point: [0, 0], normal: [-1, 0], ...defaults },
    { it: "a 1500 kg car into an 858 kg car through their centres", a: { m: 1500, i: 2100, hard: 1, x: -2, z: 0, vx: 20, vz: 0, w: 0 }, b: { ...SEDAN, x: 2, z: 0, vx: 0, vz: 0, w: 0 }, point: [0, 0], normal: [-1, 0], ...defaults },
    { it: "both cars hit off their centres on opposite sides, one of them already turning", a: { ...SEDAN, x: -2, z: 0.9, vx: 12, vz: 1, w: -0.4 }, b: { ...SEDAN, x: 2, z: -0.7, vx: -3, vz: 0, w: 0.6 }, point: [0, 0], normal: [-1, 0], ...defaults },
    { it: "a rebounding hit (restitution 0.3) 1.2 m off one car's centre", a: { ...SEDAN, x: -2, z: 1.2, vx: 15, vz: 0, w: 0 }, b: { ...SEDAN, x: 2, z: 0, ...AT_REST }, point: [0, 0], normal: [-1, 0], ...defaults, e: 0.3 },
    { it: "a hit along a slanted normal", a: { ...SEDAN, x: -2, z: -1, vx: 9, vz: 4, w: 0 }, b: { ...SEDAN, x: 2, z: 0.5, vx: 0, vz: 0, w: 0 }, point: [0, 0], normal: [-Math.SQRT1_2, Math.SQRT1_2], ...defaults },
  ];
  for (const testCase of exchangeCases) {
    describe(`when ${testCase.it}`, () => {
      it("then linear momentum and angular momentum about the contact point are both kept, and the points part at the restitution's speed", () => {
        load(testCase);
        const [px, pz] = testCase.point;
        const before = [momentum(0, px, pz), momentum(BODY_SIZE, px, pz)];
        const approach = bodyContactClosing(testCase);
        const keBefore = kineticEnergy(0) + kineticEnergy(BODY_SIZE);
        const j = bodyContact(rows, 0, BODY_SIZE, ct, out);
        assert.ok(j > 0, "the bodies exchange an impulse");
        for (let axis = 0; axis < 3; axis++) {
          const sum0 = before[0]![axis]! + before[1]![axis]!;
          const sum1 = momentum(0, px, pz)[axis]! + momentum(BODY_SIZE, px, pz)[axis]!;
          near(sum1, sum0, 1e-6 * Math.max(1, Math.abs(sum0)), `momentum axis ${axis}`);
        }
        const va = pointVelocity(0, px, pz);
        const vb = pointVelocity(BODY_SIZE, px, pz);
        const apart = (va[0] - vb[0]) * testCase.normal[0] + (va[1] - vb[1]) * testCase.normal[1];
        near(apart, testCase.e * approach, 1e-9, "speed the points part at along the normal");
        near(keBefore - kineticEnergy(0) - kineticEnergy(BODY_SIZE), out[OUT_CRUSH_J]!, 1e-6 * keBefore, "kinetic energy taken out of the pair is the crush energy");
        near(out[OUT_CRUSH_J]!, 0.5 * out[OUT_MEFF]! * approach * approach * (1 - testCase.e ** 2), 1e-6 * keBefore, "crush energy of the closing at that effective mass");
      });
    });
  }

  describe("when a car drives into another's rear wheel 1.65 m behind its centre at 27.19 m/s and the cars leave together", () => {
    it("then the impulse is 4.96 kN·s, the struck car turns at 8.65 rad/s and each car's speed changes by 5.78 m/s, not the 13.6 m/s of a hit through the centres", () => {
      load(OWNER_HIT);
      const j = bodyContact(rows, 0, BODY_SIZE, ct, out);
      near(j, 4955.2, 0.1, "impulse N·s");
      near(rows[BODY_SIZE + BODY_W]!, 8.652, 0.001, "struck car's yaw rate rad/s");
      near(rows[BODY_W]!, 2.674, 0.001, "striking car's yaw rate rad/s");
      near(27.19 - rows[BODY_VX]!, 5.775, 0.001, "striking car's speed loss m/s");
      near(rows[BODY_SIZE + BODY_VX]!, 5.775, 0.001, "struck car's speed change m/s");
      near(out[OUT_MEFF]!, 182.24, 0.01, "effective mass kg");
      near(out[OUT_CRUSH_J]!, 67366, 1, "crush energy J");
    });
  });
});

/** Approach speed of the two bodies' points along the normal, on the rows as loaded. */
function bodyContactClosing(c: Case): number {
  const va = pointVelocity(0, c.point[0], c.point[1]);
  const vb = pointVelocity(BODY_SIZE, c.point[0], c.point[1]);
  return -((va[0] - vb[0]) * c.normal[0] + (va[1] - vb[1]) * c.normal[1]);
}

describe("given a kinematic body (a press plate, a piston head, a wall) and a car", () => {
  const plateHit: Case = { it: "", a: { ...SEDAN, x: 3, z: 0, ...AT_REST }, b: { ...PLATE, x: 0, z: 0, vx: 0.55, vz: 0, w: 0 }, point: [1.5, 0.8], normal: [1, 0], ...defaults };
  describe("when the plate closes on the car's far corner, 0.8 m off its centre line, at 0.55 m/s", () => {
    it("then the car's point there leaves at the plate's speed, the plate does not slow, and the whole closing is the car's crush energy", () => {
      load(plateHit);
      bodyContact(rows, 0, BODY_SIZE, ct, out);
      const va = pointVelocity(0, 1.5, 0.8);
      near(va[0], 0.55, 1e-9, "car's point speed along the plate's travel");
      assert.equal(rows[BODY_SIZE + BODY_VX], 0.55, "plate speed");
      assert.equal(rows[BODY_SIZE + BODY_W], 0, "plate yaw rate");
      assert.ok(out[OUT_J]! > 0, "the plate gives an impulse");
      near(out[OUT_EBS_A]!, out[OUT_CLOSING]! * Math.sqrt(out[OUT_MEFF]! / SEDAN.m), 1e-9, "the car's barrier speed is the closing scaled by what the lever leaves of its mass");
      assert.ok(out[OUT_EBS_A]! < out[OUT_CLOSING]!, "a hit off the centre line crushes less than a square one");
      assert.equal(out[OUT_EBS_B], 0, "a kinematic body has no barrier speed");
    });
  });
  describe("when the car is struck at its centre by the plate", () => {
    it("then it takes the plate's speed with no spin, the effective mass is its own and its barrier speed is the whole closing", () => {
      load({ ...plateHit, point: [1.5, 0], a: { ...SEDAN, x: 3, z: 0, ...AT_REST } });
      bodyContact(rows, 0, BODY_SIZE, ct, out);
      near(rows[BODY_VX]!, 0.55, 1e-9, "car speed");
      assert.equal(rows[BODY_W], 0, "no spin");
      near(out[OUT_MEFF]!, SEDAN.m, 1e-9, "effective mass is the car's own");
      near(out[OUT_EBS_A]!, 0.55, 1e-9, "barrier speed is the closing");
    });
  });
});

describe("given a contact that yields and one that is already parting", () => {
  describe("when the crush force allows only 1000 N·s of a hit that would take 4955", () => {
    it("then it gives 1000 N·s and the points are still closing", () => {
      load({ ...OWNER_HIT, jmax: 1000 });
      const j = bodyContact(rows, 0, BODY_SIZE, ct, out);
      assert.equal(j, 1000);
      assert.ok(bodyContactClosing(OWNER_HIT) > 0, "the cap left a closing speed");
      near(out[OUT_CRUSH_J]!, 1000 * (27.19 - 0.5 * 1000 * (1 / out[OUT_MEFF]!)), 1e-6, "crush energy of the capped impulse");
      near(out[OUT_PLASTIC_J]!, 0.5 * out[OUT_MEFF]! * 27.19 ** 2, 1e-6, "the plastic energy stays that of the full closing");
    });
  });
  describe("when the bodies' points move apart", () => {
    it("then nothing is exchanged", () => {
      load({ ...OWNER_HIT, a: { ...OWNER_HIT.a, vx: -3 } });
      assert.equal(bodyContact(rows, 0, BODY_SIZE, ct, out), 0);
      assert.equal(rows[BODY_VX], -3);
      assert.equal(rows[BODY_SIZE + BODY_VX], 0);
    });
  });
  describe("when both bodies are kinematic", () => {
    it("then nothing is exchanged", () => {
      load({ ...OWNER_HIT, a: { ...PLATE, x: -2, z: 0, vx: 5, vz: 0, w: 0 }, b: { ...PLATE, x: 2, z: 0, ...AT_REST } });
      assert.equal(bodyContact(rows, 0, BODY_SIZE, ct, out), 0);
    });
  });
});

describe("given two cars pressing into each other through their centres", () => {
  const closing = 20;
  describe("when they have the same mass", () => {
    it("then each takes half the closing as its barrier speed", () => {
      load({ ...OWNER_HIT, a: { ...SEDAN, x: -2, z: 0, vx: closing, vz: 0, w: 0 }, b: { ...SEDAN, x: 2, z: 0, ...AT_REST } });
      bodyContact(rows, 0, BODY_SIZE, ct, out);
      near(out[OUT_EBS_A]!, 0.5 * closing, 1e-9, "barrier speed of A");
      near(out[OUT_EBS_B]!, 0.5 * closing, 1e-9, "barrier speed of B");
    });
  });
  describe("when a 1500 kg car meets an 858 kg car", () => {
    it("then each takes the speed change the other's mass share gives it as its barrier speed, as the crush calibration has it", () => {
      load({ ...OWNER_HIT, a: { m: 1500, i: 2100, hard: 1, x: -2, z: 0, vx: closing, vz: 0, w: 0 }, b: { ...SEDAN, x: 2, z: 0, ...AT_REST } });
      bodyContact(rows, 0, BODY_SIZE, ct, out);
      near(out[OUT_EBS_A]!, (closing * 858) / (1500 + 858), 1e-9, "barrier speed of the 1500 kg car");
      near(out[OUT_EBS_B]!, (closing * 1500) / (1500 + 858), 1e-9, "barrier speed of the 858 kg car");
    });
  });
  describe("when the struck car's face is a honeycomb of hardness 0.5 (a piston head)", () => {
    it("then the car takes half the energy a rigid face gives it: a barrier speed of closing × sqrt(0.5)", () => {
      load({ ...OWNER_HIT, a: { ...SEDAN, x: 3, z: 0, ...AT_REST }, b: { ...PLATE, hard: 0.5, x: 0, z: 0, vx: closing, vz: 0, w: 0 }, point: [1.5, 0], normal: [1, 0] });
      bodyContact(rows, 0, BODY_SIZE, ct, out);
      near(out[OUT_EBS_A]!, closing * Math.sqrt(0.5), 1e-9, "barrier speed of the car");
    });
  });
});

describe("given a car meeting another off its own centre", () => {
  describe("when the struck car is hit 1.65 m from its centre and the striker 0.51 m from its own", () => {
    it("then the struck car takes 74 % of the crush energy and the striker 26 %, in proportion to what the lever leaves of each one's mobility", () => {
      load(OWNER_HIT);
      bodyContact(rows, 0, BODY_SIZE, ct, out);
      const energy = out[OUT_PLASTIC_J]!;
      near((0.5 * SEDAN.m * out[OUT_EBS_B]! ** 2) / energy, 0.738, 0.001, "struck car's share");
      near((0.5 * SEDAN.m * out[OUT_EBS_A]! ** 2) / energy, 0.262, 0.001, "striker's share");
    });
  });
});

describe("given a contact with friction", () => {
  const sliding: Case = { it: "", a: { ...SEDAN, x: -2, z: 0, vx: 10, vz: 6, w: 0 }, b: { ...SEDAN, x: 2, z: 0, ...AT_REST }, point: [0, 0], normal: [-1, 0], ...defaults };
  describe("when the points slide against each other and the friction is high enough to stop the sliding", () => {
    it("then they stop sliding within the normal impulse's friction limit", () => {
      load({ ...sliding, mu: 10 });
      const j = bodyContact(rows, 0, BODY_SIZE, ct, out);
      const va = pointVelocity(0, 0, 0);
      const vb = pointVelocity(BODY_SIZE, 0, 0);
      near(va[1] - vb[1], 0, 1e-9, "sliding speed left");
      assert.ok(Math.abs(out[OUT_JT]!) <= 10 * j, "friction impulse within the limit");
    });
  });
  describe("when the friction is 0.05", () => {
    it("then the friction impulse is 0.05 of the normal impulse and sliding is left over", () => {
      load({ ...sliding, mu: 0.05 });
      const j = bodyContact(rows, 0, BODY_SIZE, ct, out);
      near(Math.abs(out[OUT_JT]!), 0.05 * j, 1e-9, "friction impulse");
      const slidLeft = pointVelocity(0, 0, 0)[1] - pointVelocity(BODY_SIZE, 0, 0)[1];
      assert.ok(slidLeft > 0.1, `sliding left ${slidLeft}`);
    });
  });
});

describe("given a pair that overlaps by 0.1 m", () => {
  describe("when a car and a kinematic plate, or two cars, are pushed out of each other", () => {
    it("then the car clears the whole depth against the plate and half of it against an equal car", () => {
      load({ ...OWNER_HIT, depth: 0.1, b: { ...PLATE, x: 0.76, z: -1.65, ...AT_REST } });
      bodyContact(rows, 0, BODY_SIZE, ct, out);
      near(out[OUT_PUSH_A]!, 0.1, 1e-12, "car's push against the plate");
      assert.equal(out[OUT_PUSH_B], 0);
      load({ ...OWNER_HIT, depth: 0.1 });
      bodyContact(rows, 0, BODY_SIZE, ct, out);
      near(out[OUT_PUSH_A]!, 0.05, 1e-12, "car's push against an equal car");
      near(out[OUT_PUSH_B]!, 0.05, 1e-12, "other car's push");
    });
  });
});
