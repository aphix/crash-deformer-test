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

describe("a clip replays the crash as the sim that recorded it ran it", () => {
  describe("in a race (oval, 3 AI)", () => {
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

    it("bad: a head-on at 2 x 20 m/s", () => run("race head-on", () => (put(0, 40, 0, 0, 20), put(1, 48, 0, Math.PI, 20)), 1));
    it("bad: an offset head-on, a metre off centre", () => run("race offset", () => (put(0, 40, 0.5, 0, 20), put(1, 48, -0.5, Math.PI, 20)), 1));
    it("bad: a T-bone, a car driven into another's side", () => run("race T-bone", () => (put(0, 40, 0, 0, 20), put(1, 54, 0, Math.PI / 2, 0), drive()), 1));
    it("bad: a pile-up, two head-on and two more running into the wreck", () => run("race pile-up", pile(0), 3));
    for (const s of SHIFTS) it(`bad: the pile-up with its cars ${s} m further along holds the same bound`, () => run(`race pile-up shifted ${s} m`, pile(s), 3));
  });

  describe("in a derby (flat field, wear kill armed)", () => {
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

    it("bad: a head-on at 2 x 20 m/s", () =>
      run("derby head-on", [
        { x: 0, z: 0, yaw: HEAD, speed: 20, throttle: 1 },
        { x: 80, z: 0, yaw: -HEAD, speed: 20, throttle: 1 },
      ]));
    it("bad: an offset head-on, a metre off centre", () =>
      run("derby offset", [
        { x: 0, z: 0, yaw: HEAD, speed: 20, throttle: 1 },
        { x: 80, z: 1, yaw: -HEAD, speed: 20, throttle: 1 },
      ]));
    it("bad: a T-bone", () =>
      run("derby T-bone", [
        { x: 0, z: 0, yaw: HEAD, speed: 20, throttle: 1 },
        { x: 40, z: 40, yaw: Math.PI, speed: 20, throttle: 1 },
      ]));
    it("bad: a pile-up, two head-on, one behind, one across", () => run("derby pile-up", pile(0)));
    for (const s of SHIFTS) it(`bad: the pile-up with its spawns ${s} m off holds the same bound`, () => run(`derby pile-up shifted ${s} m`, pile(s)));
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
    it("bad: a head-on beside a bystander whose contact clock a wall or prop touch marked before the clip", () => run("derby bystander touched", BYSTANDER, [2]));
    it("good: the same head-on beside an untouched bystander (the control: the marked clock was the whole difference)", () => run("derby bystander untouched", BYSTANDER));
  });

  it("report", (t) => t.diagnostic(rows.join("\n")));
});
