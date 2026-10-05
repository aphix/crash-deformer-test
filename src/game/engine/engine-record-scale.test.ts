import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { launch, makeCar, makeWorld } from "../contact/crash-scenarios.test-util.ts";
import { BARRIER_HALF } from "../contact/sat.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import { MIN_SCORE, TOP, type CrashCluster } from "../match/highlights.ts";
import { CrashRecorder } from "./engine-record.ts";
import { settleStep, stepWorld } from "./world-step.ts";

/**
 * Highlight scores through the real sim: two sedans (or one and the jersey slab) crash at a set closing speed, the
 * recorder scores the cluster. Scores scale with impact force (`impactWeight`): hits above 50 km/h count for more,
 * below it for less.
 */
const H = 1 / 240;

/** The recorder over `cars` for `seconds`; `wall`: the slab's first touch is reported as a wall hit at that closing speed (m/s). The clusters it closed, ranked or not, and the recorder. */
function record(cars: DeformableCar[], barrier: boolean, seconds: number, wall?: number): { clusters: CrashCluster[]; rec: CrashRecorder } {
  const w = makeWorld(cars, barrier, false);
  const rec = new CrashRecorder();
  rec.begin("flat", 0.35, false, cars.length, (i) => `c${i}`, 1);
  const clusters: CrashCluster[] = [];
  const due = rec.ledger.due.bind(rec.ledger);
  rec.ledger.due = (t, force) => {
    const c = due(t, force);
    if (c) clusters.push(c);
    return c;
  };
  w.world.pairHit = (a, b, hit, first) => rec.pairHit(a, b, hit, first);
  let touching = false;
  for (let s = 0; s < seconds / H; s++) {
    rec.startStep(cars);
    stepWorld(w.world, H);
    const now = !!w.world.barrierHits[0];
    if (wall !== undefined && now && !touching) rec.wallHit(0, wall, BARRIER_HALF.x, 0);
    touching = now;
    for (const e of w.world.ejection?.take() ?? []) rec.eject(e);
    rec.endStep(cars, H, w.world.shape);
    settleStep(cars, H, false);
    for (const car of cars) car.updateSkin();
  }
  rec.end();
  return { clusters, rec };
}

/** Two sedans nose to nose at `v` m/s closing (each half), `z` lanes apart from the origin. */
function placeHeadOn(a: DeformableCar, b: DeformableCar, v: number, z = 0, x = 0): void {
  launch(a, x - 5, z, Math.PI / 2, v / 2, 0);
  launch(b, x + 5, z, -Math.PI / 2, -v / 2, 0);
}

const headOn = (closingKph: number): CrashCluster => {
  const [a, b] = [makeCar(), makeCar()] as const;
  placeHeadOn(a, b, closingKph / 3.6);
  return record([a, b], false, 3).clusters[0]!;
};

const tBone = (closingKph: number): CrashCluster => {
  const [a, b] = [makeCar(), makeCar()] as const;
  launch(a, 0, 0, 0, 0, 0);
  launch(b, 6, 0, -Math.PI / 2, -closingKph / 3.6, 0);
  return record([a, b], false, 3).clusters[0]!;
};

/** A square front hit on the slab: the single cluster, or none. */
const wallHit = (speedKph: number, overlap = 1): CrashCluster | undefined => {
  const car = makeCar();
  const z = overlap < 1 ? BARRIER_HALF.z + 0.88 * (1 - 2 * overlap) : 0;
  launch(car, 6.2, z, -Math.PI / 2, -speedKph / 3.6, 0);
  return record([car], true, 3, speedKph / 3.6).clusters[0];
};

const SWEEP = [20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 130];

describe("highlight score scales with impact force (real sim)", () => {
  it("bad: the score rises strictly with the closing speed, head-on and T-bone, from a 20 km/h tap to 130 km/h", () => {
    for (const [name, crash] of [
      ["head-on", headOn],
      ["T-bone", tBone],
    ] as const) {
      const scores = SWEEP.map((v) => crash(v).score);
      scores.forEach((s, i) => {
        if (i > 0) assert.ok(s > scores[i - 1]!, `${name}: ${SWEEP[i]} km/h scores ${s.toFixed(2)}, not above ${SWEEP[i - 1]} km/h's ${scores[i - 1]!.toFixed(2)} (${scores.map((x) => x.toFixed(1)).join(" ")})`);
      });
    }
    const wall = [40, 56, 80].map((v) => wallHit(v, 0.4)!.score);
    assert.ok(wall[0]! < wall[1]! && wall[1]! < wall[2]!, `offset wall 40/56/80 km/h: ${wall.map((x) => x.toFixed(1)).join(" ")}`);
  });

  it("bad: a 100 km/h head-on scores 3.5–5× a 50 km/h one; the 50 km/h reference keeps its old score", () => {
    const at50 = headOn(50).score;
    const at100 = headOn(100).score;
    assert.ok(Math.abs(at50 - 3.65) < 0.02, `the 50 km/h reference moved: ${at50.toFixed(2)} (was 3.65)`);
    assert.ok(at100 / at50 >= 3.5 && at100 / at50 <= 5, `100 km/h ${at100.toFixed(2)} vs 50 km/h ${at50.toFixed(2)}: ×${(at100 / at50).toFixed(2)}`);
  });

  it("bad: a 20 km/h bump scores under half of MIN_SCORE and a 40 km/h head-on misses the reel; 50 km/h still makes it", () => {
    const tap = headOn(20);
    assert.ok(tap.score < MIN_SCORE / 2, `20 km/h bump scores ${tap.score.toFixed(2)}`);
    assert.ok(headOn(40).score < MIN_SCORE, `a 40 km/h head-on scores ${headOn(40).score.toFixed(2)}, under MIN_SCORE ${MIN_SCORE}`);
    assert.ok(headOn(50).score >= MIN_SCORE, "a 50 km/h head-on still makes the reel");
  });

  it("bad: a race of seven head-ons keeps the TOP 5 hardest, ordered by severity, and not the soft ones", () => {
    const speeds = [20, 100, 45, 80, 60, 90, 70];
    const cars = speeds.flatMap(() => [makeCar(), makeCar()]);
    speeds.forEach((v, k) => placeHeadOn(cars[2 * k]!, cars[2 * k + 1]!, v / 3.6, k * 200));
    const { rec } = record(cars, false, 4);
    const kept = rec.ledger.kept;
    assert.equal(kept.length, TOP);
    assert.deepEqual(
      kept.map((c) => Math.round(c.peakKph)),
      [100, 90, 80, 70, 60],
      `the reel: ${kept.map((c) => `${c.peakKph.toFixed(0)} km/h = ${c.score.toFixed(1)}`).join(", ")}`,
    );
    kept.forEach((c, i) => {
      if (i > 0) assert.ok(c.score < kept[i - 1]!.score, "best first");
    });
  });

  it("bad: the softest ejection (a 55 km/h wall hit) outranks the hardest hit that spares the engines (109 km/h head-on); a harder throw ranks higher", () => {
    const spared = headOn(109);
    assert.equal(spared.kills, 0, "109 km/h head-on must still spare both engines for this to be the hardest spared hit");
    const soft = wallHit(55)!;
    const hard = wallHit(80)!;
    assert.ok(soft.ejects === 1 && hard.ejects === 1, `wall 55/80 km/h throw ${soft.ejects}/${hard.ejects} drivers`);
    assert.ok(soft.score > spared.score * 1.5, `55 km/h wall throw ${soft.score.toFixed(1)} vs 109 km/h head-on ${spared.score.toFixed(1)}`);
    assert.ok(hard.score > soft.score, `80 km/h throw ${hard.score.toFixed(1)} vs 55 km/h throw ${soft.score.toFixed(1)}`);
  });
});
