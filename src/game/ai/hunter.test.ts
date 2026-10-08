import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { physicsSlice } from "../contact/sat.ts";
import { idleDrive } from "../vehicle/car-drive.ts";
import { blankAiCar, type AiCar } from "./derby-ai.ts";
import { copsWanted, HUNT, HunterBrain } from "./hunter.ts";
import { ATTACK, attackTarget, type HunterWorld } from "./cop-brain.ts";
import type { PropCollider } from "../world/placements.ts";
import { blankProjection, projectPath, Track } from "../world/track.ts";
import { HAVANA } from "../world/tracks/havana.ts";

const track = new Track(HAVANA);
const spec = track.survival!;
const FAR = 4000;
const BEAT = 0.25;

/** The pack on a stub world: car 0 is the quarry on the start line; the units follow from 1; `hidden` and `down` are the test's to set. */
function rig(opts: { hidden?: (x: number, z: number) => boolean; colliders?: PropCollider[]; seed?: number } = {}) {
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
  const brain = new HunterBrain(track, opts.colliders ?? [], 1, first, count, opts.seed ?? 5);
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

describe("given the Survival schedule of how many cops are wanted as the heat goes on, with a starting formation of cops", () => {
  it("when the wanted count is read at different times, then it starts at the formation size, grows by one every 12 s, stops at the cap of 12 and adds nothing before the green", () => {
    const n = spec.formation.length;
    assert.equal(copsWanted(0, n), n);
    assert.equal(copsWanted(HUNT.every - 0.01, n), n);
    assert.equal(copsWanted(HUNT.every, n), n + 1);
    assert.equal(copsWanted(HUNT.every * 3 + 1, n), n + 3);
    assert.equal(copsWanted(10_000, n), HUNT.cap);
    assert.equal(copsWanted(-5, n), n, "before the green nothing is added");
  });
});

describe("given the Survival hunter pack (the cops that chase the player) on a stub world, the player on the start line and the cops in their start formation", () => {
  it("when the heat is set up before the green, then the cops launch onto their formation slots with nothing dropped in yet and are held on the brake", () => {
    const r = rig();
    assert.equal(r.brain.hunting, spec.formation.length);
    const slots = r.drops.slice(0, spec.formation.length);
    for (const [k, f] of spec.formation.entries()) {
      assert.ok(Math.abs(slots[k]!.x - f.x) < 1e-9 && Math.abs(slots[k]!.z - f.z) < 1e-9 && slots[k]!.id === 1 + k, `slot ${k}`);
    }
    assert.equal(r.drops.length, spec.formation.length, "nothing dropped in before the green");
    const out = r.brain.think(r.cars[1]!, r.cars, 1 / 60);
    assert.deepEqual([out.throttle, out.brake], [0, 1], "held on the brake until the green");
  });

  it("when 300 s pass with the cops driving to the player and waiting beside it, then one more cop drops in every 12 s up to the cap and never past it, and halfway through each interval the pack has what the schedule wants", () => {
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

  it("when the camera sees every spot, then no cop drops in, and when only the far end of the road is hidden, then every drop lands on a hidden spot", () => {
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

  it("when cops drop in over 80 s, then each lands on a road, 70-120 m from the player and 12 m clear of every car, facing along the road toward the player", () => {
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

  it("when the player drives at 30 m/s and the next cop drops in, then it lands ahead of the player's direction of travel", () => {
    const r = rig();
    // The player drives at 30 m/s toward the hill: ahead is -z.
    Object.assign(r.cars[0]!, { z: 300, vx: 0, vz: -30, yaw: Math.PI });
    r.run(HUNT.every + 3);
    const drop = r.drops[spec.formation.length];
    assert.ok(drop, "no drop");
    const d = Math.hypot(drop.x, drop.z - 300);
    assert.ok((drop.z - 300) * -1 > d * 0.3, `dropped at z ${drop.z.toFixed(0)}, not ahead of a player heading -z from 300`);
  });

  it("when the player drives straight at a drop-in spot at 16 or 30 m/s, then every seed drops a cop in and at the frame it shows it is still at least 70 m from the player", (t) => {
    for (const v of [16, 30]) {
      const near = approach(v);
      const worst = near.length > 0 ? near.reduce((a, b) => (b.near < a.near ? b : a)) : null;
      t.diagnostic(`${v} m/s: ${near.length} of ${SEEDS} seeds dropped in; nearest judged ${Math.min(...near.map((n) => n.judged)).toFixed(3)} m, nearest at the show ${worst?.near.toFixed(3)} m`);
      assert.equal(near.length, SEEDS, `${v} m/s: ${SEEDS - near.length} seeds never dropped in`);
      assert.ok(worst!.near >= HUNT.dropMin - 1e-6, `${v} m/s: seed ${worst!.seed} judged its spot ${worst!.judged.toFixed(3)} m off, and the player was ${worst!.near.toFixed(3)} m from it as the cop showed`);
    }
  });

  it("when drop-in spots are judged only where the cop is placed, with no allowance for the player driving on, then at 16 and 30 m/s some cop shows closer than 70 m to the player", (t) => {
    const lag = Reflect.get(HUNT, "lag");
    Reflect.set(HUNT, "lag", 0);
    try {
      for (const v of [16, 30]) {
        const near = approach(v);
        t.diagnostic(`${v} m/s: ${near.filter((n) => n.near < HUNT.dropMin).length} of ${near.length} drop-ins inside the minimum at the show, nearest ${Math.min(...near.map((n) => n.near)).toFixed(3)} m`);
        assert.ok(near.some((n) => n.near < HUNT.dropMin), `${v} m/s: no seed dropped a cop inside the minimum`);
      }
    } finally {
      Reflect.set(HUNT, "lag", lag);
    }
  });

  it("when a cop is wrecked, then it is put away only after 6 s and only once nobody can see it, and a replacement drops in so the pack is back to what the schedule wants", () => {
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

  it("when a cop is lost far from the player, then it is put away after 5 s out of sight and never while seen, and another cop drops in to take its place", () => {
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

describe("given one cop at the origin facing +z, driven by the hunter brain, with its target ahead", () => {
  /** One cop at the origin facing +z, its quarry `dist` m ahead, optionally behind a wall of `hx` × `hz` m at `z = wallZ`. */
  function drive(dist: number, wall?: { hx: number; hz: number; z: number }) {
    const colliders: PropCollider[] = wall
      ? [{ index: 0, prefab: "building", body: "solid", x: 0, z: wall.z, yaw: 0, kind: "box", r: Math.hypot(wall.hx, wall.hz), hx: wall.hx, hz: wall.hz, mass: 0, base: 0, top: 14, ends: 3 }]
      : [];
    const r = rig({ colliders });
    r.run(0.25);
    const cop = r.cars[1]!;
    const tg = r.cars[0]!;
    Object.assign(cop, { x: 0, z: 0, yaw: 0, vx: 0, vz: 12 });
    Object.assign(tg, { x: 0, z: dist, yaw: 0, vx: 0, vz: 0 });
    return { r, cop, tg, out: () => r.brain.think(cop, r.cars, 1 / 60) };
  }

  it("when the heat is before the green and then the green comes, then the cop is held on the brake until the green and drives once it comes", () => {
    const r = rig();
    Object.assign(r.cars[1]!, { x: 0, z: 0, yaw: 0, vx: 0, vz: 10 });
    Object.assign(r.cars[0]!, { x: 0, z: 100 });
    assert.equal(r.brain.think(r.cars[1]!, r.cars, 1 / 60).brake, 1);
    r.run(0.25);
    const out = r.brain.think(r.cars[1]!, r.cars, 1 / 60);
    assert.deepEqual([out.brake, out.throttle], [0, 1]);
  });

  it("when the target is 100 m ahead in the open, then the cop chases at full throttle with a catch-up boost, steering straight at it", () => {
    const d = drive(100);
    const o = d.out();
    assert.equal(o.throttle, 1);
    assert.ok(o.boost, "no catch-up boost 100 m behind");
    assert.ok(Math.abs(o.steer) < 0.05, `steer ${o.steer}`);
  });

  it("when a solid wall stands between it and the target, then the cop bends round the wall and keeps to the side it chose on the next call, and without the wall it steers straight", () => {
    const wall = { hx: 15, hz: 7, z: 20 };
    const free = drive(100).out().steer;
    const walled = drive(100, wall);
    const o = walled.out();
    assert.ok(Math.abs(free) < 0.05);
    assert.ok(Math.abs(o.steer) > 0.3, `steer ${o.steer} with a wall dead ahead`);
    // And it keeps to the side it chose on the next call (no dither).
    assert.equal(Math.sign(walled.out().steer), Math.sign(o.steer));
  });

  it(`when the target is inside the ${ATTACK} m attack range, then the cop drives exactly as the police's own attack driving does`, () => {
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

  it("when it holds the throttle with no motion for longer than the wedge window, then it backs off, as the police do", () => {
    const d = drive(100);
    // Throttle held, no motion, for longer than the wedge window.
    Object.assign(d.cop, { vx: 0, vz: 0 });
    let reversed = false;
    for (let i = 0; i < 60 * 3 && !reversed; i++) reversed = d.out().throttle < 0;
    assert.ok(reversed, "never backed off");
  });

  it("when it holds full throttle against a wall corner for 3 s with its measured speed stuck at 1.5 m/s while it barely moves, then it still backs off", () => {
    const d = drive(100);
    let reversed = false;
    // The contact takes the displacement back each step, so the velocity the brain reads stays at 1.5 m/s: the car moves 0.3 m in 3 s.
    for (let i = 0; i < 60 * 3 && !reversed; i++) {
      Object.assign(d.cop, { vx: 0, vz: 1.5, z: d.cop.z + 0.1 / 60 });
      reversed = d.out().throttle < 0;
    }
    assert.ok(reversed, "a car pushing a wall for 3 s without moving never backed off");
  });

  it("when it sits 4 m behind and 2.6 m beside a target at the target's own speed, then at 30 m/s it holds its row instead of closing up and at 10 m/s it presses on with its PIT (the nudge that spins the target out)", () => {
    // The cop 4 m behind the target and 2.6 m to one side, at the target's own speed: inside the first row (6 m).
    const fast = drive(4);
    Object.assign(fast.tg, { x: 0, z: 4, vx: 0, vz: 30 });
    Object.assign(fast.cop, { x: 2.6, z: 0, vx: 0, vz: 30 });
    const held = { ...fast.out() };
    assert.equal(held.throttle, 0, "closed up on a fast target it was already inside the row of");
    assert.ok(held.brake > 0, "did not ease back to its row");
    const slow = drive(4);
    Object.assign(slow.tg, { x: 0, z: 4, vx: 0, vz: 10 });
    Object.assign(slow.cop, { x: 2.6, z: 0, vx: 0, vz: 10 });
    const pit = { ...slow.out() };
    assert.equal(pit.throttle, 1, "did not press its PIT on a slow target");
  });

  it("when it closes at 20 m/s on a stopped target 13 m ahead, then it brakes fully without steering if the target is in its lane, and drives past without steering or braking one lane over", () => {
    // A stopped target 13 m ahead, the cop at 20 m/s: 20² > 16 × 13.
    const inLine = drive(13);
    Object.assign(inLine.cop, { x: 0, z: 0, vx: 0, vz: 20 });
    const hit = { ...inLine.out() };
    assert.equal(hit.brake, 1, "did not brake for a stopped car in its lane");
    assert.equal(hit.steer, 0, "turned into it");
    // The same closing speed, a lane over: it goes past at speed and does not turn in.
    const beside = drive(13);
    Object.assign(beside.cop, { x: 3, z: 0, vx: 0, vz: 20 });
    const past = { ...beside.out() };
    assert.equal(past.steer, 0, "turned into a target it was passing");
    assert.equal(past.brake, 0, "braked beside a lane that was clear");
  });
});

/** A frame's steps run at most 8 slices (`SimPacer`'s MAX_STEPS) of `physicsSlice` at the engine's slowest slice speed (8 m/s): the longest a placed cop waits to show while the player drives on. */
const SHOW_LAG = 8 * physicsSlice(Infinity, 8);
const SEEDS = 12;

/** A spot of the main loop far from the formation where the road runs straight through the next two spots: its place, the road's heading, and the spacing of the spots. */
function straightSpot(): { x: number; z: number; ux: number; uz: number; step: number } {
  const p = track.path;
  const gap = HUNT.spacing;
  for (let k = 0; k + 2 * gap < p.count; k += gap) {
    if (Math.hypot(p.x[k]! - spec.start.x, p.z[k]! - spec.start.z) < 250 || p.deck[k] || p.deck[k + gap] || p.deck[k + 2 * gap]) continue;
    if (p.tx[k]! * p.tx[k + gap]! + p.tz[k]! * p.tz[k + gap]! < 0.9999 || p.tx[k]! * p.tx[k + 2 * gap]! + p.tz[k]! * p.tz[k + 2 * gap]! < 0.9999) continue;
    return { x: p.x[k]!, z: p.z[k]!, ux: p.tx[k]!, uz: p.tz[k]!, step: Math.hypot(p.x[k + gap]! - p.x[k]!, p.z[k + gap]! - p.z[k]!) };
  }
  throw new Error("no straight stretch of road for the drop-in spots");
}

/**
 * A player driving at `speed` m/s along a straight road toward the drop-in spot `dropMin + 0.2` m ahead, the camera seeing every spot but the
 * ring just beyond `dropMin` that holds that spot and the next one. Per seed: the first drop-in's distance from the player where the hunter
 * judged it, and the nearest the player came to it over the `SHOW_LAG` s that follow (the cop shows somewhere in them).
 */
function approach(speed: number): { seed: number; judged: number; near: number }[] {
  const s = straightSpot();
  const px = s.x - s.ux * (HUNT.dropMin + 0.2);
  const pz = s.z - s.uz * (HUNT.dropMin + 0.2);
  const ring = (x: number, z: number): boolean => {
    const d = Math.hypot(x - px, z - pz);
    return d >= HUNT.dropMin && d < HUNT.dropMin + 0.2 + s.step + 0.5;
  };
  const out: { seed: number; judged: number; near: number }[] = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rig({ seed, hidden: ring });
    Object.assign(r.cars[0]!, { x: px, z: pz, yaw: Math.atan2(s.ux, s.uz), vx: s.ux * speed, vz: s.uz * speed });
    r.run(HUNT.every + 20);
    const drop = r.drops[spec.formation.length];
    if (!drop) continue;
    let near = Infinity;
    for (let t = 0; t <= SHOW_LAG + 1e-9; t += 1 / 240) near = Math.min(near, Math.hypot(drop.x - (px + s.ux * speed * t), drop.z - (pz + s.uz * speed * t)));
    out.push({ seed, judged: Math.hypot(drop.x - px, drop.z - pz), near });
  }
  return out;
}
