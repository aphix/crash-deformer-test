import { describe, it } from "node:test";
import { BOOST, DRIVE } from "../vehicle/car-drive.ts";
import assert from "node:assert/strict";
import * as THREE from "three";
import { applyDrive, idleDrive } from "../vehicle/car-drive.ts";
import { DeformableCar } from "../vehicle/car.ts";
import { blankAiCar, type AiCar } from "./derby-ai.ts";
import { snapshotAiCar } from "../match/derby.ts";
import { fleetStyle } from "../scenes/fleet.ts";
import { SURFACES } from "../world/catalog.ts";
import { RaceBrain, onSurface } from "./race-ai.ts";
import { fieldAggression, mood } from "./ai-aggression.ts";
import { RaceSession } from "../match/session.ts";
import { Track, blankProjection, projectPath } from "../world/track.ts";
import { parseTrack } from "../world/track-schema.ts";
import { TRACKS } from "../world/tracks/index.ts";
import { setGround } from "../world/ground.ts";
import type { CarPose, Entrant } from "../match/types.ts";
import { assertSameNumbers } from "../vehicle/test-support.ts";

const DT = 1 / 60;

type Run = { session: RaceSession; onRoad: number; samples: number };

/**
 * Real cars on the real drive model (kinematic, as every car is until it crashes) on the course's
 * ground, no car-to-car contact: the AI alone has to keep them on the road and round the laps.
 */
function race(track: Track, n: number, aggression: number, laps: number, limit: number): Run {
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
  }
  const snaps: AiCar[] = cars.map((_, i) => blankAiCar(i));
  const poses: CarPose[] = cars.map(() => ({ x: 0, z: 0, yaw: 0, vx: 0, vz: 0, alive: true }));
  const hold = { ...idleDrive(), brake: 1 };
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
      const input = session.phase === "racing" && rec.status === "racing" ? brain.think(snaps[i]!, snaps, rec, DT) : hold;
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
  return { session, onRoad, samples };
}

const at = (id: number, x: number, z: number, vz: number): AiCar => ({ ...blankAiCar(id), x, z, vz });

describe("given 8 clean AI cars (aggression 0) on the grid of every course", () => {
  for (const json of TRACKS) {
    const track = new Track(json);
    it(`when they race 3 laps on ${track.id}, then all 8 finish, they stay on the road at least 95% of the time, and the winner finishes within the time bound`, () => {
      // Half the drive model's top speed on average, plus the countdown and grid.
      const limit = (3 * track.length) / (DRIVE.maxFwd / 2) + 10;
      const { session, onRoad, samples } = race(track, 8, 0, 3, limit);
      const fin = session.cars.filter((c) => c.status === "finished");
      assert.equal(fin.length, 8, `finished ${fin.length}/8 by ${session.time.toFixed(0)} s (bound ${limit.toFixed(0)} s); laps ${session.cars.map((c) => c.lap).join(",")}`);
      const share = onRoad / samples;
      assert.ok(share >= 0.95, `on the road ${(share * 100).toFixed(1)}% of ${samples} samples`);
      const winner = session.cars.find((c) => c.id === session.winnerId)!;
      assert.ok(winner.finishTime! < limit);
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
