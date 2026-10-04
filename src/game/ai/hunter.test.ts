import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { idleDrive } from "../vehicle/car-drive.ts";
import { blankAiCar, type AiCar } from "./derby-ai.ts";
import { copsWanted, HUNT, HunterBrain } from "./hunter.ts";
import { ATTACK, attackTarget, type HunterWorld } from "./police.ts";
import type { PropCollider } from "../world/placements.ts";
import { blankProjection, projectPath, Track } from "../world/track.ts";
import { HAVANA } from "../world/tracks/havana.ts";

const track = new Track(HAVANA);
const spec = track.survival!;
const FAR = 4000;
const BEAT = 0.25;

/** The pack on a stub world: car 0 is the quarry on the start line; the units follow from 1; `hidden` and `down` are the test's to set. */
function rig(opts: { hidden?: (x: number, z: number) => boolean; colliders?: PropCollider[] } = {}) {
  const first = 1;
  const count = HUNT.units;
  const cars: AiCar[] = Array.from({ length: first + count }, (_, i) => ({ ...blankAiCar(i), x: i === 0 ? spec.start.x : FAR, z: i === 0 ? spec.start.z : FAR, yaw: spec.start.yaw }));
  const hunt = new Uint8Array(32);
  hunt[0] = 1;
  const down = new Set<number>();
  const drops: { t: number; id: number; x: number; z: number; yaw: number; room: number }[] = [];
  const stored: { t: number; id: number }[] = [];
  const asked: { x: number; z: number; hidden: boolean }[] = [];
  let now = 0;
  const world: HunterWorld = {
    park: (id, x, _y, z, yaw) => {
      // The room it found: the nearest other car on the road at that moment.
      const room = Math.min(...cars.filter((c) => c.id !== id && c.x !== FAR).map((c) => Math.hypot(c.x - x, c.z - z)));
      Object.assign(cars[id]!, { x, z, yaw, vx: 0, vz: 0 });
      down.delete(id);
      drops.push({ t: now, id, x, z, yaw, room });
    },
    store: (id) => {
      Object.assign(cars[id]!, { x: FAR, z: FAR });
      stored.push({ t: now, id });
    },
    seen: () => false,
    hidden: (x, z) => {
      const h = opts.hidden ? opts.hidden(x, z) : true;
      asked.push({ x, z, hidden: h });
      return h;
    },
    down: (id) => down.has(id),
    sirens: () => {},
  };
  const brain = new HunterBrain(track, opts.colliders ?? [], 1, first, count, 5);
  brain.launch(world);
  const run = (until: number, each?: (t: number) => void): void => {
    for (; now < until - 1e-9; now += BEAT) {
      brain.update(now, BEAT, cars, hunt, 0, world);
      each?.(now);
    }
  };
  // The run's clock starts at the green: the countdown before it (negative time) holds the formation.
  now = -4.5;
  run(0);
  return { brain, cars, down, drops, stored, asked, world, run, now: () => now };
}

describe("copsWanted: the escalation schedule", () => {
  it("starts at the formation, one more every HUNT.every s, and stops at the cap", () => {
    const n = spec.formation.length;
    assert.equal(copsWanted(0, n), n);
    assert.equal(copsWanted(HUNT.every - 0.01, n), n);
    assert.equal(copsWanted(HUNT.every, n), n + 1);
    assert.equal(copsWanted(HUNT.every * 3 + 1, n), n + 3);
    assert.equal(copsWanted(10_000, n), HUNT.cap);
    assert.equal(copsWanted(-5, n), n, "before the green nothing is added");
  });
});

describe("HunterBrain: the pack", () => {
  it("launches the formation on its slots, held until the green", () => {
    const r = rig();
    assert.equal(r.brain.hunting, spec.formation.length);
    const slots = r.drops.slice(0, spec.formation.length);
    spec.formation.forEach((f, k) => {
      assert.ok(Math.abs(slots[k]!.x - f.x) < 1e-9 && Math.abs(slots[k]!.z - f.z) < 1e-9 && slots[k]!.id === 1 + k, `slot ${k}`);
    });
    assert.equal(r.drops.length, spec.formation.length, "nothing dropped in before the green");
    const out = r.brain.think(r.cars[1]!, r.cars, 1 / 60);
    assert.deepEqual([out.throttle, out.brake], [0, 1], "held on the brake until the green");
  });

  it("drops in one more cop every HUNT.every s up to the cap, and never past it", () => {
    const r = rig();
    const n = spec.formation.length;
    const mid = new Set([6, 18, 30, 42, 66, 90, 294]);
    r.run(300, (t) => {
      // The cops drive at the player (30 m/s) and wait beside it, so their drop-in spots are free again.
      for (const c of r.cars.slice(1)) {
        const d = Math.hypot(r.cars[0]!.x - c.x, r.cars[0]!.z - c.z);
        if (c.x === FAR || d < 15) continue;
        c.x += ((r.cars[0]!.x - c.x) / d) * 30 * BEAT;
        c.z += ((r.cars[0]!.z - c.z) / d) * 30 * BEAT;
      }
      assert.ok(r.brain.hunting <= HUNT.cap, `${r.brain.hunting} hunting at ${t}`);
      // Halfway through an interval the pack has what the schedule wants.
      if (mid.has(t)) assert.equal(r.brain.hunting, copsWanted(t, n), `at ${t} s`);
    });
    assert.equal(r.brain.hunting, HUNT.cap, "at the cap");
    assert.equal(r.brain.stats.peak, HUNT.cap);
    assert.equal(r.brain.stats.drops, HUNT.cap - n);
  });

  it("drops only where the camera cannot see: nothing arrives while every spot is visible, and each drop sat on a hidden spot", () => {
    const blind = rig({ hidden: () => false });
    blind.run(120);
    assert.equal(blind.brain.stats.drops, 0, "dropped in view");
    assert.ok(blind.asked.length > 0 && blind.asked.length <= (120 / BEAT) * HUNT.tests, "it did look for a spot");

    // Only the far end of the boulevard is hidden.
    const r = rig({ hidden: (_x, z) => z > 300 });
    r.run(60);
    assert.ok(r.brain.stats.drops >= 3, `${r.brain.stats.drops} drops`);
    for (const d of r.drops.slice(spec.formation.length)) assert.ok(d.z > 300, `a cop dropped in at z ${d.z.toFixed(0)}, which the camera sees`);
  });

  it("drops in on a road, 70-120 m from the player, clear of every car, facing the way along the road that points at the player", () => {
    const r = rig();
    r.run(80);
    const proj = blankProjection();
    const target = r.cars[0]!;
    const fresh = r.drops.slice(spec.formation.length);
    assert.ok(fresh.length >= 4);
    for (const d of fresh) {
      const off = Math.sqrt(Math.min(...track.paths().map((p) => projectPath(p, d.x, d.z, -1, proj).dist2)));
      assert.ok(off < 1.5, `${off.toFixed(1)} m off every road`);
      const dist = Math.hypot(d.x - target.x, d.z - target.z);
      assert.ok(dist >= HUNT.dropMin - 1e-6 && dist <= HUNT.dropMax + 1e-6, `${dist.toFixed(0)} m from the player`);
      // Facing: the nose has a positive component toward the player.
      assert.ok(Math.sin(d.yaw) * (target.x - d.x) + Math.cos(d.yaw) * (target.z - d.z) > 0, "facing away from the player");
      assert.ok(d.room >= HUNT.clear, `${d.room.toFixed(1)} m from the nearest car`);
    }
  });

  it("drops in ahead of a moving player first", () => {
    const r = rig();
    // The player drives at 30 m/s toward the hill: ahead is -z.
    Object.assign(r.cars[0]!, { z: 300, vx: 0, vz: -30, yaw: Math.PI });
    r.run(HUNT.every + 3);
    const drop = r.drops[spec.formation.length];
    assert.ok(drop, "no drop");
    const d = Math.hypot(drop.x, drop.z - 300);
    assert.ok((drop.z - 300) * -1 > d * 0.3, `dropped at z ${drop.z.toFixed(0)}, not ahead of a player heading -z from 300`);
  });

  it("puts a wrecked cop away only after HUNT.wreckStore s and only once nobody can see it, then drops a replacement", () => {
    let visible = true;
    const r = rig({ hidden: () => !visible });
    // Let the pack grow to a sixth cop first: the drop needs a hidden spot too.
    visible = false;
    r.run(HUNT.every + 3);
    visible = true;
    const before = r.brain.hunting;
    r.down.add(2);
    r.run(r.now() + HUNT.wreckStore + 10);
    assert.equal(r.stored.filter((s) => s.id === 2).length, 0, "put away in view");
    visible = false;
    const t0 = r.now();
    r.run(t0 + 1);
    assert.equal(r.stored.filter((s) => s.id === 2).length, 1, "not put away once unseen");
    assert.ok(r.stored[0]!.t - t0 >= 0 && r.stored[0]!.t - t0 < 1);
    r.run(r.now() + 6);
    assert.ok(before >= spec.formation.length + 1);
    assert.equal(r.brain.hunting, copsWanted(r.now(), spec.formation.length), "the pack is back to what the schedule wants");
    assert.equal(r.brain.stats.disabled, 1);
    // Hidden from the start: still not before wreckStore.
    const q = rig();
    q.down.add(3);
    q.run(HUNT.wreckStore - 1);
    assert.equal(q.stored.length, 0, "put away early");
    q.run(HUNT.wreckStore + 1);
    assert.equal(q.stored.filter((s) => s.id === 3).length, 1);
  });

  it("puts away a cop lost far from the player out of sight, never one that is far but seen, and drops in another", () => {
    let visible = false;
    const r = rig({ hidden: () => !visible });
    r.cars[3]!.x = 0;
    r.cars[3]!.z = spec.start.z - HUNT.far - 30;
    const hold = (): void => {
      r.cars[3]!.x = 0;
      r.cars[3]!.z = spec.start.z - HUNT.far - 30;
    };
    visible = true;
    r.run(HUNT.farTime + 4, hold);
    assert.equal(r.stored.length, 0, "put away in view");
    visible = false;
    const t0 = r.now();
    r.run(t0 + HUNT.farTime + 1, hold);
    assert.equal(r.stored.filter((s) => s.id === 3).length, 1);
    assert.ok(r.stored[0]!.t - t0 >= HUNT.farTime - BEAT, `put away after ${(r.stored[0]!.t - t0).toFixed(2)} s`);
    assert.equal(r.brain.stats.despawns, 1);
    const storedAt = r.stored[0]!.t;
    r.run(r.now() + 4);
    assert.ok(r.drops.some((d) => d.id === 3 && d.t >= storedAt && d.t < storedAt + 2), "no cop took its place");
    assert.equal(r.brain.hunting, copsWanted(r.now(), spec.formation.length));
  });
});

describe("HunterBrain: driving", () => {
  /** One cop at the origin facing +z, its quarry `dist` m ahead, optionally behind a wall of `hx` × `hz` m at `z = wallZ`. */
  function drive(dist: number, wall?: { hx: number; hz: number; z: number }) {
    const colliders: PropCollider[] = wall
      ? [{ index: 0, prefab: "building", body: "solid", x: 0, z: wall.z, yaw: 0, kind: "box", r: Math.hypot(wall.hx, wall.hz), hx: wall.hx, hz: wall.hz, mass: 0 }]
      : [];
    const r = rig({ colliders });
    r.run(0.25);
    const cop = r.cars[1]!;
    const tg = r.cars[0]!;
    Object.assign(cop, { x: 0, z: 0, yaw: 0, vx: 0, vz: 12 });
    Object.assign(tg, { x: 0, z: dist, yaw: 0, vx: 0, vz: 0 });
    return { r, cop, tg, out: () => r.brain.think(cop, r.cars, 1 / 60) };
  }

  it("is held on the brake until the green and drives once it comes", () => {
    const r = rig();
    Object.assign(r.cars[1]!, { x: 0, z: 0, yaw: 0, vx: 0, vz: 10 });
    Object.assign(r.cars[0]!, { x: 0, z: 100 });
    assert.equal(r.brain.think(r.cars[1]!, r.cars, 1 / 60).brake, 1);
    r.run(0.25);
    const out = r.brain.think(r.cars[1]!, r.cars, 1 / 60);
    assert.deepEqual([out.brake, out.throttle], [0, 1]);
  });

  it("chases a far target flat out, boosted, steering straight at it in the open", () => {
    const d = drive(100);
    const o = d.out();
    assert.equal(o.throttle, 1);
    assert.ok(o.boost, "no catch-up boost 100 m behind");
    assert.ok(Math.abs(o.steer) < 0.05, `steer ${o.steer}`);
  });

  it("bends round a solid that stands between it and the target, and steers straight without it", () => {
    const wall = { hx: 15, hz: 7, z: 20 };
    const free = drive(100).out().steer;
    const walled = drive(100, wall);
    const o = walled.out();
    assert.ok(Math.abs(free) < 0.05);
    assert.ok(Math.abs(o.steer) > 0.3, `steer ${o.steer} with a wall dead ahead`);
    // And it keeps to the side it chose on the next call (no dither).
    assert.equal(Math.sign(walled.out().steer), Math.sign(o.steer));
  });

  it(`inside ATTACK (${ATTACK} m) it drives the police's own attack geometry`, () => {
    const d = drive(ATTACK - 10);
    const got = { ...d.out() };
    const want = idleDrive();
    want.brake = 0;
    attackTarget(d.cop, d.tg, 0, 1.5, 12, ATTACK - 10, false, want, false);
    assert.equal(got.throttle, want.throttle);
    assert.equal(got.brake, want.brake);
    assert.equal(got.boost, want.boost);
    assert.equal(got.steer, want.steer);
  });

  it("backs off when wedged, as the police do", () => {
    const d = drive(100);
    // Throttle held, no motion, for longer than the wedge window.
    Object.assign(d.cop, { vx: 0, vz: 0 });
    let reversed = false;
    for (let i = 0; i < 60 * 3 && !reversed; i++) reversed = d.out().throttle < 0;
    assert.ok(reversed, "never backed off");
  });
});
