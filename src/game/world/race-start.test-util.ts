import assert from "node:assert/strict";
import { setGround } from "./ground.ts";
import { FRAME, frame, makeWorld } from "./race-world.test-util.ts";

/**
 * Owner, 2026-10-03, on the stunt course: "3 of 5 AI cars become wrecks right at the start and limp around every lap".
 * The grid's two files (4 m stagger, 3-5 m off the middle) all steered for the racing line and met nose to tail there,
 * a shortcut's mouth took two cars abreast, and a pass closed to within a car length. The whole race stack headless,
 * every slot AI-driven, the first seconds of racing watched.
 */
export const WATCH = 10;

/** The racers (the AI-driven player slot and `aiCount` rivals) that wreck in the first `WATCH` s of racing, each with where and against whom. */
export function startWrecks(course: string, seed: number, aiCount: number, slider: number): string[] {
  const w = makeWorld();
  w.race.enter();
  try {
    w.race.command({ type: "quit" });
    w.race.command({ type: "options", options: { trackId: course, laps: 2, aiCount, noReset: false, aggression: slider } });
    w.race.reseed(seed);
    w.race.command({ type: "start" });
    w.seat.mode = "follow";
    let touching = "";
    w.onPairContact = (a, b) => {
      touching = `cars ${a} and ${b}`;
    };
    const state = { acc: 0 };
    const wrecked = new Set<number>();
    const out: string[] = [];
    let raced = 0;
    // The grid and countdown first (bounded), then `WATCH` s of racing.
    for (let n = 0; raced < WATCH && n < 60 * 30; n++) {
      touching = "";
      frame(w, state);
      if (w.race.phase === "racing") raced += FRAME;
      for (let i = 0; i <= aiCount; i++) {
        const car = w.cars[i]!;
        if (!car.crashed || wrecked.has(i)) continue;
        wrecked.add(i);
        out.push(`car ${i} at ${raced.toFixed(2)} s, ${car.velocity.length().toFixed(1)} m/s, ${touching || "wall, prop or traffic"}`);
      }
    }
    assert.ok(raced >= WATCH, `${course} seed ${seed}: the race never got going`);
    return out;
  } finally {
    w.race.exit();
    setGround(null);
  }
}
