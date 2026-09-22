import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { thinkDerby, engineDamage } from "./derby-ai.ts";
import { DerbyMatch, HIT_POINTS, DISABLE_POINTS, HIT_DEBOUNCE } from "./derby.ts";
import { clipToDerbyBowl, DERBY_RADIUS } from "./derby-arena.ts";
import { idleDrive, DriverSeat } from "./car-drive.ts";
import { layoutDerby, MAX_CARS } from "./fleet.ts";

function car(id: number, extra: Partial<Parameters<typeof thinkDerby>[0]> = {}) {
  return {
    id,
    x: 0,
    z: 0,
    yaw: 0,
    vx: 0,
    vz: 8,
    alive: true,
    damage: 0,
    ...extra,
  };
}

describe("derby AI", () => {
  it("good: healthier car will take a head-on", () => {
    const me = car(0, { damage: 0.1, z: -8, yaw: 0 });
    const foe = car(1, { damage: 0.8, z: 8 });
    const input = thinkDerby(me, [me, foe], { radius: DERBY_RADIUS, time: 1 });
    assert.ok(input.throttle > 0.5, `wanted chase throttle, got ${input.throttle}`);
    assert.equal(input.ebrake, false);
  });

  it("good: a more-damaged car reverses instead of donating the block", () => {
    const me = car(0, { damage: 0.7, z: 0, yaw: 0 });
    const foe = car(1, { damage: 0.1, z: 5 });
    const input = thinkDerby(me, [me, foe], { radius: DERBY_RADIUS, time: 1 });
    assert.ok(input.throttle < 0, `wanted reverse, got ${input.throttle}`);
  });

  it("good: near the wall we steer inward, not into the concrete", () => {
    const me = car(0, { x: 0, z: DERBY_RADIUS - 1.2, yaw: 0, damage: 0 });
    const foe = car(1, { x: 4, z: 0 });
    const input = thinkDerby(me, [me, foe], { radius: DERBY_RADIUS, time: 1 });
    assert.ok(input.steer !== 0 || input.throttle < 0.6);
  });
});

describe("derby scoring", () => {
  it("good: hits debounce so buckle chatter is one point", () => {
    const m = new DerbyMatch();
    m.begin([
      { id: 0, name: "Titanium" },
      { id: 1, name: "Petrol" },
    ]);
    assert.equal(m.noteHit(0, 1, 8, 2, 6), true);
    assert.equal(m.noteHit(0, 1, 8, 2, 6), false);
    m.time = HIT_DEBOUNCE + 0.05;
    assert.equal(m.noteHit(0, 1, 8, 2, 6), true);
    assert.equal(m.row(0)!.score, HIT_POINTS * 2);
    assert.equal(m.row(0)!.hits, 2);
  });

  it("good: disabling is 10 on top of the last hit, last survivor wins regardless of points", () => {
    const m = new DerbyMatch();
    m.begin([
      { id: 0, name: "Titanium" },
      { id: 1, name: "Petrol" },
    ]);
    m.noteHit(1, 0, 9, 1, 10);
    for (let i = 0; i < 6; i++) {
      m.time += HIT_DEBOUNCE + 0.05;
      m.noteHit(1, 0, 9, 1, 8);
    }
    assert.ok(m.row(1)!.score > 4);
    m.step(0.05, [
      { id: 0, name: "Titanium", alive: false },
      { id: 1, name: "Petrol", alive: true },
    ]);
    assert.equal(m.row(1)!.disables, 1);
    assert.equal(m.row(1)!.score, 7 * HIT_POINTS + DISABLE_POINTS);
    assert.equal(m.winnerId, 1);
    assert.equal(m.winnerName, "Petrol");
  });

  it("good: a dead car with more points still loses to the survivor", () => {
    const m = new DerbyMatch();
    m.begin([
      { id: 0, name: "Oxide" },
      { id: 1, name: "Ink" },
    ]);
    for (let i = 0; i < 8; i++) {
      m.time += HIT_DEBOUNCE + 0.02;
      m.noteHit(0, 1, 10, 0, 9);
    }
    m.step(0.02, [
      { id: 0, name: "Oxide", alive: false },
      { id: 1, name: "Ink", alive: true },
    ]);
    assert.equal(m.winnerId, 1);
    assert.ok(m.row(0)!.score > m.row(1)!.score);
  });
});

describe("derby arena", () => {
  it("good: outside the bowl is pushed back and loses outward speed", () => {
    const hit = clipToDerbyBowl(0, DERBY_RADIUS + 2, 0, 12);
    assert.equal(hit.hit, true);
    assert.ok(Math.hypot(hit.x, hit.z) < DERBY_RADIUS - 1);
    assert.ok(hit.vz < 12);
  });
});

describe("derby layout", () => {
  it("good: N cars sit on a ring, tangent, inside the bowl", () => {
    const slots = layoutDerby(6, DERBY_RADIUS, 12, () => 0.5);
    assert.equal(slots.length, 6);
    assert.ok(slots.length <= MAX_CARS);
    for (const s of slots) {
      assert.ok(Math.hypot(s.x, s.z) < DERBY_RADIUS - 3);
    }
  });
});

describe("engine damage helper", () => {
  it("good: dead drivetrain is 1, mint leftover is ~0", () => {
    assert.equal(engineDamage(false, 0), 1);
    assert.ok(engineDamage(true, 1.5) < 0.05);
  });
});

describe("drive input", () => {
  it("good: idle is zeros", () => {
    const d = idleDrive();
    assert.equal(d.throttle, 0);
    assert.equal(d.ebrake, false);
    assert.equal(d.boost, false);
  });
});

describe("driver seat", () => {
  it("good: click follows, WASD drives, esc steps back", () => {
    const s = new DriverSeat();
    s.focus(1);
    assert.equal(s.mode, "follow");
    s.poke(new Set(["KeyW", "ShiftLeft"]));
    assert.equal(s.mode, "drive");
    const input = s.input(new Set(["KeyW", "ShiftLeft"]));
    assert.equal(input.throttle, 1);
    assert.equal(input.boost, true);
    s.esc();
    assert.equal(s.mode, "follow");
    s.esc();
    assert.equal(s.mode, "global");
    assert.equal(s.carIndex, -1);
  });

  it("good: boost drains while held and refills on a takedown", () => {
    const s = new DriverSeat();
    s.focus(0);
    s.poke(new Set(["ShiftLeft"]));
    s.mode = "drive";
    s.step(0.8);
    assert.ok(s.boost < 0.6, `boost ${s.boost}`);
    s.addBoost(0.4);
    assert.ok(s.boost > 0.7);
  });

  it("good: look yaw collapses back toward the velocity heading", () => {
    const s = new DriverSeat();
    s.nudgeLook(80, 0);
    assert.ok(Math.abs(s.camYaw) > 0.2);
    s.mouseIdle = 1;
    s.step(0.5);
    const mid = Math.abs(s.camYaw);
    s.step(0.8);
    assert.ok(Math.abs(s.camYaw) < mid);
  });
});
