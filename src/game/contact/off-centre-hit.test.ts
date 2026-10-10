import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ownerHit, rigidExchange } from "./off-centre-hit.test-util.ts";

// The owner's clip (2026-10-07, docs/UNIFIED_CONTACT.md section 5, stage 4): a hatchback at 98 km/h met a coupe's right-rear
// wheel 1.65 m behind its centre; the coupe went on straight at 29 km/h and did not turn, where a rigid body struck there
// turns at about 8.7 rad/s and the pair takes less than half the speed change a hit through the centres gives.

/** How far a car's measured change may be from the rigid-body answer, as a share of it. */
const TOLERANCE = 0.3;

const hitCases = [
  { it: "the wheel 1.65 m behind the coupe's centre (the owner's clip)", aim: 0 },
  { it: "the coupe's middle", aim: -1.7 },
  { it: "a front wheel 1.65 m ahead of the coupe's centre", aim: -3.4 },
] as const;

/**
 * The rows car-car still answers with `resolveCarPair`'s own rule (a position push and the tyres' stop, not the kernel's impulse at
 * the point): todo until Stage 4 item 5 (car-car through the kernel) puts the pair on `bodyContact`. Measured on the lane (the coupe's yaw-rate change against the
 * rigid body's; the speed changes of the pair are 13-15 m/s where the rigid answer is 5.5-5.8 m/s):
 *   owner's clip: coupe 0.03 vs 8.64 rad/s, hatchback 0.08 vs 2.56 rad/s;  coupe's middle: hatchback 0.17 vs 5.82 rad/s;
 *   front wheel: coupe -0.67 vs -8.50 rad/s, hatchback -0.00 vs 3.70 rad/s.
 */
const PAIR_PATH: Record<string, true> = {
  "0:coupeTurned": true,
  "0:hatchbackLost": true,
  "0:coupeGained": true,
  "0:hatchbackTurned": true,
  "-1.7:hatchbackTurned": true,
  "-3.4:coupeTurned": true,
  "-3.4:hatchbackLost": true,
  "-3.4:coupeGained": true,
  "-3.4:hatchbackTurned": true,
};

function then(aim: number, row: string): typeof it.todo {
  return PAIR_PATH[`${aim}:${row}`] ? it.todo : it;
}

describe("given a hatchback at 98 km/h driving across a coupe's path, its front-right corner meeting the coupe's right side", () => {
  for (const testCase of hitCases) {
    describe(`when the corner meets ${testCase.it}`, () => {
      const hit = ownerHit(testCase.aim);
      const rigid = rigidExchange(hit);
      const [a0, b0] = hit.before;
      const [a1, b1] = hit.after;

      then(testCase.aim, "coupeTurned")("then the coupe turns at the rate a rigid body's impulse at that lever gives, in the same direction", () => {
        const got = b1.yawRate - b0.yawRate;
        const lever = Math.hypot(hit.point.x - b0.x, hit.point.z - b0.z);
        assert.ok(
          Math.abs(got - rigid.dwB) <= Math.max(0.5, TOLERANCE * Math.abs(rigid.dwB)),
          `coupe yaw rate change ${got.toFixed(2)} rad/s vs rigid ${rigid.dwB.toFixed(2)} rad/s (lever ${lever.toFixed(2)} m)`,
        );
      });

      then(testCase.aim, "hatchbackLost")("then the hatchback loses the speed the rigid exchange takes, no more", () => {
        const lost = Math.hypot(a1.vx - a0.vx, a1.vz - a0.vz);
        const expected = Math.hypot(rigid.dvA.x, rigid.dvA.z);
        assert.ok(Math.abs(lost - expected) <= TOLERANCE * expected, `hatchback speed change ${lost.toFixed(2)} m/s vs rigid ${expected.toFixed(2)} m/s`);
      });

      then(testCase.aim, "coupeGained")("then the coupe gains the speed the rigid exchange gives it, no more", () => {
        const gained = Math.hypot(b1.vx - b0.vx, b1.vz - b0.vz);
        const expected = Math.hypot(rigid.dvB.x, rigid.dvB.z);
        assert.ok(Math.abs(gained - expected) <= TOLERANCE * expected, `coupe speed change ${gained.toFixed(2)} m/s vs rigid ${expected.toFixed(2)} m/s`);
      });

      then(testCase.aim, "hatchbackTurned")("then the hatchback is turned by the reaction at its own corner, in the same direction", () => {
        const got = a1.yawRate - a0.yawRate;
        assert.ok(
          Math.abs(got - rigid.dwA) <= Math.max(0.5, TOLERANCE * Math.abs(rigid.dwA)),
          `hatchback yaw rate change ${got.toFixed(2)} rad/s vs rigid ${rigid.dwA.toFixed(2)} rad/s`,
        );
      });
    });
  }
});
