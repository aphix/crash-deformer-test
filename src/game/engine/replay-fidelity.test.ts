import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "../world/ground.ts";
import { makeWorld, type World } from "../world/race-world.test-util.ts";
import { blankPoint, Track } from "../world/track.ts";
import oval from "../world/tracks/oval.json" with { type: "json" };
import { clipBytes } from "../net/reel-codec.ts";
import { agreement, recordFlat, recordRace, type Agreement, type Recording, type Spawn } from "./replay-fidelity.test-util.ts";

/**
 * The owner wants a replay or a highlight reel to show the crash as it happened. The recorder's clip (its first keyframe,
 * the steps' dt, schedule and pedals, and a keyframe where a car was put on a spot) is re-run by `ClipSim`; over the
 * whole clip, every car of it is held to the sim that recorded it. A replay that restores every word the sim steps on and
 * runs the same steps on the same pedals IS that sim: the pedals are on the 8-bit grid in the live sim itself
 * (`applyDrive`), so the clip holds exactly what the sim ran, and a pile-up replays to the bit however chaotic it is.
 */
/** Spawn shifts (m) of the pile-ups: the same crash as other, equally valid realizations of it. */
const SHIFTS = [1e-9, 3e-9, 1e-6, 1e-3];

const rows: string[] = [];
const mm = (m: number): string => (m * 1000).toFixed(3);
function check(name: string, rec: Recording, a: Agreement): void {
  rows.push(`${name}: ${rec.clip.cars.length} cars ${a.steps} steps ${(clipBytes(rec.clip) / 1024).toFixed(0)} KB; wreck flags differ ${a.wreckMismatch}; pose ${mm(a.pose.max)} mm, ${a.vel.max} m/s, crush ${mm(a.crush.max)} mm`);
  assert.ok(a.steps >= 100, `${name}: ${a.steps} steps compared`);
  assert.equal(a.wreckMismatch, 0, `${name}: a car is a wreck in one run and not in the other for ${a.wreckMismatch} car-steps`);
  // The point of the keyframes: what a replay restores is all the sim reads. Any error here is state a keyframe fails to carry.
  assert.deepEqual({ pose: a.pose.max, vel: a.vel.max, crush: a.crush.max }, { pose: 0, vel: 0, crush: 0 }, `${name}: a car strays from the live sim (m, m/s, m)\n${rows.at(-1)}`);
}

describe("given a highlight clip recorded from a crash and replayed from its keyframes", () => {
  describe("given a race on the oval track where only the crash's own cars are driving (the player's car plus 1 to 3 AI drivers)", () => {
    const track = new Track(oval);
    const pt = blankPoint();
    const w: World = makeWorld();
    before(() => {
      w.race.enter();
    });
    after(() => {
      w.race.exit();
      setGround(null);
    });

    /** Car `slot` at track distance `d`, `side` m off the centre line (right positive), heading along the road plus `turn`, at `speed`. */
    function put(slot: number, d: number, side: number, turn: number, speed: number): void {
      track.pointAt(d, pt);
      const yaw = Math.atan2(pt.tx, pt.tz);
      w.cars[slot]!.spawnFacing(pt.x + side * pt.tz, pt.z - side * pt.tx, yaw + turn, speed);
    }
    /**
     * The crash's own cars and no others: `ai` AI drivers beside the player's car (which the AI drives too). The race AI
     * steers clear of what it closes on (`guardContact`): the two spare cars of a four-car field no longer ran into the
     * crash. The derby fixtures below spawn just their own cars too.
     */
    const run = (name: string, place: () => void, ai: number): void => {
      const rec = recordRace(w, place, 9, ai);
      const { clip } = rec;
      const a = clip.cars[clip.firstA]?.slot;
      const b = clip.cars[clip.firstB]?.slot;
      assert.ok((a === 0 && b === 1) || (a === 1 && b === 0), `${name}: the clip's first impact is car ${a} against ${b ?? "a wall"}, not car 0 against car 1`);
      check(name, rec, agreement(rec, () => w.race.resetProps()));
    };
    /**
     * A human at car 0's wheel, gas down, until it first touches the other car, then the AI again. The race AI brakes and
     * steers away from a car it closes on, so no AI-driven car is driven into another's side; the derby fixtures below script
     * their cars' pedals the same way.
     */
    const drive = (): void => {
      w.seat.carIndex = 0;
      w.seat.mode = "drive";
      w.seat.intent.gas = 1;
      w.onPairContact = () => {
        w.seat.mode = "follow";
        w.seat.intent.gas = 0;
        w.onPairContact = null;
      };
    };
    /** The pile-up with every car `s` m further along the road. */
    const pile = (s: number) => () => (put(0, 40 + s, 0, 0, 20), put(1, 48 + s, 0, Math.PI, 20), put(2, 30 + s, 0, 0, 20), put(3, 20 + s, 0, 0, 20));

    const raceHeadOnCases = [
      { it: "when two cars 8 m apart drive head-on at each other at 20 m/s each, then the clip's first impact is between those two cars and the replay matches the live sim at every step, to the bit", name: "race head-on", sideA: 0, sideB: 0 },
      { it: "when the same head-on is offset so the cars' centre lines are 1 m apart, then the clip's first impact is between those two cars and the replay matches the live sim at every step, to the bit", name: "race offset", sideA: 0.5, sideB: -0.5 },
    ] as const;
    for (const testCase of raceHeadOnCases) {
      it(testCase.it, () => run(testCase.name, () => (put(0, 40, testCase.sideA, 0, 20), put(1, 48, testCase.sideB, Math.PI, 20)), 1));
    }
    it("when a car driven flat out hits the side of a stopped car, then the clip's first impact is between those two cars and the replay matches the live sim at every step, to the bit", () =>
      run("race T-bone", () => (put(0, 40, 0, 0, 20), put(1, 54, 0, Math.PI / 2, 0), drive()), 1));
    it("when two cars hit head-on and two more run into the wreck, then the clip's first impact is between the head-on pair and the replay matches the live sim at every step, to the bit", () => run("race pile-up", pile(0), 3));
    for (const s of SHIFTS) it(`when the same pile-up happens ${s} m further along the road, then the replay matches the live sim at every step, to the bit, just as for the unshifted pile-up`, () => run(`race pile-up shifted ${s} m`, pile(s), 3));
  });

  describe("given a flat derby field with no walls, where wear alone can destroy a car", () => {
    const HEAD = Math.PI / 2;
    const run = (name: string, spawns: Spawn[], touched: readonly number[] = []): void => {
      const rec = recordFlat(spawns, 8, true, touched);
      check(name, rec, agreement(rec));
    };
    /** The pile-up with its start x (or z) shifted by `s` m: two head-on, one behind, one across. */
    const pile = (s: number): Spawn[] => [
      { x: 0 + s, z: 0, yaw: HEAD, speed: 20, throttle: 1 },
      { x: 80 - s, z: 0, yaw: -HEAD, speed: 20, throttle: 1 },
      { x: -12 + s, z: 0.5, yaw: HEAD, speed: 20, throttle: 1 },
      { x: 40, z: 60 + s, yaw: Math.PI, speed: 20, throttle: 1 },
    ];

    const derbyCrashCases = [
      { it: "when two cars 80 m apart drive head-on at each other at 20 m/s each, then the replay matches the live sim at every step, to the bit", name: "derby head-on", secondX: 80, secondZ: 0, secondYaw: -HEAD },
      { it: "when the same head-on is offset so the cars' centre lines are 1 m apart, then the replay matches the live sim at every step, to the bit", name: "derby offset", secondX: 80, secondZ: 1, secondYaw: -HEAD },
      { it: "when one car drives at 20 m/s into the side of another driving across its path at 20 m/s, then the replay matches the live sim at every step, to the bit", name: "derby T-bone", secondX: 40, secondZ: 40, secondYaw: Math.PI },
    ] as const;
    for (const testCase of derbyCrashCases) {
      it(testCase.it, () =>
        run(testCase.name, [
          { x: 0, z: 0, yaw: HEAD, speed: 20, throttle: 1 },
          { x: testCase.secondX, z: testCase.secondZ, yaw: testCase.secondYaw, speed: 20, throttle: 1 },
        ]));
    }
    it("when two cars hit head-on, a third follows behind one of them and a fourth comes across, then the replay matches the live sim at every step, to the bit", () => run("derby pile-up", pile(0)));
    for (const s of SHIFTS) it(`when the same pile-up's start is shifted ${s} m, then the replay matches the live sim at every step, to the bit, just as for the unshifted pile-up`, () => run(`derby pile-up shifted ${s} m`, pile(s)));
    // A bystander intact beside the head-on's wrecks, 1.9 m off their line (its hull touches theirs): a light touch from a wall or a prop
    // before the recording marked its contact clock, and the clock of a car whose masses are idle stands still, so it read "just touched"
    // for good and its masses met a settled wreck's in the live sim; the keyframe carries nothing of the clock for a car that is no wreck, so
    // the replay's bystander was quiet and the wrecks' masses never met it (seed 30 of engine-replay.test.ts: 2.26 m off). Measured on 32bf18c:
    // marked 0.17 mm / 1.7 cm/s / 7.6 mm off the live sim, unmarked exact.
    const BYSTANDER: Spawn[] = [
      { x: 0, z: 0, yaw: HEAD, speed: 20, throttle: 1 },
      { x: 80, z: 0, yaw: -HEAD, speed: 20, throttle: 1 },
      { x: 40, z: 1.9, yaw: HEAD, speed: 0, throttle: 0 },
    ];
    const bystanderCases = [
      { it: "when a wall or prop lightly touched the bystander before the clip began, then the replay matches the live sim at every step, to the bit", name: "derby bystander touched", touched: [2] },
      { it: "when nothing touched the bystander before the clip began, then the replay matches the live sim at every step, to the bit", name: "derby bystander untouched", touched: [] },
    ] as const;
    describe("given a head-on's two cars and a stopped bystander car 1.9 m off their line, its hull touching theirs", () => {
      for (const testCase of bystanderCases) {
        it(testCase.it, () => run(testCase.name, BYSTANDER, testCase.touched));
      }
    });
  });

  // The adaptive pacer (`SimPacer`) steps a slow device at 1/120 s; the recorder stores each step's dt, so its clips replay as exactly.
  describe("given a derby recorded on a slow device whose sim steps at 1/120 s instead of 1/240 s", () => {
    const HEAD = Math.PI / 2;
    const run = (name: string, spawns: Spawn[]): void => {
      const rec = recordFlat(spawns, 8, true, [], 1 / 120);
      const coarse = rec.clip.h.filter((h) => h > 1 / 120 - 1e-6).length;
      assert.ok(coarse > rec.clip.h.length / 2, `${name}: ${coarse} of ${rec.clip.h.length} steps at 1/120 s (the rest are frame remainders)`);
      check(name, rec, agreement(rec));
    };
    const coarseStepCases = [
      {
        it: "when two cars 80 m apart drive head-on at each other at 20 m/s each, then most steps are 1/120 s and the replay matches the live sim at every step, to the bit",
        name: "coarse head-on",
        spawns: [
          { x: 0, z: 0, yaw: HEAD, speed: 20, throttle: 1 },
          { x: 80, z: 0, yaw: -HEAD, speed: 20, throttle: 1 },
        ],
      },
      {
        it: "when two cars hit head-on, a third follows behind one of them and a fourth comes across, then most steps are 1/120 s and the replay matches the live sim at every step, to the bit",
        name: "coarse pile-up",
        spawns: [
          { x: 0, z: 0, yaw: HEAD, speed: 20, throttle: 1 },
          { x: 80, z: 0, yaw: -HEAD, speed: 20, throttle: 1 },
          { x: -12, z: 0.5, yaw: HEAD, speed: 20, throttle: 1 },
          { x: 40, z: 60, yaw: Math.PI, speed: 20, throttle: 1 },
        ],
      },
    ] as const;
    for (const testCase of coarseStepCases) {
      it(testCase.it, () => run(testCase.name, [...testCase.spawns]));
    }
  });

  it("when every crash above has been replayed, then the worst pose, velocity and crush errors of each are reported as a diagnostic table", (t) => t.diagnostic(rows.join("\n")));
});
