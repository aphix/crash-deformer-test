import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_CARS } from "../scenes/fleet.ts";
import { humanSlot } from "../match/survival.ts";
import { Track } from "../world/track.ts";
import { HAVANA } from "../world/tracks/havana.ts";
import { blankAiCar, type AiCar } from "./derby-ai.ts";
import { copsWanted, HUNT, HunterBrain, huntCap, huntUnits } from "./hunter.ts";
import type { HunterWorld } from "./cop-brain.ts";

const track = new Track(HAVANA);
const spec = track.survival!;
const FAR = 4000;
const BEAT = 0.25;
const GREEN = -4.5;

/**
 * The pack on a stub world for `humans` humans: cars 0 … humans − 1 are the player cars, on the start slots (`humanSlot`) or where `at` puts them; the units
 * follow, `huntUnits` of them. A spot is hidden from the camera unless `hidden` says otherwise (default: every spot), so a drop-in is only ever refused by the
 * pack's own rules; `down` holds the units that are knocked out (a park puts a unit back in one piece).
 */
function rig(humans: number, at: (k: number) => { x: number; z: number } = (k) => humanSlot(spec.start, k), hidden: (x: number, z: number) => boolean = () => true) {
  const count = huntUnits(humans, MAX_CARS - humans);
  const cars: AiCar[] = Array.from({ length: humans + count }, (_, i) => {
    const slot = i < humans ? at(i) : { x: FAR, z: FAR };
    return { ...blankAiCar(i), x: slot.x, z: slot.z, yaw: spec.start.yaw };
  });
  const hunt = new Uint8Array(MAX_CARS);
  hunt.fill(1, 0, humans);
  const down = new Set<number>();
  const drops: { t: number; id: number; x: number; z: number }[] = [];
  let now = GREEN;
  const world: HunterWorld = {
    park: (id, x, _y, z, yaw) => {
      Object.assign(cars[id]!, { x, z, yaw, vx: 0, vz: 0 });
      down.delete(id);
      drops.push({ t: now, id, x, z });
    },
    store: (id) => Object.assign(cars[id]!, { x: FAR, z: FAR }),
    hidden,
    down: (id) => down.has(id),
    sirens: () => {},
  };
  const brain = new HunterBrain(track, [], humans, humans, count, 5);
  brain.launch(world);
  const run = (until: number): void => {
    for (; now < until - 1e-9; now += BEAT) {
      brain.update(now, BEAT, cars, hunt, 0, world);
      // Each cop drives a beat, as in the game.
      for (let i = humans; i < cars.length; i++) if (cars[i]!.x !== FAR) brain.think(cars[i]!, cars, BEAT);
    }
  };
  run(0);
  return { brain, cars, hunt, drops, down, run, count, now: () => now };
}

describe("given the pack a Survival run builds for its humans", () => {
  const n = spec.formation.length;

  for (const humans of [1, 2, 4]) {
    it(`when ${humans} human${humans > 1 ? "s" : ""} are being hunted, then the pack grows ${humans}-fold in the cops it wants and never passes the cap the cars allow`, () => {
      const r = rig(humans);
      const cap = huntCap(humans, r.count);
      // The formation is the course's own; the rest of the wanted count drops in, one every `HUNT.gap`.
      assert.equal(r.brain.hunting, n, "the formation launches at the green, whatever the team's size");
      const early = HUNT.every * 2 + 2;
      r.run(early);
      // Drops come one every `HUNT.gap` from the green, the first at once: what has had time to arrive by `early`.
      const reachable = n + Math.floor(early / HUNT.gap) + 1;
      assert.equal(r.brain.hunting, Math.min(copsWanted(early, n, humans, r.count), reachable), `hunting at ${early} s`);
      assert.equal(copsWanted(early, n, humans, r.count), Math.min(cap, humans * (n + 2)), "wanted: scaled by the humans, up to the cap");
      r.run(300);
      assert.equal(r.brain.hunting, cap, "at the cap in the end");
      assert.ok(r.brain.hunting <= humans * HUNT.cap, "never more than a human's cap each");
      assert.ok(humans + r.brain.hunting + (HUNT.units - HUNT.cap) <= MAX_CARS, "the car list holds the pack, its wrecks and the humans");
    });
  }

  it("when the team has one human, then the pack is the one a lone player has always met: the cap of 12 and the 16 units", () => {
    assert.equal(huntUnits(1, MAX_CARS - 1), HUNT.units);
    assert.equal(huntCap(1, HUNT.units), HUNT.cap);
    assert.equal(copsWanted(10_000, n), HUNT.cap);
  });

  it("when the humans run up to a room's eight, then the units and the cap still fit the car list with every human in it", () => {
    for (let humans = 1; humans <= 8; humans++) {
      const units = huntUnits(humans, MAX_CARS - humans);
      assert.ok(humans + units <= MAX_CARS, `${humans} humans + ${units} units`);
      assert.ok(huntCap(humans, units) >= HUNT.cap, `${humans} humans: the cap never falls under a lone player's`);
    }
  });
});

describe("given two humans far apart and a pack hunting them", () => {
  /** Human 0 on the start line, human 1 on the far side of the course. */
  const apart = (k: number) => (k === 0 ? spec.start : { x: spec.start.x + 140, z: spec.start.z - 160 });

  it("when each cop picks a player car to chase, then it is the nearer human: the counts after each human are the cops nearer it", () => {
    const r = rig(2, apart);
    r.run(40);
    const hunting = r.cars.slice(2).filter((c) => c.x !== FAR);
    for (const c of hunting) r.brain.think(c, r.cars, BEAT);
    const nearer = (c: AiCar): number => (Math.hypot(c.x - r.cars[0]!.x, c.z - r.cars[0]!.z) <= Math.hypot(c.x - r.cars[1]!.x, c.z - r.cars[1]!.z) ? 0 : 1);
    const expected = [hunting.filter((c) => nearer(c) === 0).length, hunting.filter((c) => nearer(c) === 1).length];
    assert.ok(expected[0]! > 0 && expected[1]! > 0, `both humans have cops nearer them (${expected})`);
    assert.equal(r.brain.copsOn(0), expected[0]);
    assert.equal(r.brain.copsOn(1), expected[1]);
  });

  it("when a human is no longer free, then every cop is after the other one", () => {
    const r = rig(2, apart);
    r.run(40);
    const hunting = r.cars.slice(2).filter((c) => c.x !== FAR);
    r.hunt[0] = 0;
    for (const c of hunting) r.brain.think(c, r.cars, BEAT);
    assert.equal(r.brain.copsOn(0), 0);
    assert.equal(r.brain.copsOn(1), r.brain.hunting);
  });

  it("when the pack drops cops in, then none lands within a drop-in's distance of either human", () => {
    const r = rig(2, apart);
    r.run(300);
    assert.ok(r.drops.length > spec.formation.length, "cops dropped in after the formation");
    for (const d of r.drops.slice(spec.formation.length)) {
      for (const h of [0, 1]) {
        const gap = Math.hypot(d.x - r.cars[h]!.x, d.z - r.cars[h]!.z);
        assert.ok(gap >= HUNT.dropMin - 1e-6, `drop at ${d.t.toFixed(1)} s landed ${gap.toFixed(1)} m from human ${h}`);
      }
    }
  });
});

/** How near a parked human a spot is in the camera's view (m): inside it a wreck is seen and never put away; the drop-in spots (`HUNT.dropMin` from every human) are all outside it. */
const VIEW = 60;

describe("given a hosted Survival run with every cop that comes into view wrecked and the humans parked", () => {
  for (const humans of [1, 2, 4]) {
    it(`when ${humans} human${humans > 1 ? "s" : ""} wait out 150 s, then the pack never goes more than ${HUNT.gap} s without dropping a cop in, though every unit ends up a wreck in view`, () => {
      const slots = Array.from({ length: humans }, (_, k) => humanSlot(spec.start, k));
      const r = rig(humans, undefined, (x, z) => slots.every((s) => Math.hypot(s.x - x, s.z - z) >= VIEW));
      // A cop that is on the road is wrecked beside the first human: in view, so it is never put away.
      const wreckTheCops = (): void => {
        for (let i = humans; i < r.cars.length; i++) {
          if (r.cars[i]!.x === FAR || r.down.has(i)) continue;
          Object.assign(r.cars[i]!, { x: slots[0]!.x, z: slots[0]!.z });
          r.down.add(i);
        }
      };
      const arrivals: number[] = [];
      for (let t = BEAT; t <= 150; t += BEAT) {
        const before = r.drops.length;
        r.run(t);
        for (const d of r.drops.slice(before)) arrivals.push(d.t);
        wreckTheCops();
      }
      const wait = arrivals.reduce((worst, t, i) => Math.max(worst, t - (arrivals[i - 1] ?? 0)), 150 - (arrivals.at(-1) ?? 0));
      assert.ok(arrivals.length > r.count, `${arrivals.length} cops dropped in from ${r.count} units: the units were never used up and used again`);
      assert.ok(wait <= HUNT.gap + 1e-9, `${wait.toFixed(2)} s without a drop-in`);
    });
  }
});
