import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { RESULTS_DELAY } from "../engine/engine-race.ts";
import { copsWanted, HUNT } from "../ai/hunter.ts";
import { COUNTDOWN, GRID_TIME } from "../match/session.ts";
import { SURVIVAL } from "../match/survival.ts";
import type { RaceHud } from "../match/types.ts";
import { FRAME, frame, type World } from "./race-world.test-util.ts";
import { Track } from "./track.ts";
import { HAVANA } from "./tracks/havana.ts";
import { assertDropInsHidden, chaseCam, dropInsAtPoses, hold, leaveSurvival, liveCops, play, survivalWorld, visibleFrom } from "./survival-run.test-util.ts";
import { drivers } from "./survival-players.test-util.ts";

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

/** The survival hold (s) the bust test runs with, shortened from the owner's. */
const BUST_HOLD = 3;

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

  it("when the player sits still on its start as the pack closes in, then the run ends, and a bust never comes before the survival hold", () => {
    // The hold is shortened (its own constant) so the pack's box-in and the bust fit in seconds; the owner's 12 s is the session test's (`match/survival.test.ts`).
    const owner = SURVIVAL.bustTime;
    Reflect.set(SURVIVAL, "bustTime", BUST_HOLD);
    const w = survivalWorld();
    try {
      const state = { acc: 0 };
      toGreen(w, state);
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
      // The frame-end count cannot see a shove's spike inside a frame (it restarts the real hold), so it may run past the hold before
      // the bust, never short of it. The exact bust time is the session test's (`match/survival.test.ts`).
      assert.ok(cause === "busted" || cause === "wrecked", `cause ${cause}`);
      if (cause === "busted") assert.ok(heldAtBust >= SURVIVAL.bustTime - 0.05, `busted after holding only ${heldAtBust.toFixed(2)} s`);
      else assert.equal(h.you?.busted, false);
    } finally {
      leaveSurvival(w);
      Reflect.set(SURVIVAL, "bustTime", owner);
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

  it("when the player lasts through the first two schedule steps, then the HUD's pack count follows the schedule (the cap and the long run are the hunter unit test's)", () => {
    const w = survivalWorld();
    try {
      // The evading driver (`drivers("evade")`): a player out to stay alive. The ring tour at a fixed 16 m/s lasted to step 1 only while the pack's
      // ram near (3.7, 216) at about 14 s missed it, which a 1 cm start shift or 8 ms of frame phase flips either way on any drive.
      const r = play(w, { seconds: GREEN_S + 2 * HUNT.every - 1, player: drivers("evade", 1) });
      const runs = new Map<number, number[]>();
      for (const g of r.gaps) {
        // Halfway between two schedule steps (and past the 1.5 s drop gap) the pack has what the schedule wants.
        const frac = (g.time % HUNT.every) / HUNT.every;
        const step = Math.floor(g.time / HUNT.every);
        if (frac > 0.3 && frac < 0.8) runs.set(step, [...(runs.get(step) ?? []), g.cops - copsWanted(g.time, spec.formation.length)]);
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

/** The green comes this long (s) after the world is built: the grid, then the countdown. */
const GREEN_S = GRID_TIME + COUNTDOWN;
/** The places round the course a cop is dropped in at, and the speed the scripted player drives at (m/s). */
const POSES = 12;
const DRIVE_SPEED = 16;

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

  it("when a cop drops in with the player driving at 16 m/s at each of 12 places round the course, then it lands out of the chase camera's view and no nearer than the minimum drop distance", (t) => {
    const w = survivalWorld();
    try {
      const r = dropInsAtPoses(w, new Track(HAVANA).path, POSES, DRIVE_SPEED);
      t.diagnostic(`${r.spawns.length} drop-ins in ${r.seconds.toFixed(0)} s, nearest ${Math.min(...r.spawns.map((s) => s.dist)).toFixed(0)} m, ${r.spawns.filter((s) => s.visible).length} visible`);
      assertDropInsHidden(r, POSES);
    } finally {
      leaveSurvival(w);
    }
  });
});
