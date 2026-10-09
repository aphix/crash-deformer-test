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

describe("given a Survival run on the Havana course (the player against a pack of cops), with an in-memory best-time store", () => {
  beforeEach(() => useStorage(memoryStorage()));
  afterEach(() => Reflect.deleteProperty(globalThis, "localStorage"));

  it("when the world is built, then the player stands on the course's start, the formation behind it and the rest of the pack away, and everyone is held still until the green", () => {
    const w = survivalWorld();
    try {
      const p = w.cars[0]!.group.position;
      assert.ok(Math.hypot(p.x - spec.start.x, p.z - spec.start.z) < 0.01, `player at ${p.x},${p.z}`);
      for (const [k, f] of spec.formation.entries()) {
        const c = w.cars[1 + k]!;
        assert.ok(c.group.visible && Math.hypot(c.group.position.x - f.x, c.group.position.z - f.z) < 0.01, `cop ${k} is not on its slot`);
      }
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
        for (const [k, c] of w.cars.slice(1, 6).entries()) assert.ok(c.group.position.distanceTo(where[k]!) < 0.3, `cop ${k} moved before the green`);
      }
      assert.deepEqual([...phases].sort(), ["countdown", "grid", "racing"]);
      // After the green they come.
      sit(w, state, 2);
      assert.ok(w.cars[1]!.group.position.distanceTo(where[0]!) > 5, "the cops did not leave on the green");
    } finally {
      leaveSurvival(w);
    }
  });

  it("when the player sits still beside the cops, then the run ends, and a bust never comes before the 12 s survival hold", () => {
    assert.equal(SURVIVAL.bustTime, 12);
    const w = survivalWorld(WALLED);
    try {
      const state = { acc: 0 };
      toGreen(w, state);
      // The player sits 80 m down the boulevard, behind the wall, on the handbrake.
      w.cars[0]!.spawnFacing(0, 340, Math.PI, 0);
      let held = 0;
      let heldAtBust = -1;
      let longest = 0;
      for (let n = 0; n * FRAME < 60 && hud(w).phase !== "finished"; n++) {
        hold(w);
        frame(w, state);
        const me = w.cars[0]!;
        const near = liveCops(w).some((i) => Math.hypot(w.cars[i]!.group.position.x - me.group.position.x, w.cars[i]!.group.position.z - me.group.position.z) <= 20);
        held = near && me.velocity.length() * 3.6 < 20 ? held + FRAME : 0;
        longest = Math.max(longest, held);
        if (hud(w).you?.busted && heldAtBust < 0) heldAtBust = held;
      }
      const h = hud(w);
      assert.equal(h.phase, "finished", `the run never ended (longest hold ${longest.toFixed(1)} s)`);
      assert.equal(h.you?.status, "out");
      const cause = h.survival?.result?.cause;
      // The cops may wreck a car that sits there before the hold runs out (they ram it); the bust, when it comes, is never early.
      // The frame-end count cannot see a shove's spike inside a frame (it restarts the real hold), so it may run past 12 s before
      // the bust, never short of it. The exact bust time is the session test's (`match/survival.test.ts`).
      assert.ok(cause === "busted" || cause === "wrecked", `cause ${cause}`);
      if (cause === "busted") assert.ok(heldAtBust >= SURVIVAL.bustTime - 0.05, `busted after holding only ${heldAtBust.toFixed(2)} s`);
      else assert.equal(h.you?.busted, false);
    } finally {
      leaveSurvival(w);
    }
  });

  it("when the car is wrecked (the driver thrown out), then the run ends with the time, the cause and a results card shown after the banner", () => {
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

  it("when runs end one after another, then a new best is stored and flagged, a worse run leaves the best alone, and a blocked store still ends the run", () => {
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

  it("when the player picks Retry after a finished run, then a fresh run starts (formation back, clock at the grid, scene cleared), and Quit leaves the scene", () => {
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

  it("when the player lasts through the schedule steps, then the HUD's pack count follows the schedule (the cap and the long run are the hunter unit test's)", () => {
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
      assert.ok(steps.includes(0) && steps.includes(1), `no run lasted past the first schedule step (${steps.join(",")}; ends ${JSON.stringify(r.ends)})`);
      // A cop wrecked or lost is dropped in again, so the pack is never more than a couple short of the schedule.
      for (const [step, errs] of runs) assert.ok(Math.min(...errs) >= -3 && Math.max(...errs) <= 0, `step ${step}: pack minus schedule ${errs.join(",")}`);
    } finally {
      leaveSurvival(w);
    }
  });
});

describe("given Survival's cops dropped in during a run", () => {
  it("when a car sits in front of the chase camera, then the camera's own visibility check sees it, so the check below is not blind", () => {
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

  it("when 5 minutes of scripted play run, then no dropped-in cop ever appears in the camera's view, and none lands closer than the minimum drop distance", (t) => {
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

/**
 * The scripted player's speeds (m/s), one per run in turn. It was 22: the ring's 90° corner is more than the car turns at that speed, so it ran off the road into a stucco block
 * at 18 m/s closing (65 km/h), which a solid now crushes and ejects the driver from as the range's slab does, wrecking the player at the same spot every
 * run; the runs ended 14.5 s apart and too few cops dropped in to check anything (1 drop-in against the 12 the guard needs). Measured at 16: 46 drop-ins.
 * A Retry puts the run back exactly on this tree (the same cops, the same start: run after run is bit-identical; on main a retry differs from the first run from the
 * first second, 0.3 m at 1 s), and at 16 m/s the player rams a cop slowed ahead of it at 6.6 s (main wrecks the same way at the same place in its first run, and at
 * 5.3-5.5 s in the next three), so on this tree every retry at one speed ended there. A human does not repeat a run to the digit: each run takes the next speed.
 * Measured from the start over 45 s: 15.5, 16.5, 16.75 and 17.5 m/s survive here (main: 15.25 and 17-17.5 survive, 16.5 wrecks at 31 s, 16.75 at 40 s); 16 is the 6.6 s wreck on both.
 */
const TOUR_SPEEDS = [16, 16.5, 15.5, 17.5, 16.75];

/** The scripted player: round the ring at the run's speed (`TOUR_SPEEDS`), steering at the next waypoint, starting with the waypoint nearest to where it is (waypoint 0 lies across a stucco block from the start: the car drove into it and sat there until the cops finished it). */
function tour(pts: readonly (readonly [number, number])[]): (w: World) => void {
  let i = -1;
  let run = 0;
  let lastTime = 0;
  return (w) => {
    const car = w.cars[0]!.group.position;
    // A Retry starts the clock over: the next run, from the waypoint nearest to where the car stands now.
    if (w.race.time < lastTime - 1) {
      run++;
      i = -1;
    }
    lastTime = w.race.time;
    if (i < 0) i = pts.reduce((best, q, k) => (Math.hypot(q[0] - car.x, q[1] - car.z) < Math.hypot(pts[best]![0] - car.x, pts[best]![1] - car.z) ? k : best), 0);
    if (Math.hypot(pts[i]![0] - car.x, pts[i]![1] - car.z) < 14) i = (i + 1) % pts.length;
    steerAt(w, pts[i]![0], pts[i]![1], TOUR_SPEEDS[run % TOUR_SPEEDS.length]!);
  };
}
