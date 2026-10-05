import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DerbyBrain, DERBY_RULES, type AiCar } from "./derby-ai.ts";
import { runField } from "./derby-field.test-util.ts";
import { DerbyMatch, heatLimit } from "../match/derby.ts";
import { clipToDerbyBowl, DERBY_RADIUS, derbyRadius } from "../scenes/derby-arena.ts";
import { layoutDerby, type DerbySlot } from "../scenes/fleet.ts";
import { CAR_HALF } from "../vehicle/car-mesh.ts";
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
      const slots = layoutDerby(n, r, () => 0.37);
      assert.equal(slots.length, n);
      for (let i = 0; i < n; i++) {
        const s = slots[i]!;
        assert.equal(clipToDerbyBowl(s.x, s.z, 0, 0, CAR_HALF.z, r).hit, false, `${n} cars: car ${i} spawns in the wall`);
        for (let j = i + 1; j < n; j++) assert.ok(!hullsOverlap(s, slots[j]!), `${n} cars: ${i} and ${j} spawn on top of each other`);
      }
    }
  });
});

/**
 * The 10-car validation runs a FIXED seed set, 1–8 (`DERBY_SEEDS=1,2,...` to change), and judges the statistics on the
 * set as a whole. Every heat is chaotic, so a single seed fails by chance either side: over seeds 1–12 on the stopped
 * start the rear share per seed runs 37–65 % (seed 1 F39/R39, seed 10 F58/R48), the contact peak 4.33–5.41 rad/s
 * (seed 5 5.41) — while pooled, rear is 55 % (1.6× the nose) and the mean peak 4.73. Picking the seeds that pass hides
 * real regressions; so the shares and peaks are limits on the pool (with a high absolute ceiling for blow-ups), and
 * only things that must NEVER happen (a spin, a zip, a death in the first 8 s) are checked on every seed.
 */
const SEEDS = (process.env.DERBY_SEEDS ?? "1,2,3,4,5,6,7,8").split(",").map(Number);
/** Real derby drivers make most big hits backing up (docs/DERBY_AI.md); ours must too. */
const REAR_SHARE = 0.4;
/** Late-heat car windows that may scoot (set on the fix over seeds 1-72; see the scoot test). */
const SCOOT_SHARE = 0.1;

describe("derby, ten AI cars at the default slider", () => {
  const runs = SEEDS.map((seed) => runField(10, seed));
  const rows = runs.map(
    (r) =>
      `seed ${r.seed}: ${r.decided} c${r.winner} at ${r.t} s; deaths [${r.deaths.join(",")}] outs [${r.outs.join(",")}]; ` +
      `spins contact ${r.contactSpins.length} free ${r.freeSpins.length}; zips ${r.zips.length} max ${(r.zipMax * 100).toFixed(1)} cm [${r.zips.join("; ")}]; ` +
      `contact peak ${r.contactPeak.rate.toFixed(2)} rad/s (${r.contactPeak.note}); ` +
      `impacts F${r.impacts.front}/R${r.impacts.rear}/S${r.impacts.side}; swings ${r.swings} jturns ${r.jturns} sideswipes ${r.sideswipes}; ` +
      `scoot ${r.scoot.flagged}/${r.scoot.windows}`,
  );

  it("bad: every heat crowns a winner by its time limit — last car standing, or top score at the limit", (t) => {
    for (const row of rows) t.diagnostic(row);
    for (const r of runs) assert.ok(r.winner != null && r.t <= heatLimit(10) + 0.1, rows.join("\n"));
  });

  it("bad: the AI's own driving never spins a car (> 5 rad/s for 0.2 s) in the first 2 min, in any heat", () => {
    for (const r of runs) assert.deepEqual(r.freeSpins, [], `seed ${r.seed}`);
  });

  // A zip is a car teleporting centimetres in one step: a physics defect, never noise, so it is judged per seed.
  // Measured on main over seeds 1–8: none zips (seed 2's 5.8 cm zip at t=50.90 s went with the airborne lane).
  for (const r of runs) {
    it(`bad: no car zips in the seed ${r.seed} heat`, () => assert.deepEqual(r.zips, [], `seed ${r.seed}`));
  }

  // Per seed the share runs 37–65 % (seed 1 F39/R39, seed 10 F58/R48); pooled over seeds 1–12 it is 55 %, R/F 1.6,
  // over seeds 1–8 56 %, R/F 1.9. With the AI never backing in (`chooseMode` always nose) the pool reads F554/R50/S125.
  it(`bad: most AI hits land tail first — over ${REAR_SHARE * 100} % rear, and a fifth more than the nose hits (all heats pooled)`, () => {
    const sum = (k: "front" | "rear" | "side") => runs.reduce((a, r) => a + r.impacts[k], 0);
    const all = sum("front") + sum("rear") + sum("side");
    assert.ok(sum("rear") > REAR_SHARE * all && sum("rear") > 1.2 * sum("front"), `F${sum("front")}/R${sum("rear")}/S${sum("side")}\n${rows.join("\n")}`);
  });

  // A tail swing or a sideswipe is a chance that passes by (`opening`): it needs a rival's nose beside our rear wheel
  // (or a car alongside) at 4-13 m/s and a mood above -0.2 or a due hit clock, and a field of low-aggression drivers
  // (aggression is hashed per race) lays back through the whole heat and is given none. "Every heat has one" was a
  // chance claim. Measured over seeds 1–192 on main 8659248 and on the tree without the crest phantom in the block read:
  // 3 of 192 heats have no swing on each (seeds 11, 31, 148 vs 7, 36, 131; 1.6 %, Fisher p 1.00) and 1 vs 0 of 192 no
  // sideswipe (seed 148, p 1.00). Seed 7 there had 3 swing chances in 300 s (2 inside its own committed sideswipe, 1 in
  // an unstick) with six of its ten drivers under aggression 0.2 and 86 % of their ticks in layback; main's seed 11 had 1
  // (87 % layback); heats that swing had 5–60. The bar is ≥ 7 of 8 (87.5 %) for each: pooled over the 384 heats the
  // rates are 98.4 % and 99.7 %, and at those rates 7 of 8 false-fails 0.64 % and 0.02 % of the time (8 of 8: 11.8 % and
  // 2.1 %). All 48 disjoint 8-seed windows (24 per tree) reach 7 for swings (min 7) and for sideswipes (min 7, one window
  // on main). Do not tighten it back to every heat without re-measuring on that many seeds.
  it("bad: ≥ 7 of 8 ten-car heats have a tail swing, and ≥ 7 of 8 a sideswipe", () => {
    const need = 0.875 * runs.length;
    assert.ok(runs.filter((r) => r.swings >= 1).length >= need, rows.join("\n"));
    assert.ok(runs.filter((r) => r.sideswipes >= 1).length >= need, rows.join("\n"));
  });

  // The contact-spin steer cap must leave the owner's tactics alone. Counted as manoeuvres (`MOVE_GAP`) on main
  // c877552 with the pair impulse uncapped, seeds 1/2/3/11: swings 20, J-turns 36, sideswipes 53 (J-turn share
  // 0.33); seeds 1–5 0.25, seeds 1–9 and 11 0.28. The old count of tactic flips read 0.73–0.78 there (one J-turn
  // was dozens of flips) and swung with how long each J-turn sat on its edge: 0.43 at 200 km/h class tops.
  // At those tops the AI drove 45–55 m/s targets into the bowl and its J-turn share fell to 0.19 (24 of 128).
  // Stopped start (lane derby-start, seeds 1–12): 115 J-turns of 537 = 0.214, seeds 1–8 74 of 316 = 0.234; the floor
  // is 0.7 of the 12-seed share, so it holds on any seed set instead of the one that happens to clear 0.231.
  it("good: J-turns keep their share of the moves", () => {
    let moves = 0;
    let jturns = 0;
    for (const r of runs) {
      moves += r.swings + r.jturns + r.sideswipes;
      jturns += r.jturns;
    }
    assert.ok(jturns / moves >= 0.214 * 0.7, rows.join("\n"));
  });

  // Measured on 3aa4301 (derby kill travel, seeds 1–5): wreck 2/5 (72.6 s, 112.4 s), count-out 1, time 2;
  // seed 1's first death at 5.9 s. CrashRealism8 (wreck-spin fix, DERBY_KILL_SCALE 0.46): wreck 3/5. Below
  // ×0.46 a single hit kills inside 8 s (×0.36: 4/5, first death 2.6 s). On the contact-spin fix, travel
  // alone: wreck 3/5 (41.4, 154.1, 122.3 s), time 2, first death 13.8 s. With wear (`armKill`): wreck 12/12
  // over seeds 1–12 on the stopped start, first deaths 10.4–41.9 s. A death in the first 8 s (one hit kills)
  // is a defect in any heat.
  // The finish bar is "ends before the limit", wreck or count-out, ≥ 5 of the 8 (62.5 %). Measured over seeds
  // 1–192 on 7fcac4e (before the airborne merge) and on the airborne tree: 170/192 (88.5 %) vs 168/192 (87.5 %)
  // end before the limit (Fisher p 0.88); time-limit endings 22 vs 24; wreck endings 166 vs 156 (86.5 vs 81.3 %,
  // p 0.21) with count-outs 4 vs 12 (p 0.07, a watch item); per-car-minute contacts, aggressive hits and damage
  // per closing speed, and the alive-count curve, match. The old bar (≥ 80 % wrecks of 8) sat on that rate: seeds
  // 1–8 were a lucky 8/8 before the airborne merge (6/8 after), and 8 of the 24 disjoint 8-seed windows of the
  // pre-airborne tree miss it too. All 48 windows (24 per tree) of 8 seeds reach 5 (min 5); at a true 87.5 % the
  // false-fail rate is 1.1 %. Do not tighten it back without re-measuring on that many seeds.
  it("bad: ≥ 5 of 8 ten-car heats end before the 300 s limit (last car standing by a wreck or a count-out), and nobody dies in the first 8 s", () => {
    const msg = runs.map((r) => `seed ${r.seed}: ${r.decided} at ${r.t} s, first death ${r.deaths[0] ?? "none"}`).join("; ");
    assert.ok(runs.filter((r) => r.decided === "wreck" || r.decided === "countout").length >= 0.625 * runs.length, msg);
    for (const r of runs) assert.ok((r.deaths[0] ?? Infinity) > 8, msg);
  });

  // Peak heading rate over 0.1 s in contact (probe, seeds 1–5, 120 s): 6.0–9.1 rad/s before the wreck-spin
  // fix, 4.67–6.42 on 71ad020 (4.86 free: the AI's own steer, contact stacked on it). Now: clampLocal
  // and collideWith undo their positional turn, separateAlong hands back the angular momentum its uneven
  // push moved, and a driver stops adding lock past 3.5 rad/s. Stopped start, seeds 1–12: per-seed peaks 4.33–5.41
  // (seed 5 5.41, seed 10 5.14), mean 4.73, seeds 1–8 mean 4.74. So the mean over the heats is bounded at 5.2 and
  // any one heat at 6.5, below the 6.0–9.1 of the blown-up contact model; no heat may spin in contact.
  it("bad: car turn rate over 0.1 s in pair contact (first 2 min) stays under 5.2 rad/s on average, 6.5 at worst, and nobody spins there", () => {
    for (const r of runs) {
      assert.deepEqual(r.contactSpins, [], `seed ${r.seed}`);
      assert.ok(r.contactPeak.rate <= 6.5, `seed ${r.seed}: contact peak ${r.contactPeak.note}`);
    }
    const avg = runs.reduce((a, r) => a + r.contactPeak.rate, 0) / runs.length;
    assert.ok(avg <= 5.2, `mean peak ${avg.toFixed(2)} rad/s\n${rows.join("\n")}`);
  });

  // Scoot: a live car pacing back and forth in one spot with no hit landing (`ScootWatch`, the owner's capture of
  // 2026-10-04: four cars, 17-25 reversals in 12.8 s, no contact for 20 s). Windows are every car's 10 s spans with
  // 3-5 cars alive. Measured over seeds 1-72 as nine disjoint 8-seed windows: main 20.7-31.9 % (pooled 26.0 %,
  // 5145/19778), the deadlock breaker 1.3-5.2 % (pooled 3.0 %, 299/9880). The bar is 10 %, twice the fix's worst
  // window and half main's best: do not tighten it to the pooled 3 % without re-measuring on that many seeds.
  it("bad: cautious cars don't pace in place — under SCOOT_SHARE of late-heat car windows (3-5 cars alive) scoot", () => {
    const windows = runs.reduce((a, r) => a + r.scoot.windows, 0);
    const flagged = runs.reduce((a, r) => a + r.scoot.flagged, 0);
    assert.ok(windows >= 400, `only ${windows} late-heat car windows: the bar below judges nothing\n${rows.join("\n")}`);
    assert.ok(flagged <= SCOOT_SHARE * windows, `scoot ${flagged}/${windows} = ${((100 * flagged) / windows).toFixed(1)} %\n${rows.join("\n")}`);
  });
});
