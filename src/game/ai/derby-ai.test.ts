import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DerbyBrain, DERBY_RULES, type AiCar } from "./derby-ai.ts";
import { DerbyMatch } from "../match/derby.ts";
import { DERBY_RADIUS } from "../scenes/derby-arena.ts";
import { DerbyGround, DERBY_FREE_PROPS } from "../scenes/derby-ground.ts";
import { layoutDerby, type DerbySlot } from "../scenes/fleet.ts";
import { CAR_HALF } from "../vehicle/car-mesh.ts";
import { aiCar as car, decide } from "../vehicle/test-support.ts";

describe("given an AI derby driver and a rival car close beside or ahead of it", () => {
  it("when a rival's nose sits 1.8 m to its left, level with its rear wheel and pointing at its side, then the driver handbrakes into a swing that whips its tail into that nose", () => {
    const brain = new DerbyBrain();
    const me = car(0, { vz: 9 });
    // Its nose (1.7 m ahead of it) sits 1.8 m left of us, level with our rear wheel, pointing at our side.
    const foe = car(1, { x: 3.5, z: -1.8, yaw: -Math.PI / 2, vz: 0 });
    const input = decide(brain, me, [me, foe]);
    assert.equal(brain.tacticOf(0), "swing");
    // Steering right swings the tail left, into it.
    assert.ok(input.ebrake && input.throttle === 0 && input.steer < -0.5, JSON.stringify(input));
  });

  it("when an oncoming car passes 2.6 m to its left, then the driver sideswipes it, steering right with the throttle on, but does not when the car shows its driver's door instead", () => {
    const brain = new DerbyBrain();
    const me = car(0, { vz: 9 });
    // Oncoming, 2.6 m to our left: we pass its passenger side.
    const passenger = car(1, { x: 2.6, z: 1, yaw: Math.PI, vz: -8 });
    const input = decide(brain, me, [me, passenger]);
    assert.equal(brain.tacticOf(0), "sideswipe");
    assert.ok(input.steer > 0.3 && input.throttle > 0.5, JSON.stringify(input));
    // Mirror it: now its driver's door (the steering-wheel side) is the side we'd rub.
    const doorBrain = new DerbyBrain();
    const driverSide = car(1, { x: -2.6, z: 1, yaw: Math.PI, vz: -8 });
    decide(doorBrain, me, [me, driverSide]);
    assert.notEqual(doorBrain.tacticOf(0), "sideswipe");
  });

  it("when the driver backs toward a car parked broadside 16 m off, then it reverses and steers its tail toward that car's nose, turning harder when the car shows its driver's side so the tail aims at the bumper corner clear of the door", () => {
    // Tail toward a car parked broadside 16 m off; once its driver's side faces us, once its passenger side.
    const me = car(0, { z: -16, yaw: Math.PI, vz: 0 });
    const doorSide = decide(new DerbyBrain(), me, [me, car(1, { yaw: -Math.PI / 2, vz: 0 })]);
    const passengerSide = decide(new DerbyBrain(), me, [me, car(1, { yaw: Math.PI / 2, vz: 0 })]);
    assert.ok(doorSide.throttle < 0 && passengerSide.throttle < 0, "not backing in");
    // Each steers the tail toward that car's nose; the door side has further to go.
    assert.ok(doorSide.steer < 0 && passengerSide.steer > 0, `${doorSide.steer} / ${passengerSide.steer}`);
    assert.ok(-doorSide.steer > passengerSide.steer + 0.02, `door side ${doorSide.steer.toFixed(2)} vs ${passengerSide.steer.toFixed(2)}`);
  });
});

describe("given derby drivers on the shared aggression slider, a parked rival 8 m behind the driver's tail and two more across the bowl", () => {
  /** A parked car 8 m behind us (tail toward it), two more across the bowl. */
  function field(me: Partial<AiCar>, target: Partial<AiCar> = {}, rivalsAlive = true): AiCar[] {
    return [
      car(0, { vz: 0, ...me }),
      car(1, { z: -8, vz: 0, ...target }),
      car(2, { x: 12, z: 6, vz: 0, alive: rivalsAlive }),
      car(3, { x: -12, z: 6, vz: 0, alive: rivalsAlive }),
    ];
  }
  function tactic(a: number, me: Partial<AiCar>, target: Partial<AiCar> = {}, rivalsAlive = true): string {
    const brain = new DerbyBrain();
    brain.setAggression(0, a);
    const cars = field(me, target, rivalsAlive);
    decide(brain, cars[0]!, cars);
    return brain.tacticOf(0);
  }

  it("when aggression is 0 and the hit clock (time since its last aggressive hit) is long past, then it keeps clear of every hit", () => {
    assert.equal(tactic(0, { idle: 1000 }), "layback");
  });

  it("when aggression is 0.5, then it keeps clear of an equal car, hits a more wrecked one, and hits anyway when its hit clock runs low", () => {
    assert.equal(tactic(0.5, {}), "layback");
    assert.notEqual(tactic(0.5, {}, { front: 0.6, damage: 0.6 }), "layback");
    assert.notEqual(tactic(0.5, { idle: DERBY_RULES.hitClock * 0.62 }), "layback");
  });

  it("when aggression is full and the driver is itself badly damaged, then it still goes in for a hit", () => {
    assert.notEqual(tactic(1, { front: 0.8, damage: 0.8 }), "layback");
  });

  it("when only one rival is left alive at aggression 0.3, then the driver goes in for a hit instead of waiting for the others to soften it up", () => {
    assert.notEqual(tactic(0.3, {}, {}, false), "layback");
  });
});

describe("given a derby whose rules count a car out after 60 s without an aggressive hit or 60 s without moving", () => {
  const names = [0, 1, 2, 3].map((id) => ({ id, name: `c${id}` }));

  it("when two cars land 5 m/s hits and two others never do (one only leans on a rival at 1 m/s), then just after 60 s the two that never hit are counted out, no winner is named, and a counted-out car stops driving and is nobody's target", () => {
    const m = new DerbyMatch();
    m.begin(names, { seed: 1 });
    const step = () => m.step(0.1, [0, 1, 2, 3].map((id) => ({ id, name: `c${id}`, alive: true, x: m.time * 3 + id * 10, z: 0 })));
    while (m.time < 50) step();
    assert.equal(m.noteHit(0, 1, 5, 0, 6), true, "car 0 rams car 1 at 5 m/s");
    assert.equal(m.noteHit(3, 2, 5, 0, 6), true, "car 3 rams car 2 at 5 m/s");
    assert.equal(m.noteHit(2, 1, 1, 0, 6), true, "car 2 leans on car 1 at 1 m/s");
    while (m.time < DERBY_RULES.hitClock - 0.2) step();
    assert.deepEqual(m.board.map((r) => r.out), [false, false, false, false]);
    while (m.time < DERBY_RULES.hitClock + 0.2) step();
    assert.deepEqual(m.board.map((r) => r.out), [false, true, true, false]);
    assert.equal(m.winnerId, null);
    // Counted out: no more input of its own, and no longer a target for anyone.
    const snaps = [car(0, { z: -6 }), car(1, { vz: 0 }), car(2, { x: 1, vz: 0 }), car(3, { x: 14, z: 14, vz: 0 })];
    const idle = m.think(snaps[1]!, snaps, 0.1);
    assert.ok(idle.throttle === 0 && idle.steer === 0, "a counted-out car still drives");
    m.think(snaps[0]!, snaps, 0.1);
    assert.deepEqual([m.brain.huntersOf(1), m.brain.huntersOf(2), m.brain.huntersOf(3)], [0, 0, 1]);
  });

  it("when one car rocks in place without getting 2 m from where it stopped while another drives about, then the rocking car is counted out when the still clock runs out and the driving car wins", () => {
    const m = new DerbyMatch();
    m.begin(names.slice(0, 2), { seed: 1, hitClock: Infinity });
    // Car 1 rocks in place (a wedge), car 0 drives about.
    while (m.time < DERBY_RULES.stillClock + 0.2) {
      m.step(0.1, [
        { id: 0, name: "c0", alive: true, x: m.time * 3, z: 0 },
        { id: 1, name: "c1", alive: true, x: Math.sin(m.time * 4), z: 20 },
      ]);
    }
    assert.equal(m.row(1)!.out, true);
    assert.equal(m.winnerId, 0);
  });

  it("when the time limit arrives, then the top scorer among the cars still running is crowned and the win is marked as decided on points", () => {
    const m = new DerbyMatch();
    m.begin(names, { seed: 1, timeLimit: 10, hitClock: Infinity });
    m.noteHit(2, 0, 5, 0, 6);
    while (m.winnerId == null) m.step(0.1, [0, 1, 2].map((id) => ({ id, name: `c${id}`, alive: true, x: m.time * 3, z: id })));
    assert.equal(m.winnerId, 2);
    assert.equal(m.decided, "time");
  });
});

/** Two oriented car hulls (CAR_HALF boxes) overlap: separating-axis test on the four edge normals. */
function hullsOverlap(a: DerbySlot, b: DerbySlot): boolean {
  const axes = [a.yaw, a.yaw + Math.PI / 2, b.yaw, b.yaw + Math.PI / 2];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const reach = (yaw: number, ax: number, az: number) =>
    CAR_HALF.z * Math.abs(Math.sin(yaw) * ax + Math.cos(yaw) * az) + CAR_HALF.x * Math.abs(Math.cos(yaw) * ax - Math.sin(yaw) * az);
  for (const t of axes) {
    const ax = Math.sin(t);
    const az = Math.cos(t);
    if (Math.abs(dx * ax + dz * az) > reach(a.yaw, ax, az) + reach(b.yaw, ax, az)) return false;
  }
  return true;
}

describe("given derby fields of 2 to 32 cars laid out in the one fixed arena", () => {
  it("when each field is laid out, then it has one slot per car, every spawn is inside the wall with the car's half length to spare, no two spawn hulls overlap and every spawn stands on flat floor", () => {
    const ground = new DerbyGround();
    for (let n = 2; n <= 32; n++) {
    const slots = layoutDerby(n, DERBY_RADIUS, () => 0.37, DERBY_FREE_PROPS);
      assert.equal(slots.length, n);
      for (let i = 0; i < n; i++) {
        const s = slots[i]!;
        assert.ok(Math.hypot(s.x, s.z) + CAR_HALF.z < DERBY_RADIUS, `${n} cars: car ${i} spawns in the wall`);
        for (const lengthSide of [-1, 1]) {
          for (const widthSide of [-1, 1]) {
            const cornerX = s.x + lengthSide * CAR_HALF.z * Math.sin(s.yaw) + widthSide * CAR_HALF.x * Math.cos(s.yaw);
            const cornerZ = s.z + lengthSide * CAR_HALF.z * Math.cos(s.yaw) - widthSide * CAR_HALF.x * Math.sin(s.yaw);
            assert.equal(ground.heightAt(cornerX, cornerZ), 0, `${n} cars: car ${i} spawns on a rise`);
          }
        }
        for (let j = i + 1; j < n; j++) assert.ok(!hullsOverlap(s, slots[j]!), `${n} cars: ${i} and ${j} spawn on top of each other`);
      }
    }
  });
});
