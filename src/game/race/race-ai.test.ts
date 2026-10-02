import { describe, it } from "node:test";
import { BOOST, DRIVE } from "../car-drive.ts";
import assert from "node:assert/strict";
import * as THREE from "three";
import { applyDrive, idleDrive } from "../car-drive.ts";
import { DeformableCar } from "../car.ts";
import { blankAiCar, type AiCar } from "../derby-ai.ts";
import { snapshotAiCar } from "../derby.ts";
import { fleetStyle } from "../fleet.ts";
import { SURFACES } from "./catalog.ts";
import { RaceBrain, onSurface } from "./race-ai.ts";
import { fieldAggression, mood } from "../ai-aggression.ts";
import { RaceSession } from "./session.ts";
import { Track, blankProjection, projectPath } from "./track.ts";
import { TRACKS } from "./tracks/index.ts";
import { setGround } from "../ground.ts";
import type { CarPose, Entrant } from "./types.ts";
import { assertSameNumbers } from "../test-support.ts";

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
  cars.forEach((c, i) => {
    const g = track.gridSlot(i);
    c.spawnFacing(g.x, g.z, g.yaw, 0);
    brain.setAggression(i, aggression);
  });
  const snaps: AiCar[] = cars.map((_, i) => blankAiCar(i));
  const poses: CarPose[] = cars.map(() => ({ x: 0, z: 0, yaw: 0, vx: 0, vz: 0, alive: true }));
  const hold = { ...idleDrive(), brake: 1 };
  const scratch = idleDrive();
  const p = blankProjection();
  let onRoad = 0;
  let samples = 0;
  let step = 0;
  while (session.phase !== "finished" && session.time < limit) {
    cars.forEach((c, i) => snapshotAiCar(snaps[i]!, i, c.group.position.x, c.group.position.z, c.yaw, c.velocity.x, c.velocity.z, true, c.deform.masses));
    cars.forEach((c, i) => {
      const rec = session.cars[i]!;
      const surf = SURFACES[ground.surfaceAt(c.group.position.x, c.group.position.z)];
      const input = session.phase === "racing" && rec.status === "racing" ? brain.think(snaps[i]!, snaps, rec, DT) : hold;
      applyDrive(c, onSurface(input, surf, scratch), DT);
      c.integrate(DT);
    });
    cars.forEach((c, i) => {
      const pose = poses[i]!;
      pose.x = c.group.position.x;
      pose.z = c.group.position.z;
      pose.yaw = c.yaw;
      pose.vx = c.velocity.x;
      pose.vz = c.velocity.z;
    });
    session.step(DT, poses);
    session.events();
    if (session.phase === "racing" && ++step % 6 === 0) {
      cars.forEach((c, i) => {
        if (session.cars[i]!.status !== "racing") return;
        samples++;
        const x = c.group.position.x;
        const z = c.group.position.z;
        projectPath(track.path, x, z, -1, p);
        if (Math.abs(p.lateral) <= track.path.half[p.k]! + 0.3) {
          onRoad++;
          return;
        }
        for (const sc of track.shortcuts) {
          projectPath(sc.path, x, z, -1, p);
          if (Math.abs(p.lateral) <= sc.path.half[p.k]! + 0.3) {
            onRoad++;
            return;
          }
        }
      });
    }
  }
  setGround(null);
  return { session, onRoad, samples };
}

const at = (id: number, x: number, z: number, vz: number): AiCar => ({ ...blankAiCar(id), x, z, vz });

describe("race AI", () => {
  for (const json of TRACKS) {
    const track = new Track(json);
    it(`${track.id}: 8 clean AI cars finish 3 laps on the road within the time bound`, () => {
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

  const oval = new Track(TRACKS[0]);
  const s0 = 40;
  const lane = (brain: RaceBrain, self: AiCar, others: AiCar[], steps: number) => {
    let steer = 0;
    for (let k = 0; k < steps; k++) steer = brain.think(self, others, { next: 1, lap: 0 }, DT).steer;
    return steer;
  };
  const pt = oval.pointAt(s0, { x: 0, y: 0, z: 0, tx: 0, tz: 1, half: 0 });

  it("passes a slower car ahead on its line; an aggressive driver rams it instead", () => {
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

  it("an aggressive driver closes the door on a faster car coming through; a clean one gives it room", () => {
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

  it("at middling aggression a driver only goes for a rival more wrecked than itself; at full it goes for anyone", () => {
    const me = at(0, pt.x + 6, pt.z, 17);
    const wrecked = { ...at(1, pt.x + 6, pt.z + 9, 8), damage: 0.6 };
    const healthy = at(1, pt.x + 6, pt.z + 9, 8);
    const mid = () => {
      const b = new RaceBrain(oval, 2);
      b.setAggression(0, 0.5);
      return b;
    };
    assert.ok(Math.abs(lane(mid(), me, [me, wrecked], 40)) < 0.06, "rams the wrecked car");
    assert.ok(lane(mid(), me, [me, healthy], 40) < -0.05, "passes the healthy one");
    const hurtMe = { ...me, damage: 0.8 };
    assert.ok(lane(mid(), hurtMe, [hurtMe, wrecked], 40) < -0.05, "but not when it is the more wrecked of the two");
    const brute = new RaceBrain(oval, 2);
    brute.setAggression(0, 1);
    assert.ok(Math.abs(lane(brute, hurtMe, [hurtMe, healthy], 40)) < 0.06, "full aggression rams regardless of its own state");
  });

  it("a clean driver keeps a gap behind a rival at its own pace; a hungry one boosts to catch it", () => {
    const me = at(0, pt.x, pt.z, 17);
    const rival = at(1, pt.x, pt.z + 6, 17);
    const clean = new RaceBrain(oval, 2).think(me, [me, rival], { next: 1, lap: 0 }, DT);
    assert.ok(!clean.boost && clean.brake > 0, `clean opens the gap: brake ${clean.brake.toFixed(2)}, boost ${clean.boost}`);
    const brute = new RaceBrain(oval, 2);
    brute.setAggression(0, 1);
    const hunt = brute.think(me, [me, rival], { next: 1, lap: 0 }, DT);
    assert.ok(hunt.boost && hunt.throttle > 0, `hungry boosts into it: throttle ${hunt.throttle.toFixed(2)}, boost ${hunt.boost}`);
  });

  it("door to door, a hungry driver steers into the rival and a clean one away; neither fights at a crawl", () => {
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

  it("closing on a parked car it slows to a crawl and steers round it, never stopping behind it", () => {
    const me = at(0, pt.x, pt.z, 2);
    const parked = at(1, pt.x, pt.z + 5.5, 0);
    const out = new RaceBrain(oval, 2).think(me, [me, parked], { next: 1, lap: 0 }, DT);
    assert.ok(out.throttle > 0 && out.brake === 0, `keeps rolling: throttle ${out.throttle.toFixed(2)}, brake ${out.brake.toFixed(2)}`);
    assert.ok(Math.abs(lane(new RaceBrain(oval, 2), me, [me, parked], 40)) > 0.05, "and steers round it");
  });

  it("the field's aggression slider is a maximum: every rival rolls its own value under it", () => {
    const rolls = Array.from({ length: 15 }, (_, id) => fieldAggression(0.6, 4, id + 1));
    assert.ok(rolls.every((a) => a >= 0 && a <= 0.6));
    assert.ok(Math.max(...rolls) - Math.min(...rolls) > 0.3, "a spread, not one value");
    assertSameNumbers(rolls, Array.from({ length: 15 }, (_, id) => fieldAggression(0.6, 4, id + 1)), "same seed, same field");
    const reroll = Array.from({ length: 15 }, (_, id) => fieldAggression(0.6, 5, id + 1));
    assert.ok(reroll.some((a, i) => a !== rolls[i]), "a new race rolls again");
    assert.ok(Array.from({ length: 15 }, (_, id) => fieldAggression(0, 4, id)).every((a) => a === 0));
    assert.ok(mood(0, 0, 1) < 0 && mood(1, 1, 0) > 0);
  });

  it("boosts on a clear straight, no more than the player's boost meter allows", () => {
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

  it("follows a slower car when the road is too narrow to pass", () => {
    const narrow = new Track({ ...(TRACKS[0] as object), road: { width: 6, runoff: [3, 3], surface: "asphalt", runoffSurface: "concrete" } });
    const p = narrow.pointAt(s0, { x: 0, y: 0, z: 0, tx: 0, tz: 1, half: 0 });
    const me = at(0, p.x, p.z, 15);
    const slow = at(1, p.x, p.z + 7, 6);
    const brain = new RaceBrain(narrow, 2);
    const out = brain.think(me, [me, slow], { next: 1, lap: 0 }, DT);
    assert.ok(out.brake > 0 && out.throttle === 0, `brake ${out.brake} throttle ${out.throttle}`);
  });
});
