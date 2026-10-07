import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { blankAiCar, type AiCar } from "./derby-ai.ts";
import { guardMates } from "./pack-guard.ts";
import { PoliceBrain } from "./police.ts";
import type { PoliceWorld } from "./cop-brain.ts";
import { RaceBrain } from "./race-ai.ts";
import { idleDrive } from "../vehicle/car-drive.ts";
import { blankPoint, blankProjection, Track } from "../world/track.ts";
import oval from "../world/tracks/oval.json" with { type: "json" };

const track = new Track(oval);
const BEAT = 0.25;
const pt = blankPoint();

/** One racer (car 0) and a stakeout of two units (cars 1 and 2) parked ahead of it; whether the camera `seen` them is the test's to set. Unit 1 has just woken (the racer passed it); unit 2, 12 m on, is still parked. */
function rig() {
  const cars: AiCar[] = [0, 1, 2].map(blankAiCar);
  const hunt = new Uint8Array(cars.length);
  hunt[0] = 1;
  const stored: number[] = [];
  const spots: { x: number; z: number }[] = [];
  const view = { seen: false };
  const world: PoliceWorld = {
    park: (id, x, _y, z, yaw) => {
      spots[id] = { x, z };
      Object.assign(cars[id]!, { x, z, vx: 0, vz: 0, yaw });
    },
    store: (id) => {
      stored.push(id);
    },
    seen: () => view.seen,
    down: () => false,
    sirens: () => {},
  };
  const police = new PoliceBrain(track, new RaceBrain(track, 1), 1, 2, 1);
  const lead = track.length * 0.4;
  let time = 0;
  const beat = () => {
    police.update(time, BEAT, cars, hunt, lead, world);
    time += BEAT;
  };
  /** Car 0 on the centreline `ds` m along from unit 1's spot. */
  const sit = (ds: number) => {
    const s = track.project(spots[1]!.x, spots[1]!.z, -1, blankProjection()).s;
    const p = track.pointAt(s + ds, pt);
    Object.assign(cars[0]!, { x: p.x, z: p.z });
  };
  const start = track.pointAt(lead, pt);
  Object.assign(cars[0]!, { x: start.x, z: start.z });
  beat();
  assert.ok(spots[1] && spots[2], "the stakeout parked");
  sit(5);
  beat();
  assert.deepEqual(police.chasers(cars, []).map((c) => c.id), [1], "unit 1 chases");
  assert.equal(stored.length, 0);
  return { police, cars, hunt, stored, view, beat, world };
}

describe("given a racer with a stakeout of two cops parked ahead of it, the first just woken by the racer passing and the second still parked", () => {
  it("when the racer stops racing and no chaser is near another racer so the pack stands down, then the parked cop nobody sees is put away at once and never pulls out onto the road", () => {
    const r = rig();
    // Its quarry stops racing and no chaser is near another racer: the pack stands down.
    r.hunt[0] = 0;
    r.beat();
    assert.deepEqual(r.stored, [2]);
    assert.equal(r.police.think(r.cars[2]!, r.cars, BEAT).throttle, 0, "unit 2 still drives");
  });

  it("when the racer stops racing while the camera sees the parked cop, then it is not put away in view and is put away once nobody sees it", () => {
    const r = rig();
    r.hunt[0] = 0;
    r.view.seen = true;
    r.beat();
    assert.ok(!r.stored.includes(2), "nothing vanishes in view");
    r.view.seen = false;
    r.beat();
    assert.ok(r.stored.includes(2), "gone once unseen");
  });
});

describe("given a stakeout of two cops parked ahead of a racer on the road", () => {
  it("when a racer 60 m off the road across the field has its nearest road point past the second cop's spot, then only the first cop wakes, and when the racer passes on the road itself, then both wake", () => {
    const r = rig();
    const spot = r.cars[2]!;
    const s2 = track.project(spot.x, spot.z, -1, blankProjection()).s;
    // A point `off` m to the side of the road 5 m past unit 2's spot (the side whose nearest road point is still that stretch).
    const at = (off: number) => {
      const p = track.pointAt(s2 + 5, pt);
      for (const side of [1, -1]) {
        const x = p.x + p.tz * side * off;
        const z = p.z - p.tx * side * off;
        const on = track.project(x, z, -1, blankProjection());
        if (Math.abs(on.s - (s2 + 5)) < 10) return { x, z };
      }
      throw new Error("no side of the road keeps its nearest point there");
    };
    const racerAt = (off: number) => {
      Object.assign(r.cars[0]!, at(off));
      r.beat();
      r.beat();
      return r.police.chasers(r.cars, []).map((c) => c.id);
    };
    assert.deepEqual(racerAt(60), [1], "unit 2 woke for a racer 60 m off the road");
    // Control: the same pass on the road itself wakes it.
    assert.deepEqual(racerAt(0), [1, 2], "the rig's pass never wakes unit 2: the test proves nothing");
  });
});

describe("given a pack-mate guard (the check that keeps a cop from driving into a cop of its own pack) on a cop driving 27 m/s along +z, steering 0.2 and at full throttle", () => {
  /** Unit 1 at the origin doing 27 m/s along +z, steering 0.2; the mate by default dead ahead, 40 m on, facing it (a hit in 1.1 s). */
  const meet = (pullsOut: (unit: number) => boolean, mate = { x: 0, z: 40, yaw: Math.PI }) => {
    const cars: AiCar[] = [0, 1, 2].map(blankAiCar);
    Object.assign(cars[1]!, { x: 0, z: 0, vx: 0, vz: 27, yaw: 0 });
    Object.assign(cars[2]!, { ...mate, vx: 0, vz: 0 });
    const out = { ...idleDrive(), throttle: 1, steer: 0.2 };
    guardMates(cars[1]!, cars, 1, 2, out, pullsOut);
    return out;
  };

  it("when a mate 40 m dead ahead is facing it and has only just woken (stopped, but it pulls out), then the cop steers away and cuts its throttle for the head-on hit about 1.1 s away", () => {
    const out = meet(() => true);
    assert.ok(out.steer < 0.2, `steer ${out.steer} not bent away from the mate`);
    assert.ok(out.throttle < 1, "no braking for a head-on in 1.1 s");
  });

  it("when a mate beside the path with its nose across it cannot pull out (parked at its stakeout, stored, knocked out), then it is read as stopped and the steer is left alone, but the same mate pulling out is steered away from", () => {
    // 8 m to the left, nose across the path: pulling out at 8 m/s it would be hit in 1.1 s; parked it is 8 m off.
    const mate = { x: -8, z: 30, yaw: Math.PI / 2 };
    assert.equal(meet(() => false, mate).steer, 0.2);
    assert.notEqual(meet(() => true, mate).steer, 0.2, "the geometry never makes a pulling-out mate a threat: the test proves nothing");
  });

  it("when a parked mate stands 40 m ahead on the path, then the cop steers round it and cuts its throttle", () => {
    const out = meet(() => false);
    assert.ok(out.steer < 0.2, `steer ${out.steer} not bent away from the parked mate`);
    assert.ok(out.throttle < 1, "no braking for a parked car dead ahead in 1.5 s");
  });

  it("when a mate stands 14 m ahead in its path and the cop is itself braking at 20 m/s, then it steers round and brakes harder, but a stopped cop and a reversing one are left alone and the same cop on the throttle is steered round", () => {
    const through = (throttle: number, brake: number, vz: number) => {
      const cars: AiCar[] = [0, 1, 2].map(blankAiCar);
      Object.assign(cars[1]!, { x: 0, z: 0, vx: 0, vz, yaw: 0 });
      Object.assign(cars[2]!, { x: 0, z: 14, vx: 0, vz: 0, yaw: Math.PI });
      const out = { ...idleDrive(), throttle, brake, steer: 0.2 };
      guardMates(cars[1]!, cars, 1, 2, out, () => false);
      return out;
    };
    const braking = through(0, 0.5, 20);
    assert.ok(braking.steer < 0.2 && braking.brake > 0.5, `a braking car at 20 m/s was left to hit a stopped mate 14 m ahead: steer ${braking.steer}, brake ${braking.brake}`);
    // Controls: a stopped car and a reversing one are left alone, and the same car on the throttle is read.
    const stopped = through(0, 1, 0);
    assert.ok(stopped.steer === 0.2 && stopped.brake === 1, "a stopped car was steered or braked by the guard");
    assert.equal(through(-1, 0, 20).steer, 0.2, "a reversing car was steered");
    assert.ok(through(1, 0, 20).steer < 0.2, "the geometry never makes the guard act on a car on the throttle: the test proves nothing");
  });

  it("when a mate passing alongside would be reached sooner (a graze 0.2 s away) and a just-woken mate is 6 m ahead with its nose at the cop (a hit 0.35 s away), then the cop still brakes for the one it would hit", () => {
    const cars: AiCar[] = [0, 1, 2, 3].map(blankAiCar);
    // Unit 1 doing 9 m/s along +z. Unit 2 overtaking 5 m to its left, a little behind, closest in 0.2 s at 5.0 m (a graze); unit 3 just woken, 6 m ahead and 3 m to its right, nose at it (a hit in 0.35 s).
    Object.assign(cars[1]!, { x: 0, z: 0, vx: 0, vz: 9, yaw: 0 });
    Object.assign(cars[2]!, { x: -5, z: -3, vx: 0, vz: 25, yaw: 0 });
    Object.assign(cars[3]!, { x: 3, z: 6, vx: 0, vz: 0, yaw: Math.PI });
    const out = { ...idleDrive(), throttle: 1, steer: 0 };
    guardMates(cars[1]!, cars, 1, 3, out, () => true);
    assert.ok(out.brake > 0.5, `brake ${out.brake}: the mate 0.35 s ahead was not braked for`);
  });

  it("when a pulling-out mate is dead ahead, then the cop lifts off the throttle without braking and drops its boost, but for a mate passing 5 m off (a graze) it lifts off the throttle and keeps its boost", () => {
    const boosting = (x: number) => {
      const cars: AiCar[] = [0, 1, 2].map(blankAiCar);
      Object.assign(cars[1]!, { x: 0, z: 0, vx: 0, vz: 27, yaw: 0 });
      Object.assign(cars[2]!, { x, z: 40, vx: 0, vz: 0, yaw: Math.PI });
      const out = { ...idleDrive(), throttle: 1, steer: 0.2, boost: true };
      guardMates(cars[1]!, cars, 1, 2, out, () => true);
      return out;
    };
    const hit = boosting(0);
    assert.ok(hit.throttle < 1 && hit.brake === 0, "the geometry never makes the guard lift the throttle short of the brake: the test proves nothing");
    assert.equal(hit.boost, false);
    const graze = boosting(5);
    assert.ok(graze.throttle < 1, "the geometry never makes the guard act on the graze: the test proves nothing");
    assert.equal(graze.boost, true);
  });

  it("when the cop at 50 m/s is steering full lock that swings it 30 m clear of a parked mate far ahead, then the guard does not cancel that steer, but it steers round a mate when the cop holds straight on or when a mate 15 m ahead leaves no room to swing clear in time", () => {
    const yaw = 0.2;
    const v = 50;
    // A parked mate `ahead` m along the car's line and 4.5 m off it, to the side a positive steer turns toward.
    const through = (steer: number, ahead: number) => {
      const cars: AiCar[] = [0, 1, 2].map(blankAiCar);
      Object.assign(cars[1]!, { x: 0, z: 0, vx: Math.sin(yaw) * v, vz: Math.cos(yaw) * v, yaw });
      Object.assign(cars[2]!, { x: Math.sin(yaw) * ahead + Math.cos(yaw) * 4.5, z: Math.cos(yaw) * ahead - Math.sin(yaw) * 4.5, yaw: yaw + Math.PI });
      const out = { ...idleDrive(), throttle: 1, steer };
      guardMates(cars[1]!, cars, 1, 2, out, () => false);
      return out;
    };
    assert.equal(through(1, 90).steer, 1, "the guard bent a full-lock steer that swings the car 30 m clear of the mate by the time it gets there");
    // Controls: the same mate against a car holding straight on, and against the same steer with no room to use it, is steered round.
    assert.ok(through(0, 90).steer < -0.5, "the geometry never makes the guard act on a car holding straight on: the test proves nothing");
    assert.ok(through(1, 15).steer < 0.5, "the guard let a car steer into a mate 0.3 s ahead on the strength of a swing that cannot clear it in time");
  });

  it("when a pack-mate dead ahead is still parked, then the cop's steer is exactly what it is with no mate there, and once that mate is knocked into motion and wakes the guard changes the steer", () => {
    const r = rig();
    const me = r.cars[1]!;
    const ahead = { x: me.x + Math.sin(me.yaw) * 40, z: me.z + Math.cos(me.yaw) * 40, yaw: me.yaw + Math.PI };
    // dt 0: the lead-in's own timer (and so its aim blend) does not move between the reads.
    const steer = (): number => r.police.think(me, r.cars, 0).steer;
    Object.assign(r.cars[2]!, { x: 4000, z: 4000 });
    const alone = steer();
    Object.assign(r.cars[2]!, ahead);
    assert.equal(steer(), alone, "a parked mate bent the lead-in's steering");
    // Control: the same mate, knocked into motion, wakes (state pursuit) and the guard does read it.
    Object.assign(r.cars[2]!, { vx: 5 });
    r.beat();
    assert.notEqual(steer(), alone, "the rig's geometry never makes the guard act: the test proves nothing");
  });
});

describe("given two packs of cops, each with a parked stakeout, and a racer passing both in one beat", () => {
  it("when both packs call a reinforcement in the same beat, then they park more than 10 m apart", () => {
    let doubled = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const cars: AiCar[] = Array.from({ length: 7 }, (_, i) => blankAiCar(i));
      const hunt = new Uint8Array(7);
      hunt[0] = 1;
      // The engine's `park` moves the car; the snapshot `cars` holds is only refreshed after the beat.
      const placed: { id: number; x: number; z: number }[] = [];
      const everPlaced = new Map<number, { x: number; z: number }>();
      const world: PoliceWorld = {
        park: (id, x, _y, z) => placed.push({ id, x, z }),
        store: () => {},
        seen: () => false,
        down: () => false,
        sirens: () => {},
      };
      const police = new PoliceBrain(track, new RaceBrain(track, 1), 1, 6, seed);
      const lead = track.length * 0.4;
      let time = 0;
      const beat = () => {
        police.update(time, BEAT, cars, hunt, lead, world);
        time += BEAT;
      };
      const refresh = () => {
        for (const p of placed) {
          Object.assign(cars[p.id]!, p);
          everPlaced.set(p.id, p);
        }
        placed.length = 0;
      };
      const start = track.pointAt(lead, pt);
      Object.assign(cars[0]!, { x: start.x, z: start.z });
      // Two stakeouts parked, the second one a beat after the first stored its dice.
      for (let n = 0; n < 100 && everPlaced.size < 4; n++) {
        beat();
        refresh();
      }
      assert.equal(everPlaced.size, 4, `seed ${seed}: two stakeouts parked`);
      // One racer passes both packs' first spots in one beat (so both wake, and both call their reinforcement in the same beat 5 s on);
      // stakeouts further apart than a pass covers are skipped.
      const arcs = [...everPlaced.values()].map((p) => track.project(p.x, p.z, -1, blankProjection()).s);
      const pack0 = Math.min(arcs[0]!, arcs[1]!);
      const pack1 = Math.min(arcs[2]!, arcs[3]!);
      if (Math.abs(pack0 - pack1) > 20) continue;
      const at = track.pointAt(Math.max(pack0, pack1) + 3, pt);
      Object.assign(cars[0]!, { x: at.x, z: at.z });
      for (let n = 0; n < 60; n++) {
        beat();
        if (placed.length > 1) {
          doubled++;
          const [a, b] = placed;
          assert.ok(Math.hypot(a!.x - b!.x, a!.z - b!.z) > 10, `seed ${seed}: two reinforcements parked ${Math.hypot(a!.x - b!.x, a!.z - b!.z).toFixed(1)} m apart in one beat`);
        }
        refresh();
      }
    }
    assert.ok(doubled >= 2, `only ${doubled} beats called two reinforcements: the test proves nothing`);
  });
});
