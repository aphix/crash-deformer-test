import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { COMPASS, report, type Run, type Site } from "./ground-judge.test-util.ts";
import { drop } from "./ground-probe.test-util.ts";
import { runLine, type Line, type LineRun } from "./ground-run.test-util.ts";
import { CLASSES, VEHICLE_CLASS_IDS, type VehicleClassId } from "./vehicle-classes.ts";
import { setGround } from "../world/ground.ts";
import { Track } from "../world/track.ts";
import { HAVANA } from "../world/tracks/havana.ts";

/**
 * The owner: "ensure wheels are good on the grass and whatnot!" The Survival course's grass embankment, crest, plaza, alley and
 * landing lawn, read through `Ground.heightAt` like every ground: the drop matrix (all 5 classes, 8 headings, ground-judge.test-util.ts)
 * and a drive matrix (each class up the face at 10 / 20 / 30 m/s, from the survival start at full throttle, and 30° across it).
 */

const track = new Track(HAVANA);
const ground = track.ground();
/** The plateau's flat top is 4 m up, centred on the origin: |x| ≤ 12, |z| ≤ 18; its near (+z) face rises over a nominal 16 m from z 34, the far side falls to z -36, all edges rounded over 8 m. */
const START = track.survival!.start;

/** Braked drops at `at` (x, z) at every compass heading, for all five classes. */
function sites(group: readonly (readonly [name: string, x: number, z: number])[]): Site[] {
  return group.map(([name, x, z]) => ({
    name,
    kind: "plain",
    classes: VEHICLE_CLASS_IDS,
    runs: (cls) => COMPASS.map(([h, yaw]): Run => [h, drop(ground, cls, x, z, yaw, { hint: ground.heightAt(x, z) + 0.5 })]),
  }));
}

describe("havana ground fit matrix: a braked car sits on the ground at every heading", () => {
  afterEach(() => setGround(null));

  it("the approach, the foot road and the lawn before the face", (t) =>
    report(t, sites([["approach (0, 300)", 0, 300], ["approach edge (10, 300)", 10, 300], ["approach kerb (14, 300)", 14, 300], ["foot road (0, 52)", 0, 52], ["foot lawn (0, 41)", 0, 41]])));

  it("the grass face: foot, low, mid, high, crest, and the top just past it", (t) =>
    report(t, sites([["face foot (0, 38)", 0, 38], ["face low (0, 33)", 0, 33], ["face mid (0, 27)", 0, 27], ["face high (0, 22)", 0, 22], ["crest (0, 18)", 0, 18], ["crest top (0, 14)", 0, 14], ["face edge (11, 27)", 11, 27]])));

  it("the plaza: the clear strip, the left edge and the slope under it, the corner, the far side", (t) =>
    report(t, sites([["plaza strip (-8, 0)", -8, 0], ["plaza left edge (-12, 0)", -12, 0], ["left slope (-20, 0)", -20, 0], ["left foot (-28, 0)", -28, 0], ["corner (-14, 19)", -14, 19], ["far crest (0, -18)", 0, -18], ["far slope (0, -29)", 0, -29], ["far foot (0, -40)", 0, -40]])));

  it("the alley (cobble beside the slope) and its kerb", (t) => report(t, sites([["alley kerb (-33.5, 0)", -33.5, 0], ["alley (-36.5, 0)", -36.5, 0], ["alley south (-36.5, -30)", -36.5, -30]])));

  it("the landing lawn and the paseo's edge", (t) => report(t, sites([["landing lawn (0, -100)", 0, -100], ["landing lawn (30, -140)", 30, -140], ["paseo kerb (12, -100)", 12, -100], ["ring south (0, -57)", 0, -57]])));
});

/** One drive-matrix row: where the run went and what the ground did to the car. */
type Row = { cls: VehicleClassId; run: string; stopZ: number; r: LineRun };
const f = (v: number, d = 1) => v.toFixed(d);

/** Up the face along x = 0 (heading −z) from `lead` m before its foot (z 36), and across it 30° left to cross the crest (z 18) at x = 0. */
const FOOT: Line = { x: 0, z: 36, yaw: Math.PI };
const DIAG: Line = { x: 0, z: 18, yaw: Math.PI + Math.PI / 6 };
/** A held-speed run ends past the plaza's far side; a full-throttle run past the landing lawn. */
const LIMITS = { crestZ: 26, seconds: 25 };
/** Where the ground starts to rise (z): the face's foot, rounded, begins 8 m before its nominal foot at z 34. */
const FOOT_ROAD = 42;

function driveMatrix(): Row[] {
  const rows: Row[] = [];
  for (const cls of VEHICLE_CLASS_IDS) {
    for (const v of [10, 20, 30]) rows.push({ cls, run: `${v} m/s`, stopZ: -100, r: runLine(ground, cls, FOOT, { ...LIMITS, lead: 60, speed: v, stopZ: -100 }) });
    rows.push({ cls, run: "start, full throttle", stopZ: -200, r: runLine(ground, cls, FOOT, { ...LIMITS, lead: START.z - FOOT.z, speed: "top", stopZ: -200, at: FOOT_ROAD }) });
    rows.push({ cls, run: "30° across, 30 m/s", stopZ: -100, r: runLine(ground, cls, DIAG, { ...LIMITS, lead: 140, speed: 30, stopZ: -100 }) });
    rows.push({ cls, run: "30° across, full throttle", stopZ: -200, r: runLine(ground, cls, DIAG, { ...LIMITS, lead: 200, speed: "top", stopZ: -200 }) });
  }
  return rows;
}

describe("havana drive matrix: every class up the face and over the crest", () => {
  afterEach(() => setGround(null));
  const rows = driveMatrix();

  it("prints the table: crest flight, landing, deepest hull and tyre in the ground", (t) => {
    const lines = ["| class | run | air s | apex m | rise m | takeoff z | landing x, z, surface, m/s | hull cm | grass tyre cm | thrown | killed | end speed | speed at the foot |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|"];
    for (const { cls, run, r } of rows) {
      const land = r.landing ? `${f(r.landing.x)}, ${f(r.landing.z)}, ${r.landing.surface}, ${f(r.landing.speed)}` : "-";
      lines.push(`| ${cls} | ${run} | ${f(r.air, 2)} | ${f(r.apex)} | ${f(r.rise)} | ${r.takeoff ? f(r.takeoff.z) : "-"} | ${land} | ${f(r.pen * 100)} | ${f(r.grass * 100)} | ${r.ejections} | ${r.killedAt === null ? "no" : f(r.killedAt)} | ${f(r.end.speed)} | ${r.speedAt === null ? "-" : `${f(r.speedAt)} (${f((100 * r.speedAt) / CLASSES[cls].topSpeed, 0)} %)`} |`);
    }
    t.diagnostic(`\n${lines.join("\n")}`);
  });

  it("nobody is thrown out, killed or moved but by his own speed, and a class that was given a run finishes it", () => {
    const bad: string[] = [];
    for (const { cls, run, stopZ, r } of rows) {
      if (r.ejections > 0) bad.push(`${cls} ${run}: driver thrown out`);
      if (r.killedAt !== null) bad.push(`${cls} ${run}: engine killed at ${f(r.killedAt)} s`);
      if (r.jump > 0) bad.push(`${cls} ${run}: teleported ${f(r.jump)} m`);
      if (r.end.z > stopZ + 1) bad.push(`${cls} ${run}: stopped at z ${f(r.end.z)} after ${f(r.end.seconds)} s`);
    }
    assert.deepEqual(bad, []);
  });

  it("wheels are good on the grass: no tyre more than 2 cm in it, and no hull more than 2 cm in the ground, on any run", () => {
    const bad: string[] = [];
    for (const { cls, run, r } of rows) {
      if (r.grass > 0.02) bad.push(`${cls} ${run}: a tyre ${f(r.grass * 100)} cm in the grass`);
      if (r.pen > 0.02) bad.push(`${cls} ${run}: the hull ${f(r.pen * 100)} cm in the ground`);
    }
    assert.deepEqual(bad, []);
  });

  it("a crest that launches: on the ground at 10 and 20 m/s, in the air from 30 m/s up, and a full-throttle run clears the plaza and lands beyond the ring road", () => {
    const bad: string[] = [];
    for (const { cls, run, r } of rows) {
      const speed = Number(/^(\d+) m\/s$/.exec(run)?.[1] ?? 99);
      if (speed <= 20) {
        if (r.air > 0) bad.push(`${cls} ${run}: flew ${f(r.air, 2)} s`);
        continue;
      }
      if (r.air < 0.4) bad.push(`${cls} ${run}: only ${f(r.air, 2)} s in the air`);
      if (!r.landing) bad.push(`${cls} ${run}: never landed`);
      else if (run === "start, full throttle" && r.landing.z > -66) bad.push(`${cls} ${run}: landed at z ${f(r.landing.z)}, short of the far side of the ring road`);
    }
    assert.deepEqual(bad, []);
  });
});

describe("havana's approach and its set piece", () => {
  afterEach(() => setGround(null));
  const rows = driveMatrix();
  const start = (cls: VehicleClassId) => rows.find((x) => x.cls === cls && x.run === "start, full throttle")!.r;

  it("the boulevard is long enough that the default class (sedan) reaches 90 % of its top speed at the foot", () => {
    assert.ok(start("sedan").speedAt! >= 0.9 * CLASSES.sedan.topSpeed, `sedan ${f(start("sedan").speedAt!)} of ${f(CLASSES.sedan.topSpeed)} m/s`);
  });

  it("a cop at the player's foot speed launches at the crest, lands on the lawn beyond the island and keeps going", (t) => {
    const foot = start("sedan").speedAt!;
    const r = runLine(ground, "police", FOOT, { ...LIMITS, lead: 60, speed: foot, stopZ: -215, at: FOOT_ROAD });
    t.diagnostic(`police at ${f(foot)} m/s: ${f(r.air, 2)} s in the air, apex ${f(r.apex)} m over the ground (${f(r.rise)} m over the crest), landed at (${f(r.landing!.x)}, ${f(r.landing!.z)}) on ${r.landing!.surface} at ${f(r.landing!.speed)} m/s, ends at z ${f(r.end.z)} doing ${f(r.end.speed)} m/s`);
    assert.ok(r.air > 2 && r.rise > 4, `${f(r.air, 2)} s in the air, ${f(r.rise)} m up`);
    // Beyond the ring road's far side (z -66) and inside the lawn and paseo (z -215), upright and moving.
    assert.ok(r.landing && r.landing.z < -66 && r.landing.z > -215 && Math.abs(r.landing.x) < 90, `landed at ${JSON.stringify(r.landing)}`);
    assert.ok(r.end.z <= -214 && r.end.speed > 0.8 * foot, `stopped or slowed: z ${f(r.end.z)}, ${f(r.end.speed)} m/s`);
    assert.equal(r.jump > 0 || r.ejections > 0 || r.killedAt !== null, false, "no teleport, throw or kill");
  });
});
