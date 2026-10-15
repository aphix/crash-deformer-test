import { describe, it } from "node:test";
import { BOOST, DRIVE } from "../vehicle/car-drive.ts";
import assert from "node:assert/strict";
import * as THREE from "three";
import { applyDrive, idleDrive, type DriveInput } from "../vehicle/car-drive.ts";
import { DeformableCar } from "../vehicle/car.ts";
import { blankAiCar, type AiCar } from "./derby-ai.ts";
import { snapshotAiCar } from "../match/derby.ts";
import { fleetStyle } from "../scenes/fleet.ts";
import { SURFACES } from "../world/catalog.ts";
import { RaceBrain, copyDrive, onSurface } from "./race-ai.ts";
import { AI_DIFFICULTIES, AI_EVERY_SLICE, SLIP_RECOVER, SLIP_WINDOW, type AiDifficulty } from "./constants.ts";
import { fieldAggression, mood } from "./ai-aggression.ts";
import { RaceSession } from "../match/session.ts";
import { Track, blankProjection, projectPath } from "../world/track.ts";
import { parseTrack } from "../world/track-schema.ts";
import { TRACKS } from "../world/tracks/index.ts";
import { setGround } from "../world/ground.ts";
import type { CarPose, Entrant } from "../match/types.ts";
import { assertSameNumbers } from "../vehicle/test-support.ts";

const DT = 1 / 60;

type Run = { session: RaceSession; onRoad: number; samples: number; mistakes: number };

/**
 * Real cars on the real drive model (kinematic, as every car is until it crashes) on the course's
 * ground, no car-to-car contact: the AI alone has to keep them on the road and round the laps.
 */
function race(track: Track, n: number, aggression: number, laps: number, limit: number, difficulty: AiDifficulty = AI_EVERY_SLICE, tap?: (id: number, out: DriveInput) => void): Run {
  const scene = new THREE.Scene();
  const ground = track.ground();
  setGround(ground);
  const cars = Array.from({ length: n }, (_, i) => new DeformableCar({ body: 0x808080, accent: 0x404040, name: `ai${i}` }, scene, null, fleetStyle(i)));
  const entrants: Entrant[] = cars.map((_, i) => ({ id: i, name: `ai${i}`, kind: "ai", aggression }));
  const session = new RaceSession(track, entrants, { laps, noReset: false });
  const brain = new RaceBrain(track, n);
  for (const [i, c] of cars.entries()) {
    const g = track.gridSlot(i);
    c.spawnFacing(g.x, g.z, g.yaw, 0);
    brain.setAggression(i, aggression);
    brain.setDifficulty(i, difficulty);
  }
  const snaps: AiCar[] = cars.map((_, i) => blankAiCar(i));
  const poses: CarPose[] = cars.map(() => ({ x: 0, z: 0, yaw: 0, vx: 0, vz: 0, alive: true }));
  const hold = { ...idleDrive(), brake: 1 };
  const held = cars.map(() => idleDrive());
  const scratch = idleDrive();
  const p = blankProjection();
  let onRoad = 0;
  let samples = 0;
  let step = 0;
  while (session.phase !== "finished" && session.time < limit) {
    for (const [i, c] of cars.entries()) snapshotAiCar(snaps[i]!, i, c, true);
    for (const [i, c] of cars.entries()) {
      const rec = session.cars[i]!;
      const surf = SURFACES[ground.surfaceAt(c.group.position.x, c.group.position.z)];
      let input = hold;
      if (session.phase === "racing" && rec.status === "racing") {
        if (brain.due(i, DT)) {
          const out = brain.think(snaps[i]!, snaps, rec, brain.elapsed(i));
          tap?.(i, out);
          copyDrive(out, held[i]!);
        }
        input = brain.guard(snaps[i]!, snaps, held[i]!);
      }
      applyDrive(c, onSurface(input, surf, scratch), DT);
      c.integrate(DT);
    }
    for (const [i, c] of cars.entries()) {
      const pose = poses[i]!;
      pose.x = c.group.position.x;
      pose.z = c.group.position.z;
      pose.yaw = c.yaw;
      pose.vx = c.velocity.x;
      pose.vz = c.velocity.z;
    }
    session.step(DT, poses);
    session.events();
    if (session.phase === "racing" && ++step % 6 === 0) {
      for (const [i, c] of cars.entries()) {
        if (session.cars[i]!.status !== "racing") continue;
        samples++;
        const x = c.group.position.x;
        const z = c.group.position.z;
        projectPath(track.path, x, z, -1, p);
        if (Math.abs(p.lateral) <= track.path.half[p.k]! + 0.3) {
          onRoad++;
          continue;
        }
        for (const sc of track.shortcuts) {
          projectPath(sc.path, x, z, -1, p);
          if (Math.abs(p.lateral) <= sc.path.half[p.k]! + 0.3) {
            onRoad++;
            break;
          }
        }
      }
    }
  }
  setGround(null);
  return { session, onRoad, samples, mistakes: brain.mistakes.reduce((a, b) => a + b, 0) };
}

const at = (id: number, x: number, z: number, vz: number): AiCar => ({ ...blankAiCar(id), x, z, vz });

/** How much looser each tier's finish bound is than hard's: the owner asked for slower lower tiers, and a stuck or lost car still misses it by minutes. */
const BOUND_SCALE: Record<AiDifficulty, number> = { easy: 1.2, medium: 1.1, hard: 1 };
const COURSES = TRACKS.map((json) => new Track(json));
type Summary = { winner: number; share: number; samples: number; finished: number; mistakes: number; lapTimes: number[]; time: number; limit: number; laps: string };

/** 8 clean cars racing 3 laps of `track` at `difficulty`, in numbers. */
function summarize(track: Track, difficulty: AiDifficulty): Summary {
  // Half the drive model's top speed on average, plus the countdown and grid.
  const limit = ((3 * track.length) / (DRIVE.maxFwd / 2) + 10) * BOUND_SCALE[difficulty];
  const { session, onRoad, samples, mistakes } = race(track, 8, 0, 3, limit, difficulty);
  return { winner: session.cars.find((c) => c.id === session.winnerId)?.finishTime ?? Infinity, share: onRoad / samples, samples, finished: session.cars.filter((c) => c.status === "finished").length, mistakes, lapTimes: session.cars.flatMap((c) => c.lapTimes), time: session.time, limit, laps: session.cars.map((c) => c.lap).join(",") };
}

const memo = new Map<string, Summary>();
/** `summarize`, remembered: the per-course tests and the tier comparisons share each race. */
function raced(track: Track, difficulty: AiDifficulty): Summary {
  const key = `${track.id}/${difficulty}`;
  if (!memo.has(key)) memo.set(key, summarize(track, difficulty));
  return memo.get(key)!;
}
const total = (d: AiDifficulty, f: (r: Summary) => number): number => COURSES.reduce((a, t) => a + f(raced(t, d)), 0);

const f64 = new Float64Array(5);
const bits = new Uint32Array(f64.buffer);
/** FNV-1a over the bits of one brain output: any change to any float, however small, changes it. */
function fold(h: number, o: DriveInput): number {
  f64.set([o.throttle, o.steer, o.brake, o.boost ? 1 : 0, o.ebrake ? 1 : 0]);
  for (let k = 0; k < bits.length; k++) h = Math.imul(h ^ bits[k]!, 16777619) >>> 0;
  return h;
}
/** A hard brain's output, hashed over each of 8 cars' first 300 and first 600 thinks: marks[2 * car] and marks[2 * car + 1]. */
function hardMarks(track: Track): string[] {
  const hash = new Uint32Array(8).fill(2166136261);
  const count = new Int32Array(8);
  const marks: string[] = [];
  race(track, 8, 0, 3, 20, "hard", (id, out) => {
    if (count[id]! >= 600) return;
    hash[id] = fold(hash[id]!, out);
    if (++count[id]! % 300 === 0) marks[2 * id + count[id]! / 300 - 1] = hash[id]!.toString(16);
  });
  return marks;
}
/**
 * `hardMarks` of the hard brain driving the 8 cars from the grid: the tiers must leave hard's outputs bit for bit as they were. The marks hash those
 * outputs along a real drive, so a change to the drive under the brain re-pins them; the oval's are still the marks pinned before the tiers existed.
 */
const HARD_MARKS: Record<string, string[]> = {
  oval: ["84661866", "2ceaf5e5", "f225d9a0", "9d8034b2", "606b507d", "2a1bf232", "5d2d531e", "f77a5910", "2687c2ae", "40a3ab55", "6144f51e", "1f15c162", "51530d1d", "57b0d8a3", "42dc4706", "8de13631"],
  rally: ["bb4cb28b", "682d5f14", "ba47a3a5", "dcb17bee", "aa31d2a5", "b8285287", "3d1d0992", "bb4adf8f", "f93df60c", "8f1ab300", "f003b310", "eb8fc120", "cb64df49", "974e71ab", "45f61a11", "b372f58e"],
  stunt: ["cfe9223e", "7c29ef0c", "9c71538e", "c480fff", "9ecf007", "adae4797", "5e321814", "bc384445", "d370c5a0", "27ceee7f", "bf7e66de", "46a9ede0", "f72a6dae", "110e9fac", "17e6868", "53f5522a"],
};

for (const difficulty of AI_DIFFICULTIES) {
  describe(`given 8 clean AI cars (aggression 0) at ${difficulty} difficulty on the grid of every course`, () => {
    for (const json of TRACKS) {
      const track = new Track(json);
      it(`when they race 3 laps on ${track.id}, then all 8 finish, they stay on the road at least 95% of the time, and the winner finishes within the time bound`, (t) => {
        const r = raced(track, difficulty);
        t.diagnostic(`${track.id} ${difficulty}: winner ${r.winner.toFixed(1)} s, best lap ${Math.min(...r.lapTimes).toFixed(2)} s, slowest lap ${Math.max(...r.lapTimes).toFixed(2)} s, on road ${(100 * r.share).toFixed(1)}%, mistakes ${r.mistakes}`);
        assert.equal(r.finished, 8, `finished ${r.finished}/8 by ${r.time.toFixed(0)} s (bound ${r.limit.toFixed(0)} s); laps ${r.laps}`);
        assert.ok(r.share >= 0.95, `on the road ${(r.share * 100).toFixed(1)}% of ${r.samples} samples`);
        assert.ok(r.winner < r.limit);
      });
    }
  });
}

describe("given 8 clean AI cars on every course at each difficulty, raced for 3 laps", () => {
  it("when easy races hard, then easy's winner is slower on every course and at least 8% slower on average, and medium's is faster than easy's", () => {
    let mean = 0;
    for (const t of COURSES) {
      const [e, m, h] = AI_DIFFICULTIES.map((d) => raced(t, d).winner);
      assert.ok(e! > h! && m! < e!, `${t.id}: winner easy ${e!.toFixed(1)} s, medium ${m!.toFixed(1)} s, hard ${h!.toFixed(1)} s`);
      mean += e! / h! / COURSES.length;
    }
    assert.ok(mean >= 1.08, `easy takes ${((mean - 1) * 100).toFixed(1)}% longer than hard on average`);
  });
});

describe("given 8 clean AI cars on every course at each difficulty", () => {
  it("when they race 3 laps, then easy makes mistakes on every course and more than medium does, and hard makes exactly none", () => {
    for (const t of COURSES) {
      assert.ok(raced(t, "easy").mistakes > 0, `${t.id}: easy made no mistake`);
      assert.equal(raced(t, "hard").mistakes, 0, t.id);
    }
    const [e, m, h] = AI_DIFFICULTIES.map((d) => total(d, (r) => r.mistakes));
    assert.ok(e! > m! && m! > 0 && h === 0, `mistakes: easy ${e}, medium ${m}, hard ${h}`);
  });
});

describe("given the same 8 easy AI cars raced twice from the grid of the oval", () => {
  it("when both runs finish, then every car's lap times are identical, to the bit (slips and sway are seeded, not random)", () => {
    const once = raced(new Track(TRACKS[0]), "easy");
    const again = summarize(new Track(TRACKS[0]), "easy");
    assert.ok(once.mistakes > 0, "a run with no mistakes proves nothing about their seeding");
    assertSameNumbers(again.lapTimes, once.lapTimes, "lap times, run twice");
    assert.equal(again.mistakes, once.mistakes);
  });
});

describe("given a hard brain driving 8 cars from the grid of a course", () => {
  for (const [id, expected] of Object.entries(HARD_MARKS)) {
    it(`when each thinks 600 times on ${id}, then every checkpoint of its output is bit for bit what it was before the tiers existed`, () => {
      const got = hardMarks(new Track(TRACKS.find((j) => parseTrack(j).id === id)!));
      const first = got.findIndex((m, k) => m !== expected[k]);
      assert.ok(first < 0 && got.length === expected.length, `${got.length}/${expected.length} checkpoints, first differing: ${first} (car ${first >> 1}, think ${first % 2 ? 600 : 300})`);
    });
  }
});

const oval = new Track(TRACKS[0]);
const s0 = 40;
const lane = (brain: RaceBrain, self: AiCar, others: AiCar[], steps: number) => {
  let steer = 0;
  for (let k = 0; k < steps; k++) steer = brain.think(self, others, { next: 1, lap: 0 }, DT).steer;
  return steer;
};
const pt = oval.pointAt(s0, { x: 0, y: 0, z: 0, tx: 0, tz: 1, half: 0 });
/** A car on `track`'s centre line `s` m along, `off` m to the left of it (+), doing `v` m/s along the road. */
const onRoad = (track: Track, id: number, s: number, off: number, v: number): AiCar => {
  const p = track.pointAt(s, { x: 0, y: 0, z: 0, tx: 0, tz: 1, half: 0 });
  return { ...blankAiCar(id), x: p.x + off * p.tz, z: p.z - off * p.tx, yaw: Math.atan2(p.tx, p.tz), vx: p.tx * v, vz: p.tz * v };
};

describe("given AI drivers at about 17 m/s on the oval course's back straight, with another car close by", () => {
  it("when a slower car is ahead on its line near the left edge, so the only pass is to the right, then a clean driver pulls right to pass while an aggressive one stays on the slow car's line, keeping the throttle in to ram it", () => {
    // Back straight runs +Z at x = −55: left of travel is +X. Both near the left edge, so the only pass is to the right.
    const me = at(0, pt.x + 6, pt.z, 17);
    const slow = at(1, pt.x + 6, pt.z + 9, 8);
    const clean = new RaceBrain(oval, 2);
    const passing = lane(clean, me, [me, slow], 40);
    const brute = new RaceBrain(oval, 2);
    brute.setAggression(0, 1);
    const ramming = lane(brute, me, [me, slow], 40);
    assert.ok(passing < -0.05, `clean pulls right to pass, steer ${passing.toFixed(3)}`);
    assert.ok(Math.abs(ramming) < 0.06 && Math.abs(ramming) < Math.abs(passing) / 3, `aggressive stays on the slow car's line, steer ${ramming.toFixed(3)} vs clean ${passing.toFixed(3)}`);
    const charge = brute.think(me, [me, slow], { next: 1, lap: 0 }, DT);
    assert.ok(charge.throttle > 0 && charge.brake === 0, "and keeps the throttle in");
  });

  it("when a faster car comes through just behind on its left, then an aggressive driver steers left into its path to close the door and a clean one moves away to give it room", () => {
    const me = at(0, pt.x, pt.z, 12);
    const fast = at(1, pt.x + 3, pt.z - 5, 18);
    const clean = new RaceBrain(oval, 2);
    const brute = new RaceBrain(oval, 2);
    brute.setAggression(0, 1);
    const yields = lane(clean, me, [me, fast], 40);
    const blocks = lane(brute, me, [me, fast], 40);
    assert.ok(blocks > 0.02, `aggressive steers into its path (left is +), steer ${blocks.toFixed(3)}`);
    assert.ok(yields < -0.02, `clean moves away from it, steer ${yields.toFixed(3)}`);
  });

  it("when a rival ahead is closed on at a ram's speed (9 m/s) or a nudge's (1 m/s), then a middling driver passes the rammable car, wrecked or not, and pushes the nudge-speed one unless it is itself the more wrecked car, while a full-aggression driver rams regardless of its own state", () => {
    const me = at(0, pt.x + 6, pt.z, 17);
    const mid = () => {
      const b = new RaceBrain(oval, 2);
      b.setAggression(0, 0.5);
      return b;
    };
    // A rival 9 m ahead doing 8 m/s is a ram (closing 9 m/s): passed, wrecked or not. One doing 16 m/s is a nudge (1 m/s): pushed.
    const slow = at(1, pt.x + 6, pt.z + 9, 8);
    const pace = at(1, pt.x + 6, pt.z + 9, 16);
    assert.ok(lane(mid(), me, [me, slow], 40) < -0.05, "passes the slow car it would ram");
    assert.ok(lane(mid(), me, [me, { ...slow, damage: 0.6 }], 40) < -0.05, "and a wrecked one too");
    assert.ok(Math.abs(lane(mid(), me, [me, pace], 40)) < 0.06, "pushes the one it closes on at a nudge");
    const hurtMe = { ...me, damage: 0.8 };
    assert.ok(lane(mid(), hurtMe, [hurtMe, { ...pace, damage: 0.6 }], 40) < -0.05, "but not when it is the more wrecked of the two");
    const brute = new RaceBrain(oval, 2);
    brute.setAggression(0, 1);
    assert.ok(Math.abs(lane(brute, hurtMe, [hurtMe, slow], 40)) < 0.06, "full aggression rams regardless of its own state");
  });

  it("when a rival is abreast 2.6 m to its left, then a clean driver steers away, a full-aggression driver always shoves, and a middling one shoves only a safe rival: not one 1.5 m off the wall, not at a ram's closing speed, not over the stunt course's crest", () => {
    const stunt = new Track(TRACKS.find((j) => parseTrack(j).id === "stunt"));
    // `me` abreast of a rival 2.6 m to its left (+) on `track` at `s`, doing `my` and `its` m/s, the rival `lean` m left of the road's middle: the steer after a second.
    // A middling driver's shove swings over gently (0.5 m/s: the two close at a nudge), so its steer stays about level where a clean driver's goes away.
    const abreast = (aggression: number, track: Track, s: number, lean: number, my = 15, its = 15) => {
      const b = new RaceBrain(track, 2);
      b.setAggression(0, aggression);
      const self = onRoad(track, 0, s, lean - 2.6, my);
      return lane(b, self, [self, onRoad(track, 1, s + 0.5, lean, its)], 60);
    };
    const edge = pt.half - 1.5;
    assert.ok(abreast(0, oval, s0, 1.3) < -0.05, "a clean driver steers away");
    assert.ok(abreast(1, oval, s0, 1.3) > 0.15, "a full one shoves");
    assert.ok(abreast(0.5, oval, s0, 1.3) > 0, "a middling one shoves a rival mid-road, level");
    assert.ok(abreast(0.5, oval, s0, edge) < -0.05, "but not one 1.5 m off the wall it would be pushed into");
    assert.ok(abreast(1, oval, s0, edge) > 0.15, "where a full driver shoves regardless");
    assert.ok(abreast(0.5, oval, s0, 1.3, 15, 12) < -0.05, "nor closing on it at 3 m/s");
    assert.ok(abreast(0.5, oval, s0, 1.3, 12, 15) < -0.05, "nor with the rival the faster by 3 m/s");
    assert.ok(abreast(0.5, stunt, 300, 1.3, 20, 20) > 0.1, "on level road at 20 m/s it shoves");
    assert.ok(abreast(0.5, stunt, 899.5, 1.3, 20, 20) < -0.05, "the same pair on the stunt course's crest (a car leaves it above 17 m/s): it keeps off");
    assert.ok(abreast(1, stunt, 899.5, 1.3, 20, 20) > 0.1, "and a full driver shoves there regardless");
  });

  it("when a rival 6 m ahead drives at the driver's own 17 m/s pace, then a clean driver brakes to keep a gap without boosting, and a hungry one boosts to catch it", () => {
    const me = at(0, pt.x, pt.z, 17);
    const rival = at(1, pt.x, pt.z + 6, 17);
    const clean = new RaceBrain(oval, 2).think(me, [me, rival], { next: 1, lap: 0 }, DT);
    assert.ok(!clean.boost && clean.brake > 0, `clean opens the gap: brake ${clean.brake.toFixed(2)}, boost ${clean.boost}`);
    const brute = new RaceBrain(oval, 2);
    brute.setAggression(0, 1);
    const hunt = brute.think(me, [me, rival], { next: 1, lap: 0 }, DT);
    assert.ok(hunt.boost && hunt.throttle > 0, `hungry boosts into it: throttle ${hunt.throttle.toFixed(2)}, boost ${hunt.boost}`);
  });

  it("when a rival is 2.6 m to its left at 15 m/s, then a hungry driver steers left into it and a clean one steers away, and at a 2 m/s crawl a hungry driver steers the same as if it were alone", () => {
    // Left of travel is +X on this straight: the rival sits on our left.
    const me = at(0, pt.x, pt.z, 15);
    const rival = at(1, pt.x + 2.6, pt.z + 0.5, 15);
    const brute = new RaceBrain(oval, 2);
    brute.setAggression(0, 1);
    const shove = lane(brute, me, [me, rival], 20);
    const shy = lane(new RaceBrain(oval, 2), me, [me, rival], 20);
    assert.ok(shove > 0.05, `hungry steers left into it, steer ${shove.toFixed(3)}`);
    assert.ok(shy < -0.02, `clean steers away, steer ${shy.toFixed(3)}`);
    const slowMe = at(0, pt.x, pt.z, 2);
    const slowRival = at(1, pt.x + 2.6, pt.z + 0.5, 2);
    const hungry = () => {
      const b = new RaceBrain(oval, 2);
      b.setAggression(0, 1);
      return b;
    };
    const withRival = lane(hungry(), slowMe, [slowMe, slowRival], 20);
    const alone = lane(hungry(), slowMe, [slowMe], 20);
    assert.ok(Math.abs(withRival - alone) < 0.01, `at a crawl it drives its line as if alone (two hungry cars wedged each other on a wall): ${withRival.toFixed(3)} vs ${alone.toFixed(3)}`);
  });

  it("when a driver crawling at 2 m/s comes up on a parked car 5.5 m ahead, then it keeps rolling without braking and steers round it", () => {
    const me = at(0, pt.x, pt.z, 2);
    const parked = at(1, pt.x, pt.z + 5.5, 0);
    const out = new RaceBrain(oval, 2).think(me, [me, parked], { next: 1, lap: 0 }, DT);
    assert.ok(out.throttle > 0 && out.brake === 0, `keeps rolling: throttle ${out.throttle.toFixed(2)}, brake ${out.brake.toFixed(2)}`);
    assert.ok(Math.abs(lane(new RaceBrain(oval, 2), me, [me, parked], 40)) > 0.05, "and steers round it");
  });
});

describe("given the field's aggression slider (the most aggressive any rival may be)", () => {
  it("when 15 rivals roll their own values under a slider of 0.6, then each is between 0 and 0.6 with a real spread, the same seed gives the same field, a new race rolls again, a slider of 0 gives all 0, and the mood to hit is negative at aggression 0 and positive at full aggression", () => {
    const rolls = Array.from({ length: 15 }, (_, id) => fieldAggression(0.6, 4, id + 1));
    assert.ok(rolls.every((a) => a >= 0 && a <= 0.6));
    assert.ok(Math.max(...rolls) - Math.min(...rolls) > 0.3, "a spread, not one value");
    assertSameNumbers(rolls, Array.from({ length: 15 }, (_, id) => fieldAggression(0.6, 4, id + 1)), "same seed, same field");
    const reroll = Array.from({ length: 15 }, (_, id) => fieldAggression(0.6, 5, id + 1));
    assert.ok(reroll.some((a, i) => a !== rolls[i]), "a new race rolls again");
    assert.ok(Array.from({ length: 15 }, (_, id) => fieldAggression(0, 4, id)).every((a) => a === 0));
    assert.ok(mood(0, 0, 1) < 0 && mood(1, 1, 0) > 0);
  });
});

describe("given an AI driver at 17 m/s alone on a clear straight with a full boost meter", () => {
  it("when it drives for 10 s, then it boosts in bursts no longer than a full meter and in total no more than a full meter plus what the meter refills over the run", () => {
    const me = at(0, pt.x, pt.z, 17);
    const brain = new RaceBrain(oval, 1);
    const T = 10;
    let boosted = 0;
    let run = 0;
    let longest = 0;
    for (let k = 0; k < T / DT; k++) {
      const b = brain.think(me, [me], { next: 1, lap: 0 }, DT).boost;
      boosted += b ? DT : 0;
      run = b ? run + DT : 0;
      longest = Math.max(longest, run);
    }
    assert.ok(longest >= BOOST.full - 2 * DT, `first burst ${longest.toFixed(2)} s`);
    assert.ok(longest <= BOOST.full + DT, `one burst ${longest.toFixed(2)} s, a full meter is ${BOOST.full} s`);
    // A full meter plus what it refills over the run.
    const budget = BOOST.full + (T * BOOST.full) / BOOST.recharge;
    assert.ok(boosted <= budget + DT, `boosted ${boosted.toFixed(2)} s of ${T} s, budget ${budget.toFixed(2)} s`);
  });
});

describe("given a road only 6 m wide with a driver at 15 m/s coming up on a 6 m/s car 7 m ahead", () => {
  it("when the driver reaches it, then it brakes with the throttle off and follows instead of passing", () => {
    const narrow = new Track({ ...(TRACKS[0] as object), road: { width: 6, runoff: [3, 3], surface: "asphalt", runoffSurface: "concrete" } });
    const p = narrow.pointAt(s0, { x: 0, y: 0, z: 0, tx: 0, tz: 1, half: 0 });
    const me = at(0, p.x, p.z, 15);
    const slow = at(1, p.x, p.z + 7, 6);
    const brain = new RaceBrain(narrow, 2);
    const out = brain.think(me, [me, slow], { next: 1, lap: 0 }, DT);
    assert.ok(out.brake > 0 && out.throttle === 0, `brake ${out.brake} throttle ${out.throttle}`);
  });
});

describe("given an AI driver at 30 m/s on the oval's back straight, alone, its nose 0.6 rad off the road's heading toward the left edge", () => {
  it("when it is 1 m past the left edge, so steering back onto its line asks for more than full lock off the road, then it brakes with the throttle off; and on the road's centre line, pointed the same way, it keeps the throttle on", () => {
    // Of the two headings 0.6 rad off the road's, the one with a component along the road's left (tz, -tx).
    const roadYaw = Math.atan2(pt.tx, pt.tz);
    const yaw = Math.sin(roadYaw + 0.6) * pt.tz - Math.cos(roadYaw + 0.6) * pt.tx > 0 ? roadYaw + 0.6 : roadYaw - 0.6;
    const pointedOut = (off: number): AiCar => ({ ...onRoad(oval, 0, s0, off, 0), yaw, vx: 30 * Math.sin(yaw), vz: 30 * Math.cos(yaw) });
    const offRoad = pointedOut(pt.half + 1);
    const wide = new RaceBrain(oval, 1).think(offRoad, [offRoad], { next: 1, lap: 0 }, DT);
    assert.ok(wide.brake > 0 && wide.throttle === 0, `off the road: brake ${wide.brake} throttle ${wide.throttle}`);
    const centred = pointedOut(0);
    const onLine = new RaceBrain(oval, 1).think(centred, [centred], { next: 1, lap: 0 }, DT);
    assert.ok(onLine.throttle > 0 && onLine.brake === 0, `on the road: brake ${onLine.brake} throttle ${onLine.throttle}`);
  });
});

describe("given an easy driver whose slip starts on the oval's open road, then held in traffic past the slip's whole length", () => {
  it("when the road clears, then its slip timer has run out and it plans unshaken top speed, not `shaken` x top", () => {
    const brain = new RaceBrain(oval, 2);
    brain.setDifficulty(0, "easy");
    brain["slipP"][0] = 1;
    const race = { next: 1, lap: 0 };
    const slip = onRoad(oval, 0, 70, 0, 17);
    brain.think(slip, [slip], race, DT);
    assert.equal(brain["slip"][0], SLIP_WINDOW + SLIP_RECOVER, "a corner on an open road started the slip");
    // On the back straight (no corner in the plan), an 8 m/s car 9 m ahead on its line: it follows, so the road is not open.
    const me = onRoad(oval, 0, 340, 0, 17);
    const slow = onRoad(oval, 1, 349, 0, 8);
    for (let k = 0; k < Math.ceil((SLIP_WINDOW + SLIP_RECOVER + 1) / DT); k++) brain.think(me, [me, slow], race, DT);
    assert.equal(brain["busy"][0], 1, "the slow car held it in traffic");
    const out = brain.think(me, [me], race, DT);
    assert.equal(brain["busy"][0], 0, "the road cleared");
    assert.equal(brain["slip"][0], 0, "the slip aged out in traffic");
    assert.ok(out.throttle === 1 && out.brake === 0, `unshaken: throttle ${out.throttle} brake ${out.brake}`);
  });
});
