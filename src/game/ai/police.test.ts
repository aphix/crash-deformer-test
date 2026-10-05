import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { blankAiCar, type AiCar } from "./derby-ai.ts";
import { guardMates } from "./pack-guard.ts";
import { PoliceBrain, type PoliceWorld } from "./police.ts";
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

describe("police: a pack stands down while a unit of it is still parked", () => {
  it("the parked unit nobody sees is put away at once: it never pulls out onto the road with no racer past its spot", () => {
    const r = rig();
    // Its quarry stops racing and no chaser is near another racer: the pack stands down.
    r.hunt[0] = 0;
    r.beat();
    assert.deepEqual(r.stored, [2]);
    assert.equal(r.police.think(r.cars[2]!, r.cars, BEAT).throttle, 0, "unit 2 still drives");
  });

  it("the parked unit the camera sees drives off like a chaser giving up, and is put away once nobody sees it go", () => {
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

describe("police: the pack-mate guard", () => {
  /** Unit 1 at the origin doing 27 m/s along +z, steering 0.2; the mate dead ahead, 40 m on, facing it (a hit in 1.1 s). */
  const meet = (driving: (unit: number) => boolean) => {
    const cars: AiCar[] = [0, 1, 2].map(blankAiCar);
    Object.assign(cars[1]!, { x: 0, z: 0, vx: 0, vz: 27, yaw: 0 });
    Object.assign(cars[2]!, { x: 0, z: 40, vx: 0, vz: 0, yaw: Math.PI });
    const out = { ...idleDrive(), throttle: 1, steer: 0.2 };
    guardMates(cars[1]!, cars, 1, 2, out, driving);
    return out;
  };

  it("steers away from a mate that is driving at it, even one that has only just woken (stopped, but it pulls out)", () => {
    const out = meet(() => true);
    assert.ok(out.steer < 0.2, `steer ${out.steer} not bent away from the mate`);
    assert.ok(out.throttle < 1, "no braking for a head-on in 1.1 s");
  });

  it("leaves a mate that is not driving (still parked at its stakeout, stored, knocked out) alone: it does not pull out", () => {
    const out = meet(() => false);
    assert.equal(out.steer, 0.2);
    assert.equal(out.throttle, 1);
  });

  it("a lead-in's steer is the drive's own while a pack-mate dead ahead is still parked: the mate is no phantom driver, a woken one is", () => {
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
