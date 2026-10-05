import { it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "./car.ts";
import { newWorld, settleStep, stepWorld } from "../engine/world-step.ts";
import { forModes, paint } from "./test-support.ts";
import type { DeformMode } from "../deform/deform-rig.ts";

/**
 * Tearing a part off, breaking a lamp and cracking glass are decided by the sim's steps, never by how often the
 * renderer draws: the same crash at 60, 144 or 240 Hz, or drawn never, keeps the same parts on the same car at every
 * step. Before `stepBreakage` they ran in `updateDeform`, once per rendered frame (a replay drew at another rate than
 * the live sim it re-ran, and a player's frame cadence moved a hinge's tear by whole frames).
 */
const STEP = 1 / 240;
const STEPS = 420;
const HEAD = Math.PI / 2;

type PartRow = { name: string; detached: boolean; hingeT: number };
type Row = { parts: PartRow[]; lamps: { intact: boolean }[]; glass: string[] };

/** Every car's part, lamp and glass state, rounded as `snapshot()` rounds them. */
function state(cars: readonly DeformableCar[]): string {
  return JSON.stringify(
    cars.map((c) => {
      const s = c.snapshot() as unknown as Row;
      return { parts: s.parts.map((p) => [p.name, p.detached, p.hingeT]), lamps: s.lamps.map((l) => l.intact), glass: s.glass };
    }),
  );
}

/** A 2 x 20 m/s head-on, stepped `STEPS` times, drawn at `hz` (0: never); the state after every step. */
function crash(mode: DeformMode, hz: number): string[] {
  const scene = new THREE.Scene();
  const cars = [0, 1].map((i) => {
    const car = new DeformableCar(paint(), scene);
    car.deform.setMode(mode);
    car.spawnFacing(i * 9, 0, i === 0 ? HEAD : -HEAD, 20);
    return car;
  });
  const w = newWorld(cars);
  const timeline: string[] = [];
  let sinceDraw = 0;
  for (let s = 0; s < STEPS; s++) {
    stepWorld(w, STEP);
    settleStep(cars, STEP, false);
    sinceDraw += STEP;
    if (hz > 0 && sinceDraw >= 1 / hz - 1e-9) {
      for (const car of cars) car.updateSkin();
      sinceDraw = 0;
    }
    timeline.push(state(cars));
  }
  for (const car of cars) car.dispose();
  return timeline;
}

/** The step (`STEPS` if never) a state first differs from the first step's: something tore, broke or cracked. */
const firstChange = (t: string[]): number => {
  const k = t.findIndex((x) => x !== t[0]);
  return k < 0 ? STEPS : k;
};

forModes("given a 20 m/s head-on between two cars, simulated for 420 steps of 1/240 s", (mode) => {
  it("when the crash is drawn at 60, 144 or 240 Hz or never drawn, then the same parts are torn off, lamps broken and glass cracked at every step, and at least one part does come off", () => {
    const never = crash(mode, 0);
    const changes = firstChange(never);
    assert.ok(changes < STEPS, `[${mode}] nothing tore, broke or cracked in ${STEPS} steps: the test would pass for any rate`);
    const parts = (JSON.parse(never[STEPS - 1]!) as { parts: [string, boolean, number][] }[]).flatMap((c) => c.parts.filter((p) => p[1]));
    assert.ok(parts.length >= 1, `[${mode}] no part came off: ${parts.length}`);
    for (const hz of [60, 144, 240]) {
      const t = crash(mode, hz);
      for (let s = 0; s < STEPS; s++) assert.equal(t[s], never[s], `[${mode}] ${hz} Hz differs from undrawn at step ${s} (the first change is at ${changes})`);
    }
  });
});
