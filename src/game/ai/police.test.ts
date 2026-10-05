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
  /** Unit 1 at the origin doing 27 m/s along +z, steering 0.2; the mate by default dead ahead, 40 m on, facing it (a hit in 1.1 s). */
  const meet = (pullsOut: (unit: number) => boolean, mate = { x: 0, z: 40, yaw: Math.PI }) => {
    const cars: AiCar[] = [0, 1, 2].map(blankAiCar);
    Object.assign(cars[1]!, { x: 0, z: 0, vx: 0, vz: 27, yaw: 0 });
    Object.assign(cars[2]!, { ...mate, vx: 0, vz: 0 });
    const out = { ...idleDrive(), throttle: 1, steer: 0.2 };
    guardMates(cars[1]!, cars, 1, 2, out, pullsOut);
    return out;
  };

  it("steers away from a mate that is driving at it, even one that has only just woken (stopped, but it pulls out)", () => {
    const out = meet(() => true);
    assert.ok(out.steer < 0.2, `steer ${out.steer} not bent away from the mate`);
    assert.ok(out.throttle < 1, "no braking for a head-on in 1.1 s");
  });

  it("reads a mate that cannot pull out (parked at its stakeout, stored, knocked out) as stopped, not as a phantom car at 8 m/s: one beside the path is left alone", () => {
    // 8 m to the left, nose across the path: pulling out at 8 m/s it would be hit in 1.1 s; parked it is 8 m off.
    const mate = { x: -8, z: 30, yaw: Math.PI / 2 };
    assert.equal(meet(() => false, mate).steer, 0.2);
    assert.notEqual(meet(() => true, mate).steer, 0.2, "the geometry never makes a pulling-out mate a threat: the test proves nothing");
  });

  it("steers round and brakes for a parked mate on the path (a lead-in drove into one 12 m ahead at 16 m/s: it was not read at all)", () => {
    const out = meet(() => false);
    assert.ok(out.steer < 0.2, `steer ${out.steer} not bent away from the parked mate`);
    assert.ok(out.throttle < 1, "no braking for a parked car dead ahead in 1.5 s");
  });

  it("brakes for a mate in its path even when another mate passing alongside would be reached sooner (the lead-in steered away from the one and drove into the other at 18 m/s)", () => {
    const cars: AiCar[] = [0, 1, 2, 3].map(blankAiCar);
    // Unit 1 doing 9 m/s along +z. Unit 2 overtaking 5 m to its left, a little behind, closest in 0.2 s at 5.0 m (a graze); unit 3 just woken, 6 m ahead and 3 m to its right, nose at it (a hit in 0.35 s).
    Object.assign(cars[1]!, { x: 0, z: 0, vx: 0, vz: 9, yaw: 0 });
    Object.assign(cars[2]!, { x: -5, z: -3, vx: 0, vz: 25, yaw: 0 });
    Object.assign(cars[3]!, { x: 3, z: 6, vx: 0, vz: 0, yaw: Math.PI });
    const out = { ...idleDrive(), throttle: 1, steer: 0 };
    guardMates(cars[1]!, cars, 1, 3, out, () => true);
    assert.ok(out.brake > 0.5, `brake ${out.brake}: the mate 0.35 s ahead was not braked for`);
  });

  it("lets go of the boost for a predicted hit, not for a graze (a boosting lead-in pair kept pulling into each other on a lifted throttle; a pack queued in rows lost its boost for every mate passing a few metres off)", () => {
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

describe("police: reinforcements", () => {
  it("two packs that call a reinforcement in the same beat park them apart: the beat's own parkings are in the clearance check (they stacked on one spot, then drove off into each other)", () => {
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
