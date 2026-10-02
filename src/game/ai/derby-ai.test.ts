import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DerbyBrain, DERBY_RULES, type AiCar } from "./derby-ai.ts";
import { DerbyMatch, heatLimit, snapshotAiCar, type DerbyDecided } from "../match/derby.ts";
import { clipDerbyCar, clipToDerbyBowl, DERBY_RADIUS, derbyRadius } from "../scenes/derby-arena.ts";
import { applyDrive } from "../vehicle/car-drive.ts";
import { fleetStyle, layoutDerby, type DerbySlot } from "../scenes/fleet.ts";
import { DeformableCar } from "../vehicle/car.ts";
import { CAR_HALF } from "../vehicle/car-mesh.ts";
import { physicsSlice } from "../contact/sat.ts";
import { newWorld, stepWorld } from "../engine/world-step.ts";
import { armKill, assignClass, carClass, HANDLING } from "../vehicle/vehicle-classes.ts";
import { INITIAL_HUD } from "../hud/hud-store.ts";
import { aiCar as car, decide } from "../vehicle/test-support.ts";

describe("derby tactics", () => {
  it("good: a nose beside our rear wheel gets a handbrake swing that whips the tail into it", () => {
    const brain = new DerbyBrain();
    const me = car(0, { vz: 9 });
    // Its nose (1.7 m ahead of it) sits 1.8 m left of us, level with our rear wheel, pointing at our side.
    const foe = car(1, { x: 3.5, z: -1.8, yaw: -Math.PI / 2, vz: 0 });
    const input = decide(brain, me, [me, foe]);
    assert.equal(brain.tacticOf(0), "swing");
    // Steering right swings the tail left, into it.
    assert.ok(input.ebrake && input.throttle === 0 && input.steer < -0.5, JSON.stringify(input));
  });

  it("good: a car coming alongside gets sideswiped — but never on its driver's door", () => {
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

  it("good: backing in from the driver's side aims further forward, at the bumper corner, clear of the door", () => {
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

describe("derby aggression (the shared slider model)", () => {
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

  it("good: aggression 0 keeps clear of every hit, even with the hit clock long gone", () => {
    assert.equal(tactic(0, { idle: 1000 }), "layback");
  });

  it("good: 0.5 keeps clear of an equal car, hits a more wrecked one, and hits anyway when the clock runs low", () => {
    assert.equal(tactic(0.5, {}), "layback");
    assert.notEqual(tactic(0.5, {}, { front: 0.6, damage: 0.6 }), "layback");
    assert.notEqual(tactic(0.5, { idle: DERBY_RULES.hitClock * 0.62 }), "layback");
  });

  it("good: full aggression goes in whatever its own state", () => {
    assert.notEqual(tactic(1, { front: 0.8, damage: 0.8 }), "layback");
  });

  it("good: with one rival left nobody waits for the others to soften it up", () => {
    assert.notEqual(tactic(0.3, {}, {}, false), "layback");
  });
});

describe("derby count-outs (rule books: an aggressive hit every 60 s, out after 60 s without moving)", () => {
  const names = [0, 1, 2, 3].map((id) => ({ id, name: `c${id}` }));

  it("bad: no aggressive hit for the hit clock is out — a push doesn't reset it, a real hit does — and nobody hunts it after", () => {
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

  it("bad: a running car that hasn't got 2 m from where it stopped for the still clock is out", () => {
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

  it("good: the time limit crowns the top score among the cars still running, marked as a points win", () => {
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

describe("derby bowl scales with the field", () => {
  it("bad: no two spawn hulls overlap for 2…32 cars, every spawn is inside the bowl, and the bowl only grows", () => {
    let prev = 0;
    for (let n = 2; n <= 32; n++) {
      const r = derbyRadius(n);
      assert.ok(r >= prev, `bowl shrank at ${n}: ${r.toFixed(2)} < ${prev.toFixed(2)}`);
      prev = r;
      if (n <= 10) assert.equal(r, DERBY_RADIUS, `${n} cars must keep today's bowl`);
      const slots = layoutDerby(n, r, 12, () => 0.37);
      assert.equal(slots.length, n);
      for (let i = 0; i < n; i++) {
        const s = slots[i]!;
        assert.equal(clipToDerbyBowl(s.x, s.z, 0, 0, CAR_HALF.z, r).hit, false, `${n} cars: car ${i} spawns in the wall`);
        for (let j = i + 1; j < n; j++) assert.ok(!hullsOverlap(s, slots[j]!), `${n} cars: ${i} and ${j} spawn on top of each other`);
      }
    }
  });
});

type Field = {
  seed: number;
  winner: number | null;
  decided: DerbyDecided | null;
  t: number;
  deaths: number[];
  outs: number[];
  contactSpins: string[];
  freeSpins: string[];
  /** Peak heading rate over any 0.1 s inside 0.5 s of a pair contact, in the first 2 min. */
  contactPeak: { rate: number; note: string };
  zips: string[];
  impacts: { front: number; rear: number; side: number };
  swings: number;
  jturns: number;
  sideswipes: number;
};

function face(c: DeformableCar, p: THREE.Vector3): "front" | "rear" | "side" {
  const dx = p.x - c.group.position.x;
  const dz = p.z - c.group.position.z;
  const along = (dx * c.fwdFlat.x + dz * c.fwdFlat.z) / CAR_HALF.z;
  const across = (dx * c.fwdFlat.z - dz * c.fwdFlat.x) / CAR_HALF.x;
  if (Math.abs(along) * 1.15 < Math.abs(across)) return "side";
  return along > 0 ? "front" : "rear";
}

function centroid(c: DeformableCar): { x: number; z: number } {
  let x = 0;
  let z = 0;
  let m = 0;
  for (const p of c.deform.masses) {
    x += p.world.x * p.mass;
    z += p.world.z * p.mass;
    m += p.mass;
  }
  return { x: x / m, z: z / m };
}

/**
 * A derby of `n` AI cars through the engine's stack (`stepWorld` with the derby's hit credit and bowl,
 * cars dressed as `dressCar` does at the game's defaults), at the default slider, to the end of the heat.
 * Spins: |yaw rate| > 5 rad/s for > 0.2 s in the first 2 min, split by a car contact in the 0.3 s before the spin began.
 * Zips: a live mass centroid moving more than 3·v·h + 5 cm in a step. Impacts: AI hits closing ≥ 3 m/s,
 * by the attacker's face.
 */
function runField(n: number, seed: number): Field {
  const scene = new THREE.Scene();
  const cars = Array.from({ length: n }, (_, i) => new DeformableCar({ body: 0xc5c8ce, accent: 0x9aa0a8, name: `c${i}` }, scene, null, fleetStyle(i)));
  let s = seed;
  const rng = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  const radius = derbyRadius(n);
  const slots = layoutDerby(n, radius, 12, rng);
  const match = new DerbyMatch();
  match.begin(
    cars.map((_, i) => ({ id: i, name: `c${i}` })),
    { seed },
  );
  const w = newWorld(cars);
  w.afterCar = (c) => clipDerbyCar(c, radius);
  cars.forEach((c, i) => {
    c.spawnFacing(slots[i]!.x, slots[i]!.z, slots[i]!.yaw, slots[i]!.speed);
    c.deform.squash = INITIAL_HUD.squash;
    c.deform.buckle = INITIAL_HUD.buckle;
    c.deform.setMode(INITIAL_HUD.deformMode);
    const cls = carClass(c);
    assignClass(c, cls);
    armKill(c.deform, cls, HANDLING.realism, "derby");
  });
  const out: Field = {
    seed,
    winner: null,
    decided: null,
    t: 0,
    deaths: [],
    outs: [],
    contactSpins: [],
    freeSpins: [],
    zips: [],
    contactPeak: { rate: 0, note: "none" },
    impacts: { front: 0, rear: 0, side: 0 },
    swings: 0,
    jturns: 0,
    sideswipes: 0,
  };
  const yaw0 = cars.map((c) => c.yaw);
  const spinFor = new Array<number>(n).fill(0);
  /** Per car: [t, yaw] pairs spanning about 0.1 s, for the contact peak. */
  const ring = cars.map((): number[] => []);
  const touched = new Array<number>(n).fill(-9);
  const tactic = new Array<string>(n).fill("");
  const alive = new Array<boolean>(n).fill(true);
  let t = 0;
  let state = "running";
  const end = heatLimit(n) + 1;
  while (t < end && state === "running") {
    let vmax = 8;
    for (const c of cars) vmax = Math.max(vmax, c.speed);
    const h = physicsSlice(1 / 60, vmax);
    const before = cars.map((c) => (c.deform.massActive ? centroid(c) : null));
    const speed0 = cars.map((c) => Math.hypot(c.velocity.x, c.velocity.z));
    const shove = new Array<number>(n).fill(0);
    const snaps = match.snapshots(n);
    cars.forEach((c, i) =>
      snapshotAiCar(snaps[i]!, i, c.group.position.x, c.group.position.z, c.yaw, c.velocity.x, c.velocity.z, c.deform.drivetrainAlive, c.deform.masses),
    );
    cars.forEach((c, i) => {
      applyDrive(c, match.think(snaps[i]!, snaps, h), h);
      const now = match.brain.tacticOf(i);
      if (now !== tactic[i]) {
        if (now === "swing") out.swings++;
        else if (now === "jturn") out.jturns++;
        else if (now === "sideswipe") out.sideswipes++;
        tactic[i] = now;
      }
    });
    w.pairHit = (a, b, pair) => {
      const ca = cars[a]!;
      const cb = cars[b]!;
      touched[a] = t;
      touched[b] = t;
      shove[a] = Math.max(shove[a]!, speed0[b]!);
      shove[b] = Math.max(shove[b]!, speed0[a]!);
      const aInto = -(ca.velocity.x * pair.normal.x + ca.velocity.z * pair.normal.z);
      const bInto = cb.velocity.x * pair.normal.x + cb.velocity.z * pair.normal.z;
      if (!match.noteHit(a, b, aInto, bInto, pair.impulse)) return;
      const attacker = aInto >= bInto ? ca : cb;
      if (attacker.deform.drivetrainAlive && aInto + bInto >= 3) out.impacts[face(attacker, pair.contact)]++;
    };
    stepWorld(w, h);
    for (const c of cars) if (c.deform.massActive && !c.deform.drivetrainAlive) c.deform.cutDrive(h);
    state = match.step(
      h,
      cars.map((c, i) => ({ id: i, name: `c${i}`, alive: c.deform.drivetrainAlive, x: c.group.position.x, z: c.group.position.z })),
    );
    cars.forEach((c, i) => {
      if (alive[i] && !c.deform.drivetrainAlive) out.deaths.push(+t.toFixed(1));
      alive[i] = c.deform.drivetrainAlive;
      if (match.board[i]!.out && !out.outs.includes(i)) out.outs.push(i);
      let dyaw = c.yaw - yaw0[i]!;
      dyaw -= Math.round(dyaw / (Math.PI * 2)) * Math.PI * 2;
      yaw0[i] = c.yaw;
      if (Math.abs(dyaw) / h > 5) spinFor[i]! += h;
      else spinFor[i] = 0;
      if (spinFor[i]! > 0.2 && spinFor[i]! - h <= 0.2 && t < 120) {
        const note = `t=${t.toFixed(1)} c${i} ${(Math.abs(dyaw) / h).toFixed(1)} rad/s`;
        (t - touched[i]! < 0.5 ? out.contactSpins : out.freeSpins).push(note);
      }
      const rb = ring[i]!;
      rb.push(t, c.yaw);
      while (rb.length > 4 && rb[2]! <= t - 0.1) rb.splice(0, 2);
      if (t - rb[0]! >= 0.099 && t - touched[i]! < 0.5 && t < 120) {
        let turn = c.yaw - rb[1]!;
        turn -= Math.round(turn / (Math.PI * 2)) * Math.PI * 2;
        const rate = Math.abs(turn) / (t - rb[0]!);
        if (rate > out.contactPeak.rate) out.contactPeak = { rate, note: `c${i} ${rate.toFixed(2)} rad/s at t=${t.toFixed(1)}` };
      }
      const a = before[i];
      if (!a || !c.deform.massActive || t >= 120) return;
      const b = centroid(c);
      const moved = Math.hypot(b.x - a.x, b.z - a.z);
      const vMax = Math.max(speed0[i]!, Math.hypot(c.velocity.x, c.velocity.z), shove[i]!);
      if (moved > 3 * vMax * h + 0.05) out.zips.push(`t=${t.toFixed(2)} c${i} ${moved.toFixed(2)} m`);
    });
    t += h;
  }
  out.t = +t.toFixed(1);
  out.winner = match.winnerId;
  out.decided = match.decided;
  return out;
}

/** Seeds for the 10-car validation: four in CI (seed 3 held the 6.41 rad/s contact peak on 71ad020; seed 11 zipped c5
 *  0.068 m at 82.49 s up to 759c377, RIG_ANALYSIS §6.12), `DERBY_SEEDS=1,2,3,4,5` for the full five. */
const SEEDS = (process.env.DERBY_SEEDS ?? "1,2,3,11").split(",").map(Number);
/** Real derby drivers make most big hits backing up (docs/DERBY_AI.md); ours must too. */
const REAR_SHARE = 0.4;

describe("derby, ten AI cars at the default slider", () => {
  const runs = SEEDS.map((seed) => runField(10, seed));
  const rows = runs.map(
    (r) =>
      `seed ${r.seed}: ${r.decided} c${r.winner} at ${r.t} s; deaths [${r.deaths.join(",")}] outs [${r.outs.join(",")}]; ` +
      `spins contact ${r.contactSpins.length} free ${r.freeSpins.length}; zips ${r.zips.length}; ` +
      `impacts F${r.impacts.front}/R${r.impacts.rear}/S${r.impacts.side}; swings ${r.swings} jturns ${r.jturns} sideswipes ${r.sideswipes}`,
  );

  it("bad: every heat crowns a winner by its time limit — last car standing, or top score at the limit", (t) => {
    for (const row of rows) t.diagnostic(row);
    for (const r of runs) assert.ok(r.winner != null && r.t <= heatLimit(10) + 0.1, rows.join("\n"));
  });

  it("bad: the AI's own driving never spins a car (> 5 rad/s for 0.2 s) in the first 2 min, and no car zips", () => {
    for (const r of runs) {
      assert.deepEqual(r.freeSpins, [], `seed ${r.seed}`);
      assert.deepEqual(r.zips, [], `seed ${r.seed}`);
    }
  });

  it(`bad: most AI hits land tail first — over ${REAR_SHARE * 100} % rear, and a fifth more than the nose hits`, () => {
    for (const r of runs) {
      const all = r.impacts.front + r.impacts.rear + r.impacts.side;
      assert.ok(r.impacts.rear > REAR_SHARE * all && r.impacts.rear > 1.2 * r.impacts.front, rows.join("\n"));
    }
  });

  // The contact-spin steer cap must leave the owner's tactics alone. Seeds 1–5 on 943ae5c (before it):
  // swings 35, J-turns 434, sideswipes 126 (J-turn share 0.73), every heat ≥ 1 swing and sideswipe; after
  // it (d516b54) 29 / 387 / 121 (0.72); with derby wear 32 / 418 / 130 (0.72).
  it("good: every heat has a tail swing and a sideswipe, and J-turns stay most of the moves", () => {
    let swings = 0;
    let jturns = 0;
    let sideswipes = 0;
    for (const r of runs) {
      assert.ok(r.swings >= 1 && r.sideswipes >= 1, rows.join("\n"));
      swings += r.swings;
      jturns += r.jturns;
      sideswipes += r.sideswipes;
    }
    assert.ok(jturns / (swings + jturns + sideswipes) >= 0.73 * 0.7, rows.join("\n"));
  });

  // Measured on 3aa4301 (derby kill travel, seeds 1–5): wreck 2/5 (72.6 s, 112.4 s), count-out 1, time 2;
  // seed 1's first death at 5.9 s. CrashRealism8 (wreck-spin fix, DERBY_KILL_SCALE 0.46): wreck 3/5. Below
  // ×0.46 a single hit kills inside 8 s (×0.36: 4/5, first death 2.6 s). On the contact-spin fix, travel
  // alone: wreck 3/5 (41.4, 154.1, 122.3 s), time 2, first death 13.8 s. With wear (`armKill`): see below.
  it("bad: ≥ 4/5 ten-car heats end last car standing by wrecking inside 300 s, and nobody dies in the first 8 s", () => {
    const all = [1, 2, 3, 4, 5].map((seed) => runs.find((r) => r.seed === seed) ?? runField(10, seed));
    const msg = all.map((r) => `seed ${r.seed}: ${r.decided} at ${r.t} s, first death ${r.deaths[0] ?? "none"}`).join("; ");
    assert.ok(all.filter((r) => r.decided === "wreck").length >= 4, msg);
    for (const r of all) assert.ok((r.deaths[0] ?? Infinity) > 8, msg);
  });

  // Peak heading rate over 0.1 s in contact (probe, seeds 1–5, 120 s): 6.0–9.1 rad/s before the wreck-spin
  // fix, 4.67–6.42 on 71ad020 (4.86 free: the AI's own steer, contact stacked on it). Now 4.18–4.93: clampLocal
  // and collideWith undo their positional turn, separateAlong hands back the angular momentum its uneven
  // push moved, and a driver stops adding lock past 3.5 rad/s.
  it("bad: no car turns faster than 5 rad/s over 0.1 s in pair contact (first 2 min), nor spins there", () => {
    for (const r of runs) {
      assert.deepEqual(r.contactSpins, [], `seed ${r.seed}`);
      assert.ok(r.contactPeak.rate <= 5, `seed ${r.seed}: contact peak ${r.contactPeak.note}`);
    }
  });
});
