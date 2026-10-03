import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { RESULTS_DELAY } from "../engine/engine-race.ts";
import { copsWanted, HUNT } from "../ai/hunter.ts";
import { SURVIVAL } from "../match/survival.ts";
import type { RaceHud } from "../match/types.ts";
import { FRAME, frame, type World } from "./race-world.test-util.ts";
import { Track } from "./track.ts";
import { HAVANA } from "./tracks/havana.ts";
import { chaseCam, hold, leaveSurvival, liveCops, play, steerAt, survivalWorld, visibleFrom } from "./survival-run.test-util.ts";

const spec = new Track(HAVANA).survival!;
const KEY = "crush.survival.best.havana";

/** An in-memory `localStorage`, the browser's key/value store. */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

function useStorage(s: Storage): void {
  Object.defineProperty(globalThis, "localStorage", { value: s, configurable: true, writable: true });
}

/** A wall of building 30 m wide across the boulevard 28 m in front of the start's far side: cops must go round it. */
const WALL = { prefab: "building", x: 0, z: 392, yaw: 0, scale: 1, size: [30, 14, 14] };
const WALLED = { ...(HAVANA as object), props: [WALL] };

function hud(w: World): ReturnType<World["race"]["hud"]> {
  return w.race.hud();
}

/** Frames until `done`, at most `max` s of game time. */
function until(w: World, state: { acc: number }, max: number, done: () => boolean): void {
  for (let n = 0; n * FRAME < max && !done(); n++) frame(w, state);
}

/** Run the countdown out: the green is up. */
function toGreen(w: World, state: { acc: number }): void {
  until(w, state, 8, () => w.race.phase === "racing");
  assert.equal(w.race.phase, "racing");
}

/** Advance `seconds` of game time with the scripted player holding still. */
function sit(w: World, state: { acc: number }, seconds: number): void {
  for (let n = 0; n * FRAME < seconds; n++) {
    hold(w);
    frame(w, state);
  }
}

describe("survival run", () => {
  beforeEach(() => useStorage(memoryStorage()));
  afterEach(() => Reflect.deleteProperty(globalThis, "localStorage"));

  it("starts on the course: the player on its start, the formation behind it, the rest of the pack away, held until the green", () => {
    const w = survivalWorld();
    try {
      const p = w.cars[0]!.group.position;
      assert.ok(Math.hypot(p.x - spec.start.x, p.z - spec.start.z) < 0.01, `player at ${p.x},${p.z}`);
      spec.formation.forEach((f, k) => {
        const c = w.cars[1 + k]!;
        assert.ok(c.group.visible && Math.hypot(c.group.position.x - f.x, c.group.position.z - f.z) < 0.01, `cop ${k} is not on its slot`);
      });
      for (let i = 1 + spec.formation.length; i < w.live().length; i++) assert.ok(!w.cars[i]!.group.visible, `spare cop ${i} is on the road`);
      assert.equal(w.live().length, 1 + HUNT.units);
      const h = hud(w);
      assert.equal(h.survival?.cops, spec.formation.length);
      assert.equal(h.survival?.best, null);
      assert.equal(h.noReset, true);
      assert.equal(h.phase, "grid");

      // The countdown is the race's (grid, red-yellow-green); the cops do not move before it.
      const state = { acc: 0 };
      const where = w.cars.slice(1, 6).map((c) => c.group.position.clone());
      const phases = new Set<string>();
      while (w.race.phase !== "racing") {
        hold(w);
        frame(w, state);
        phases.add(w.race.phase ?? "");
        w.cars.slice(1, 6).forEach((c, k) => assert.ok(c.group.position.distanceTo(where[k]!) < 0.3, `cop ${k} moved before the green`));
      }
      assert.deepEqual([...phases].sort(), ["countdown", "grid", "racing"]);
      // After the green they come.
      sit(w, state, 2);
      assert.ok(w.cars[1]!.group.position.distanceTo(where[0]!) > 5, "the cops did not leave on the green");
    } finally {
      leaveSurvival(w);
    }
  });

  it("busts the player after the survival hold (12 s) pinned slow near a cop, and not before", () => {
    assert.equal(SURVIVAL.bustTime, 12);
    const w = survivalWorld(WALLED);
    try {
      const state = { acc: 0 };
      toGreen(w, state);
      // The player sits 80 m down the boulevard, behind the wall, on the handbrake.
      w.cars[0]!.spawnFacing(0, 340, Math.PI, 0);
      let held = 0;
      let bustedAfter = -1;
      let longest = 0;
      for (let n = 0; n * FRAME < 60 && bustedAfter < 0; n++) {
        hold(w);
        frame(w, state);
        const me = w.cars[0]!;
        const near = liveCops(w).some((i) => Math.hypot(w.cars[i]!.group.position.x - me.group.position.x, w.cars[i]!.group.position.z - me.group.position.z) <= 20);
        held = near && me.velocity.length() * 3.6 < 20 ? held + FRAME : 0;
        longest = Math.max(longest, held);
        if (hud(w).you?.busted) bustedAfter = held;
        else assert.ok(held < SURVIVAL.bustTime + 0.05, `held ${held.toFixed(2)} s and not busted`);
      }
      assert.ok(bustedAfter >= 0, `never busted (longest hold ${longest.toFixed(1)} s)`);
      assert.ok(bustedAfter >= SURVIVAL.bustTime - 0.05 && bustedAfter < SURVIVAL.bustTime + 0.3, `busted after holding ${bustedAfter.toFixed(2)} s`);
      const h = hud(w);
      assert.equal(h.phase, "finished", "the run ends on the bust");
      assert.equal(h.survival?.result?.cause, "busted");
      assert.equal(h.you?.status, "out");
    } finally {
      leaveSurvival(w);
    }
  });

  it("ends the run when the car is wrecked (driver thrown out), with the time, the cause and a results card after the banner", () => {
    const w = survivalWorld();
    try {
      const state = { acc: 0 };
      toGreen(w, state);
      sit(w, state, 3);
      const wreckedAt = w.race.time;
      w.cars[0]!.driverOut = "windshield";
      sit(w, state, 0.2);
      let h = hud(w);
      assert.equal(h.phase, "finished");
      assert.equal(h.you?.status, "out");
      assert.equal(h.you?.busted, false);
      const r = h.survival?.result;
      assert.ok(r, "no result");
      assert.equal(r.cause, "wrecked");
      assert.ok(Math.abs(r.time - wreckedAt) < 0.1, `time ${r.time} vs wrecked at ${wreckedAt}`);
      assert.equal(r.isNew, true);
      assert.equal(h.menu, null, "the banner shows before the card");
      sit(w, state, RESULTS_DELAY + 0.2);
      h = hud(w);
      assert.equal(h.menu, "results");
      assert.equal(h.survival?.result?.time, r.time);
    } finally {
      leaveSurvival(w);
    }
  });

  it("keeps the best time per course: a new best is stored and flagged, a worse run leaves it, a blocked store still ends the run", () => {
    const w = survivalWorld();
    try {
      const state = { acc: 0 };
      const runUntil = (seconds: number): NonNullable<NonNullable<RaceHud["survival"]>["result"]> => {
        toGreen(w, state);
        const start = w.race.time;
        while (w.race.time - start < seconds) {
          hold(w);
          frame(w, state);
        }
        w.cars[0]!.driverOut = "windshield";
        sit(w, state, 0.2);
        return hud(w).survival!.result!;
      };
      const a = runUntil(3);
      assert.equal(a.isNew, true);
      assert.equal(Number(localStorage.getItem(KEY)), a.time, "the first run's time is the best");

      w.race.command({ type: "retry" });
      assert.equal(hud(w).survival?.best, a.time, "the run in play shows the best before it");
      assert.equal(hud(w).survival?.result, null);
      const b = runUntil(1.5);
      assert.equal(b.isNew, false);
      assert.equal(b.best, a.time);
      assert.equal(Number(localStorage.getItem(KEY)), a.time, "a worse run must not overwrite the best");

      w.race.command({ type: "retry" });
      const c = runUntil(5);
      assert.equal(c.isNew, true);
      assert.ok(c.time > a.time);
      assert.equal(Number(localStorage.getItem(KEY)), c.time);

      // Storage off (site data blocked): the run still ends with its result.
      useStorage({ ...memoryStorage(), getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
      w.race.command({ type: "retry" });
      assert.equal(hud(w).survival?.best, null, "an unreadable best reads as none");
      const d = runUntil(2);
      assert.equal(d.isNew, true);
      assert.equal(d.cause, "wrecked");
    } finally {
      leaveSurvival(w);
    }
  });

  it("Retry starts a fresh run (formation back, clock at the grid, scene cleared); Quit leaves the scene", () => {
    const w = survivalWorld();
    try {
      const state = { acc: 0 };
      toGreen(w, state);
      sit(w, state, 2);
      w.cars[0]!.driverOut = "windshield";
      sit(w, state, 0.2);
      assert.equal(hud(w).phase, "finished");
      const clears = w.clears;
      w.race.command({ type: "retry" });
      assert.equal(w.clears, clears + 1, "the last run's wreckage must be cleared");
      const h = hud(w);
      assert.equal(h.phase, "grid");
      assert.equal(h.survival?.cops, spec.formation.length);
      assert.equal(h.survival?.wrecked, 0);
      assert.equal(h.you?.busted, false);
      assert.equal(w.cars[0]!.driverOut, null, "the driver is back in the car");
      const p = w.cars[0]!.group.position;
      assert.ok(Math.hypot(p.x - spec.start.x, p.z - spec.start.z) < 0.01);
      assert.equal(w.leaves, 0);
      w.race.command({ type: "quit" });
      assert.equal(w.leaves, 1, "Quit in Survival goes back to the fleet, not to a course menu");
    } finally {
      leaveSurvival(w);
    }
  });

  it("escalates while the player lasts: the pack follows the schedule, up to the cap", () => {
    const w = survivalWorld();
    try {
      const pts = ringTour();
      const r = play(w, { seconds: 90, player: tour(pts), retry: true });
      const runs = new Map<number, number[]>();
      for (const g of r.gaps) {
        // Halfway between two schedule steps (and past the 1.5 s drop gap) the pack has what the schedule wants.
        const frac = (g.time % HUNT.every) / HUNT.every;
        if (frac > 0.3 && frac < 0.8) runs.set(Math.floor(g.time / HUNT.every), [...(runs.get(Math.floor(g.time / HUNT.every)) ?? []), g.cops - copsWanted(g.time, spec.formation.length)]);
        assert.ok(g.cops <= HUNT.cap, `${g.cops} cops at ${g.time.toFixed(0)} s`);
      }
      const steps = [...runs.keys()].sort((a, b) => a - b);
      assert.ok(steps.includes(0) && steps.some((s) => s >= 2), `the run never lasted past two schedule steps (${steps.join(",")}; ends ${JSON.stringify(r.ends)})`);
      // A cop wrecked or lost is dropped in again, so the pack is never more than a couple short of the schedule.
      for (const [step, errs] of runs) assert.ok(Math.min(...errs) >= -3 && Math.max(...errs) <= 0, `step ${step}: pack minus schedule ${errs.join(",")}`);
    } finally {
      leaveSurvival(w);
    }
  });
});

describe("survival: cops dropped in are never seen to appear", () => {
  it("the camera's own test can see a car in front of it (the check below is not blind)", () => {
    const w = survivalWorld();
    try {
      const state = { acc: 0 };
      toGreen(w, state);
      chaseCam(w);
      const car = w.cars[0]!.group.position;
      const f = w.cars[0]!.fwdFlat;
      assert.equal(visibleFrom(w, car.x + f.x * 30, car.z + f.z * 30), true, "a spot 30 m ahead of the chase camera must be visible");
      assert.equal(visibleFrom(w, car.x - f.x * 60, car.z - f.z * 60), false, "a spot 60 m behind the chase camera is out of its view");
      // And a solid between hides what the frustum covers.
      const camera: THREE.PerspectiveCamera = w.camera;
      assert.ok(camera.position.distanceTo(w.cars[0]!.group.position) < 10);
    } finally {
      leaveSurvival(w);
    }
  });

  it("over 5 minutes of scripted play, no cop appears in the camera's view", (t) => {
    const w = survivalWorld();
    try {
      useStorage(memoryStorage());
      const r = play(w, { seconds: 300, player: tour(ringTour()), retry: true });
      const seen = r.spawns.filter((s) => s.visible);
      t.diagnostic(`${r.spawns.length} drop-ins in ${r.seconds.toFixed(0)} s over ${r.ends.length + 1} runs (ends ${r.ends.map((e) => `${e.cause}@${e.t.toFixed(0)}`).join(" ")}), nearest ${Math.min(...r.spawns.map((s) => s.dist)).toFixed(0)} m, ${seen.length} visible`);
      assert.ok(r.spawns.length >= 12, `only ${r.spawns.length} drop-ins: the invariant would be vacuous`);
      assert.deepEqual(seen, [], `cops appeared in view: ${JSON.stringify(seen.slice(0, 3))}`);
      assert.ok(r.spawns.every((s) => s.dist >= HUNT.dropMin - 1e-6), "a drop-in closer than the minimum");
    } finally {
      Reflect.deleteProperty(globalThis, "localStorage");
      leaveSurvival(w);
    }
  });
});

/** Waypoints round the ring road, every 18 m. */
function ringTour(): [number, number][] {
  const p = new Track(HAVANA).path;
  const pts: [number, number][] = [];
  for (let k = 0; k < p.count; k += 18) pts.push([p.x[k]!, p.z[k]!]);
  return pts;
}

/** The scripted player: round the ring at 22 m/s, steering at the next waypoint. */
function tour(pts: readonly (readonly [number, number])[]): (w: World) => void {
  let i = 0;
  return (w) => {
    const car = w.cars[0]!.group.position;
    if (Math.hypot(pts[i]![0] - car.x, pts[i]![1] - car.z) < 14) i = (i + 1) % pts.length;
    steerAt(w, pts[i]![0], pts[i]![1], 22);
  };
}
