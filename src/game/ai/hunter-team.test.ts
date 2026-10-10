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
 * The pack on a stub world for `humans` humans: cars 0 … humans − 1 are the quarry, on the start slots (`humanSlot`) or where `at` puts them; the units
 * follow, `huntUnits` of them. Every spot is hidden from the camera, so a drop-in is only ever refused by the pack's own rules.
 */
function rig(humans: number, at: (k: number) => { x: number; z: number } = (k) => humanSlot(spec.start, k)) {
  const count = huntUnits(humans, MAX_CARS - humans);
  const cars: AiCar[] = Array.from({ length: humans + count }, (_, i) => {
    const slot = i < humans ? at(i) : { x: FAR, z: FAR };
    return { ...blankAiCar(i), x: slot.x, z: slot.z, yaw: spec.start.yaw };
  });
  const hunt = new Uint8Array(MAX_CARS);
  hunt.fill(1, 0, humans);
  const drops: { t: number; id: number; x: number; z: number }[] = [];
  let now = GREEN;
  const world: HunterWorld = {
    park: (id, x, _y, z, yaw) => {
      Object.assign(cars[id]!, { x, z, yaw, vx: 0, vz: 0 });
      drops.push({ t: now, id, x, z });
    },
    store: (id) => Object.assign(cars[id]!, { x: FAR, z: FAR }),
    seen: () => false,
    hidden: () => true,
    down: () => false,
    sirens: () => {},
  };
  const brain = new HunterBrain(track, [], humans, humans, count, 5);
  brain.launch(world);
  const run = (until: number): void => {
    for (; now < until - 1e-9; now += BEAT) {
      brain.update(now, BEAT, cars, hunt, 0, world);
      // Each cop drives a beat, as in the game: its quarry (`aim`) is the nearest free human at that moment.
      for (let i = humans; i < cars.length; i++) if (cars[i]!.x !== FAR) brain.think(cars[i]!, cars, BEAT);
    }
  };
  run(0);
  return { brain, cars, hunt, drops, run, count };
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

  it("when each cop picks its quarry, then it is the nearer human: the counts after each human are the cops nearer it", () => {
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
