import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AI_DIFFICULTIES, type AiDifficulty } from "../ai/constants.ts";
import { fieldAggression } from "../ai/ai-aggression.ts";
import { assertSameNumbers } from "../vehicle/test-support.ts";
import { setGround } from "./ground.ts";
import { classifyContact, contactRace, type Role, type Sample } from "./race-contact.test-util.ts";
import { makeWorld, raceOnce, type Outcome, type World } from "./race-world.test-util.ts";
import { Track } from "./track.ts";
import oval from "./tracks/oval.json" with { type: "json" };

type Kin = Omit<Sample, "bumped">;

/** The classifier reads the last frame's kinematics and whether the car was bumped in the half second before. */
const window = (s: Kin, knocked: boolean): Sample[] => [{ ...s, bumped: knocked }, { ...s, bumped: false }];

/**
 * Eight contacts of real races, hand-checked against the geometry (n = unit vector from A's centre to B's;
 * "toward" = the car's velocity along n toward the other; the numbers are the frame before the contact).
 */
const handCheckedContactCases: {
  it: string;
  a: Kin;
  b: Kin;
  knockedA: boolean;
  knockedB: boolean;
  want: [Role, Role];
}[] = [
  {
    // Oval, slider 1, seed 1, frame 1209. B sits 1.5 m behind and 1.7 m right of A at 41 against 31 m/s, both
    // turning left (steer 0.39 / 0.40), throttle 0.68 on: its nose meets A's rear quarter. n = (0.165, −0.986):
    // A·n = −18.4 (moving away), B toward = 26.0. B drove into A.
    it: "when a faster car's nose meets the rear quarter of the car it overtakes, then the faster car is classed as having started the hit and the overtaken car as having suffered it",
    a: { x: -21.89, z: -127.14, vx: -27.5, vz: 14.07, yaw: -1.098, throttle: 0.56, steer: 0.4, brake: 0 },
    b: { x: -21.52, z: -129.35, vx: -32.09, vz: 21.03, yaw: -0.991, throttle: 0.68, steer: 0.39, brake: 0 },
    knockedA: false,
    knockedB: false,
    want: ["suffered", "initiated"],
  },
  {
    // Stunt, slider 0.5, seed 1, frame 2969. B at 39 m/s closes on A at 26 m/s ahead of it; B's brake is already
    // full (throttle 0, brake 1) but it is 14 m/s too fast: late braking is still B's hit.
    it: "when a car brakes too late for the slower one ahead, then the late braker is classed as having started the hit and the car ahead as having suffered it",
    a: { x: 145.82, z: -85.54, vx: -20.26, vz: -15.91, yaw: -2.237, throttle: 0.73, steer: 0.72, brake: 0 },
    b: { x: 150.3, z: -84.16, vx: -33.5, vz: -20.41, yaw: -2.118, throttle: 0, steer: 0.29, brake: 1 },
    knockedA: false,
    knockedB: false,
    want: ["suffered", "initiated"],
  },
  {
    // City, slider 1, seed 1, frame 879. Side by side 1.85 m apart on a straight, A (22 m/s) braking then
    // back on the gas, B passing at 34 m/s with a slow drift toward A (vx −0.7 → −2.2 over 30 frames).
    it: "when a passing car drifts into the one beside it, then the passing car is classed as having started the hit and the other as having suffered it",
    a: { x: -6.06, z: 62.78, vx: 0.26, vz: 21.94, yaw: 0.012, throttle: 1, steer: 0.04, brake: 0 },
    b: { x: -4.21, z: 62.79, vx: -2.2, vz: 34.3, yaw: -0.064, throttle: 0, steer: -0.05, brake: 1 },
    knockedA: false,
    knockedB: false,
    want: ["suffered", "initiated"],
  },
  {
    // Stunt, slider 0.5, seed 3, frame 2828. A (36 m/s, steer 0.32) comes up behind-right of B, which swings
    // its nose toward A's lane (steer 0.92, yaw −2.82 → −2.72 in 5 frames). A·n = 14.5, B toward = 4.9.
    it: "when two lines meet, one going for it and the other turning into it, then both cars are classed as converging, neither alone having started the hit",
    a: { x: 154.46, z: -79.57, vx: -36.56, vz: -25.84, yaw: -2.186, throttle: 0.8, steer: 0.32, brake: 0 },
    b: { x: 152.09, z: -77.86, vx: -10.12, vz: -22.35, yaw: -2.716, throttle: 0.72, steer: 0.92, brake: 0 },
    knockedA: false,
    knockedB: false,
    want: ["converging", "converging"],
  },
  {
    // Oval, slider 1, seed 1, frame 885: the same two cars scrape again 20+ frames after their last bump
    // (A bumped 19 frames, B 13 frames before): a continuing scrape, neither closed it by its own driving.
    it: "when a pair scrapes again a third of a second after being bumped, then neither car is classed as having started or suffered it (a continuing scrape)",
    a: { x: 54.27, z: 19.1, vx: 1.08, vz: -41.25, yaw: 3.115, throttle: 1, steer: -0.06, brake: 0 },
    b: { x: 52.41, z: 19.88, vx: 5.56, vz: -41.95, yaw: 3.009, throttle: 0.99, steer: 0.11, brake: 0 },
    knockedA: true,
    knockedB: true,
    want: ["none", "none"],
  },
  {
    // City, slider 0, frame 537: A (car 1) was in a traffic car 11 frames ago and is 5 m/s slower than B (car 4),
    // which is on the brakes only now (brake 1, 7 frames of throttle 0): B drove into A from behind.
    it: "when the faster car behind a car just bumped by traffic drives into it, then the faster car is classed as having started the hit and the bumped car as having suffered it",
    a: { x: -1.67, z: -31.99, vx: -7.26, vz: 15.21, yaw: -0.446, throttle: 1, steer: 1, brake: 0 },
    b: { x: -3.47, z: -33.85, vx: -0.86, vz: 21.36, yaw: -0.04, throttle: 0, steer: 0.18, brake: 1 },
    knockedA: true,
    knockedB: false,
    want: ["suffered", "initiated"],
  },
  {
    // Rally, slider 0, frame 2684: car 0 merges off a shortcut at 25 m/s into the loop lane car 4 is passing at 34 m/s.
    // B is 2.2 m to A's right, level with it (n = (1, 0)); A·n = 12.3 (its sideways speed into the lane), B moves
    // away from A along n (−8.75 toward). A has just lifted (throttle 0, brake 0.31), too late.
    it: "when a shortcut exit merges across the lane of a car passing on the loop, then the merging car is classed as having started the hit and the passing car as having suffered it",
    a: { x: 173.81, z: 99.71, vx: 12.31, vz: -22.32, yaw: 8.931, throttle: 0, steer: 0.79, brake: 0.31 },
    b: { x: 175.97, z: 99.71, vx: 8.75, vz: -32.88, yaw: 9.165, throttle: 0.68, steer: 0.27, brake: 0 },
    knockedA: false,
    knockedB: false,
    want: ["initiated", "suffered"],
  },
  {
    // City, slider 0, frame 2923. A (car 1) is wedged on a stopped traffic car and backs out under its reverse pedal
    // (throttle −0.9, full lock, 9.3 m/s backwards, bumped by the traffic car every frame) across the lane of B (car 5), which has been on
    // full brake for 8 frames and is still doing 12.8 m/s 4.8 m away. A·n = 9.0, B toward = 12.4.
    it: "when a car wedged on a stopped car backs out under its reverse pedal into the lane of one braking flat out, then both cars are classed as converging",
    a: { x: 94.59, z: 58.24, vx: -8.34, vz: 4.14, yaw: 2.031, throttle: -0.9, steer: 1, brake: 0 },
    b: { x: 89.93, z: 59.22, vx: 12.74, vz: 0.59, yaw: 1.524, throttle: 0, steer: -0.3, brake: 1 },
    knockedA: true,
    knockedB: false,
    want: ["converging", "converging"],
  },
];

describe("given the contact classifier (it says which car of a racer-racer contact started the hit) reading the last frame's speeds, steering and pedals of eight real race contacts", () => {
  for (const testCase of handCheckedContactCases) {
    it(testCase.it, () => {
      const v = classifyContact(window(testCase.a, testCase.knockedA), window(testCase.b, testCase.knockedB));
      assert.equal(`${v.a} ${v.b}`, testCase.want.join(" "), `toward A ${v.towardA.toFixed(1)}, toward B ${v.towardB.toFixed(1)}, closing ${v.closing.toFixed(1)}`);
    });
  }
});

/** Race seconds from the first frame to the green (the grid and countdown) and the seconds of racing read after it: the pack at its most bunched. */
const COUNTDOWN = 4.5;
const OPENING = 3;
/** The rivals racing each other from the oval's grid. */
const AI_RIVALS = 4;

/** A fresh oval world run for the countdown and the opening seconds at `slider` and field `seed`. */
function opening<T>(slider: number, seed: number, difficulty: AiDifficulty, read: (w: World, outcome: Outcome) => T): T {
  const track = new Track(oval);
  const w = makeWorld();
  w.race.enter();
  try {
    return read(w, raceOnce(w, track, COUNTDOWN + OPENING, seed, slider, undefined, AI_RIVALS, difficulty));
  } finally {
    w.race.exit();
    setGround(null);
  }
}

describe("given the aggression slider at 0, so every rival is as gentle as can be", () => {
  it("when field seeds 1 to 5 roll the rivals' aggression, then every rival's is 0 whatever the seed", () => {
    for (let seed = 1; seed <= 5; seed++) {
      for (let id = 1; id <= AI_RIVALS + 3; id++) assert.equal(fieldAggression(0, seed, id), 0, `seed ${seed}, rival ${id}`);
    }
  });

  for (const difficulty of AI_DIFFICULTIES.slice(1)) {
    it(`when field seeds 1 and 2 start the same oval race at ${difficulty} AI, then every car stands where it does under the other seed after ${OPENING} s of racing`, () => {
      const stand = (seed: number) => opening(0, seed, difficulty, (w) => w.live().flatMap((c) => c.group.position.toArray()));
      const first = stand(1);
      assert.ok(first.length >= 3 * (AI_RIVALS + 1) && first.some((v) => v !== 0), "the cars stand somewhere: the test proves nothing otherwise");
      assertSameNumbers(stand(2), first, "every car's position under field seed 2");
    });

    it(`when ${AI_RIVALS} rivals leave the oval's grid at ${difficulty} AI, then no racer drives into another car in the first ${OPENING} s of racing`, () => {
      const track = new Track(oval);
      const w = makeWorld();
      w.race.enter();
      try {
        const r = contactRace(w, track, COUNTDOWN + OPENING, 1, 0, AI_RIVALS, difficulty);
        const hits = r.contacts.filter((c) => !c.traffic && c.initiator >= 0).map((c) => `frame ${c.frame}: car ${c.initiator} into car ${c.initiator === c.a ? c.b : c.a} (closing ${c.verdict.closing.toFixed(1)} m/s)`);
        assert.deepEqual(hits, []);
      } finally {
        w.race.exit();
        setGround(null);
      }
    });
  }
});
