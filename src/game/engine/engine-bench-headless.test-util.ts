import { createHash } from "node:crypto";
import "../kernel/rapier-node.test-util.ts";
import { HudStore } from "../hud/hud-store.ts";
import { setGround } from "../world/ground.ts";
import { CrashEngine } from "./engine.ts";
import { BENCH } from "./bench-measure.ts";
import { BENCH_RACE } from "./engine-bench-plan.ts";
import { element, stubBrowser } from "./engine-headless.test-util.ts";

/** One step a frame: the pacer takes the fine slice, never more than one step a frame, so no frame meets its wall deadline and the steps do not depend on how fast the machine runs. */
const FRAME_S = 1 / 240;

/** The real engine on the city bench's race (`BENCH_RACE`, the bench's seed), nothing drawn, the pacer pinned to the 1/240 s floor. One per process (a second `CrashEngine` never resolves `ready`). */
export async function benchRaceEngine(): Promise<CrashEngine> {
  stubBrowser();
  const engine = new CrashEngine(element(), new HudStore(), element());
  Object.assign(engine["renderer"], { render() {}, compile() {}, compileAsync: () => Promise.resolve() });
  await engine.ready;
  engine.fadeScenes = false;
  engine.toggleRace();
  engine.raceCommand(BENCH_RACE);
  engine["race"].reseed(BENCH.seed);
  engine.raceCommand({ type: "start" });
  engine["seat"].mode = "follow";
  engine.pace.pin = false;
  return engine;
}

export function disposeBenchEngine(engine: CrashEngine): void {
  engine.dispose();
  setGround(null);
}

/** `frames` frames of one step each. */
export function runFrames(engine: CrashEngine, frames: number): void {
  for (let i = 0; i < frames; i++) engine.advance(FRAME_S, { frameDt: FRAME_S });
}

/** A hash of every car's pose and motion, and the pacer's step count: equal for two runs only when the sim ran bit for bit alike. */
export function simDigest(engine: CrashEngine): string {
  const hash = createHash("sha1");
  const cars = engine["live"]();
  const numbers = new Float64Array(cars.length * 14 + 2);
  let k = 0;
  for (const car of cars) {
    const p = car.group.position;
    const q = car.group.quaternion;
    const v = car.velocity;
    const a = car.angular;
    numbers.set([p.x, p.y, p.z, q.x, q.y, q.z, q.w, v.x, v.y, v.z, a.x, a.y, a.z, car.crashed ? 1 : 0], k);
    k += 14;
  }
  numbers[k++] = engine.pace.total;
  numbers[k] = engine["world"].fineCuts;
  hash.update(new Uint8Array(numbers.buffer));
  return hash.digest("hex");
}
