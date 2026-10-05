import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { launch, makeCar, makeWorld } from "../contact/crash-scenarios.test-util.ts";
import { BARRIER_HALF } from "../contact/sat.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import { clipTitle, MIN_SCORE, TOP, type CrashCluster } from "../match/highlights.ts";
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

const SWEEP = [50, 60, 70, 80, 90, 100, 110, 130];

describe("given the highlight recorder scoring crashes between real simulated sedans (or a sedan and the jersey slab)", () => {
  it("when the closing speed rises from 50 km/h to 130 km/h, then the score rises strictly with it for head-ons and T-bones, and for offset wall hits at 50, 56 and 80 km/h", () => {
    for (const [name, crash] of [
      ["head-on", headOn],
      ["T-bone", tBone],
    ] as const) {
      const scores = SWEEP.map((v) => crash(v).score);
      scores.forEach((s, i) => {
        if (i > 0) assert.ok(s > scores[i - 1]!, `${name}: ${SWEEP[i]} km/h scores ${s.toFixed(2)}, not above ${SWEEP[i - 1]} km/h's ${scores[i - 1]!.toFixed(2)} (${scores.map((x) => x.toFixed(1)).join(" ")})`);
      });
    }
    const wall = [50, 56, 80].map((v) => wallHit(v, 0.4)!.score);
    assert.ok(wall[0]! < wall[1]! && wall[1]! < wall[2]!, `offset wall 50/56/80 km/h: ${wall.map((x) => x.toFixed(1)).join(" ")}`);
  });

  it("when a 100 km/h head-on is scored against a 50 km/h one, then it scores 3.5 to 5 times as much, and the 50 km/h one keeps its score of 3.65", () => {
    const at50 = headOn(50).score;
    const at100 = headOn(100).score;
    assert.ok(Math.abs(at50 - 3.65) < 0.02, `the 50 km/h reference moved: ${at50.toFixed(2)} (was 3.65)`);
    assert.ok(at100 / at50 >= 3.5 && at100 / at50 <= 5, `100 km/h ${at100.toFixed(2)} vs 50 km/h ${at50.toFixed(2)}: ×${(at100 / at50).toFixed(2)}`);
  });

  it("when 20 and 40 km/h head-ons are recorded, then they fall under the minimum impact speed and open no cluster, while a 50 km/h head-on still scores enough for the highlight reel", () => {
    for (const kph of [20, 40]) {
      const [a, b] = [makeCar(), makeCar()] as const;
      placeHeadOn(a, b, kph / 3.6);
      assert.equal(record([a, b], false, 3).clusters.length, 0, `a ${kph} km/h head-on opened a cluster`);
    }
    assert.ok(headOn(50).score >= MIN_SCORE, "a 50 km/h head-on still makes the reel");
  });

  it("when a race has seven head-ons from 20 to 100 km/h, then the five hardest are kept, best first, and the softest two are dropped", () => {
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

  it("when the softest driver ejection (a 55 km/h wall hit) is scored against the hardest hit that spares both engines (a 109 km/h head-on), then the ejection scores more than 1.5 times as much, and an 80 km/h wall throw scores higher still", () => {
    const spared = headOn(109);
    assert.equal(spared.kills, 0, "109 km/h head-on must still spare both engines for this to be the hardest spared hit");
    const soft = wallHit(55)!;
    const hard = wallHit(80)!;
    assert.ok(soft.ejects === 1 && hard.ejects === 1, `wall 55/80 km/h throw ${soft.ejects}/${hard.ejects} drivers`);
    assert.ok(soft.score > spared.score * 1.5, `55 km/h wall throw ${soft.score.toFixed(1)} vs 109 km/h head-on ${spared.score.toFixed(1)}`);
    assert.ok(hard.score > soft.score, `80 km/h throw ${hard.score.toFixed(1)} vs 55 km/h throw ${soft.score.toFixed(1)}`);
  });
});

/** Two head-on pairs 20 m apart (one cluster by distance), each closing at `v` m/s: four cars hit. */
const fourCars = (v: number, extra = 0): { clusters: CrashCluster[]; rec: CrashRecorder } => {
  const cars = Array.from({ length: 4 + extra }, () => makeCar());
  placeHeadOn(cars[0]!, cars[1]!, v, 0, 0);
  placeHeadOn(cars[2]!, cars[3]!, v, 0, 20);
  // Idle cars within the bystander radius: in the clip's replay, never in a hit.
  for (let k = 0; k < extra; k++) launch(cars[4 + k]!, 40 + 8 * k, 40, Math.PI / 2, 0, 0);
  return record(cars, false, 4);
};

describe("given four cars in two head-on pairs 20 m apart, and the minimum closing speed any impact must reach to count", () => {
  it("when they bump at 9 m/s (32 km/h), then no cluster, no clip and no pile-up is made", () => {
    const { clusters, rec } = fourCars(9);
    assert.equal(clusters.length, 0, `${clusters.length} cluster(s) opened by 32 km/h bumps`);
    assert.equal(rec.ledger.kept.length, 0, "no clip");
  });

  it("when they hit at 20 m/s (72 km/h), then a clip is still made, titled a 4-car pile-up", () => {
    const { rec } = fourCars(20);
    const [clip] = rec.ledger.kept;
    assert.ok(clip, "the fast pile-up made no clip");
    assert.equal(clip.hit, 4, "four cars hit");
    assert.equal(clipTitle(clip), "4-car pile-up");
  });
});

describe("given a two-car head-on at 72 km/h with six idle cars standing close enough to be in the clip's shot", () => {
  it("when the crash is recorded, then the clip's title is a smash (it counts the two cars hit, not the idle cars in the shot) and the idle cars are bystanders", () => {
    const cars = Array.from({ length: 8 }, () => makeCar());
    placeHeadOn(cars[0]!, cars[1]!, 20);
    for (let k = 2; k < 8; k++) launch(cars[k]!, 40 + 8 * k, 40, Math.PI / 2, 0, 0);
    const [clip] = record(cars, false, 4).rec.ledger.kept;
    assert.ok(clip, "the 72 km/h head-on made no clip");
    assert.ok(clip.cars.length > 2, `${clip.cars.length} cars in the clip: the idle ones are bystanders`);
    assert.equal(clip.hit, 2);
    assert.equal(clipTitle(clip), `${Math.round(clip.peakKph)} km/h smash`);
  });
});
