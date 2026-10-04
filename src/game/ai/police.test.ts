import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { blankAiCar, type AiCar } from "./derby-ai.ts";
import { PoliceBrain, type PoliceWorld } from "./police.ts";
import { RaceBrain } from "./race-ai.ts";
import { blankPoint, blankProjection, Track } from "../world/track.ts";
import oval from "../world/tracks/oval.json" with { type: "json" };

const track = new Track(oval);
const BEAT = 0.25;
const pt = blankPoint();

/** One racer (car 0) and a stakeout of two units (cars 1 and 2) parked ahead of it; whether the camera `seen` them is the test's to set. */
function rig() {
  const cars: AiCar[] = [0, 1, 2].map(blankAiCar);
  const hunt = new Uint8Array(cars.length);
  hunt[0] = 1;
  const stored: number[] = [];
  const spots: { x: number; z: number }[] = [];
  const view = { seen: false };
  const world: PoliceWorld = {
    park: (id, x, _y, z) => {
      spots[id] = { x, z };
      Object.assign(cars[id]!, { x, z, vx: 0, vz: 0 });
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
  // The racer passes unit 1 only: it wakes and chases, unit 2 (12 m further on) stays parked.
  sit(5);
  beat();
  assert.deepEqual(police.chasers(cars, []).map((c) => c.id), [1], "unit 1 chases");
  assert.equal(stored.length, 0);
  // Its quarry stops racing and no chaser is near another racer: the pack stands down.
  hunt[0] = 0;
  return { police, cars, stored, view, beat };
}

describe("police: a pack stands down while a unit of it is still parked", () => {
  it("the parked unit nobody sees is put away at once: it never pulls out onto the road with no racer past its spot", () => {
    const r = rig();
    r.beat();
    assert.deepEqual(r.stored, [2]);
    assert.equal(r.police.think(r.cars[2]!, r.cars, BEAT).throttle, 0, "unit 2 still drives");
  });

  it("the parked unit the camera sees drives off like a chaser giving up, and is put away once nobody sees it go", () => {
    const r = rig();
    r.view.seen = true;
    r.beat();
    assert.ok(!r.stored.includes(2), "nothing vanishes in view");
    r.view.seen = false;
    r.beat();
    assert.ok(r.stored.includes(2), "gone once unseen");
  });
});
