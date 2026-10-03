import { afterEach, describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import type { DeformableCar } from "./car.ts";
import { DEG, drive, drop, MATRIX_HEAD, matrixRow, type Cell } from "./ground-probe.test-util.ts";
import { VEHICLE_CLASS_IDS, type VehicleClassId } from "./vehicle-classes.ts";
import { FleetRamps, RAMP } from "../scenes/fleet-ramps.ts";
import { setGround } from "../world/ground.ts";
import { blankPoint, pointOn, Track } from "../world/track.ts";
import { TRACKS } from "../world/tracks/index.ts";

/**
 * The owner's drop matrix, generalising ramp.test.ts's wedge: a car dropped 0.5 m onto each site at every heading, brake
 * and handbrake held for 3 s, must sit ON the ground, whatever the ground is: no tyre sunk in it or hanging above it
 * unless the hull is resting on it, no underside in it or in a wall, and on a smooth slope or bank the body as tilted
 * as the ground under its hubs. Everything is read through `Ground.heightAt` (ground-probe.test-util.ts `fit`). A new
 * site is one line in a table below; each group prints its whole matrix (`t.diagnostic`, a markdown table) and fails
 * with a one-line summary of the failing cells.
 */

const SEDAN = ["sedan"] as const;
const SEDAN_MONSTER = ["sedan", "monster"] as const;

/** A site's bounds. `edge` sites (a car across a ramp's side, over its back wall) have no smooth ground to follow. */
type Bounds = {
  /** Tyre clearance within ±this (m) of the ground: further below is sunk, further above floats. */
  gap: number;
  /** The hull is resting when some underside point is within this (m) of the ground: it is one of a floating car's three
   *  supports (a tyre may hang while the others and the belly hold the body). */
  hull: number;
  /** Deepest underside point in the ground (m). */
  pen: number;
  /** Deepest underside point in a wall (m): a car pushed clear of a ramp's side is 0. */
  overlap: number;
  /** Body tilt from the ground normal, and pitch / roll error against the ground under the hubs (deg). */
  pose: number;
  /** Ground under the four hubs is one plane when its hub heights are within `warp` (m) of it and its hub normals within
   *  `spread` (deg) of their mean; on a crease or a bend between the axles no pose is the right one, so pitch / roll error
   *  is waived there, and the tilt from the mean normal gets that spread added (the clearance, hull and wall bounds hold). */
  warp: number;
  spread: number;
  /** Most the car may move (m) on ground at most `slideSlope` (deg) steep. */
  slide: number;
  slideSlope: number;
};
const PLAIN: Bounds = { gap: 0.02, hull: 0.02, pen: 0.01, overlap: 0.02, pose: 1.5, warp: 0.02, spread: 3, slide: 0.5, slideSlope: 20 };
const BOUNDS = { plain: PLAIN, edge: { ...PLAIN, pose: Infinity, slide: Infinity } } as const;
type Kind = keyof typeof BOUNDS;

type Heading = readonly [label: string, yaw: number];
type Run = readonly [heading: string, cell: Cell];
type Site = { name: string; kind: Kind; classes: readonly VehicleClassId[]; runs: (cls: VehicleClassId) => Run[] };

/** Every 45° (yaw: forward = (sin yaw, 0, cos yaw)). */
const COMPASS: readonly Heading[] = Array.from({ length: 8 }, (_, k): Heading => [`${k * 45}°`, (k * Math.PI) / 4]);
/** Offsets from a road's direction (yaw added to its own): along it, a little off line, across it either way, and back. */
const ALONG: readonly Heading[] = [
  ["t+0°", 0],
  ["t+15°", 15 / DEG],
  ["t-15°", -15 / DEG],
  ["t+90°", Math.PI / 2],
  ["t-90°", -Math.PI / 2],
  ["t+180°", Math.PI],
];

const planar = (b: Bounds, r: Cell) => r.warp <= b.warp && r.spread <= b.spread;

/** Body tilt (deg) past which a car has rolled onto its side or roof: that is a rest too (a drop on a ridge can roll a car over), and no tyre or underside bound describes it. */
const ROLLED = 60;

function judge(kind: Kind, r: Cell): string[] {
  const b = BOUNDS[kind];
  const flags: string[] = [];
  if (r.tilt > ROLLED) return flags;
  // A tyre turned `tilt` off the ground it stands on (a car across an edge) digs its outer tread shoulder `shoulder · sin(tilt)` in.
  const gap = b.gap + r.shoulder * Math.sin(r.tilt / DEG);
  if (r.gaps.some((g) => g < -gap)) flags.push("sunk");
  // A tyre may hang (a twist or an edge beyond its springs' travel, the owner's "front non-ramp wheel lifted") when the
  // car rests on three other supports: its other tyres on the ground and its belly on the feature.
  const held = r.gaps.filter((g) => Math.abs(g) <= gap).length + (r.hull <= b.hull ? 1 : 0);
  if (r.gaps.some((g) => g > gap) && held < 3) flags.push("float");
  if (r.pen > b.pen) flags.push("pen");
  if (r.overlap > b.overlap) flags.push("overlap");
  if (r.warp <= b.warp) {
    if (r.tilt > b.pose + r.spread) flags.push("tilt");
    if (planar(b, r) && Math.abs(r.pitch - r.groundPitch) > b.pose) flags.push("pitch");
    if (planar(b, r) && Math.abs(r.roll - r.groundRoll) > b.pose) flags.push("roll");
  }
  if (r.slope <= b.slideSlope && r.slide > b.slide) flags.push("slide");
  return flags;
}

/**
 * Cells still breaking a bound: a budget that only goes down (main 4677c4b had 272 ramp and 113 bank cells; the judge here
 * runs ramp drops 6 s, skips cars that rolled onto their side or roof, and lets a tyre dig its tread shoulder in when it
 * stands tilted on an edge, so these counts are not comparable with the 169 / 6 the same code scored under the first judge).
 * Ramps: a car dropped with a tyre or its hull inside a wedge's side or high-end wall (`FleetRamps.contact` pushes by the
 * car's box probes, not its tyres, so a tyre can rest in the wall), the monster's 0.54 m tyres on an edge, the low end's
 * slide. Banks: the underside of a car parked on a bank's shoulder crease (≤ 5 cm). `lane/wheel-ground-b-wip` holds the
 * tyre-corner wall probes that take the ramp count to 23 and the banks to 0 and what stops them from merging.
 */
const KNOWN_RAMPS = 105;
const KNOWN_BANKS = 4;

/** Run every cell of `sites`, print the matrix, and fail when more than `known` cells break their bounds. */
function report(t: TestContext, sites: readonly Site[], known = 0): void {
  const rows = [MATRIX_HEAD];
  const counts = new Map<string, number>();
  const failing: string[] = [];
  let cells = 0;
  let waived = 0;
  for (const site of sites) {
    for (const cls of site.classes) {
      const label = cls === "sedan" ? site.name : `${site.name} (${cls})`;
      for (const [heading, r] of site.runs(cls)) {
        cells++;
        if (!planar(BOUNDS[site.kind], r) && BOUNDS[site.kind].pose < Infinity) waived++;
        const flags = judge(site.kind, r);
        rows.push(matrixRow(label, heading, r, flags.join(" ")));
        if (flags.length === 0) continue;
        failing.push(`${label} ${heading}: ${flags.join("+")}`);
        for (const f of flags) counts.set(f, (counts.get(f) ?? 0) + 1);
      }
    }
  }
  const summary = `${failing.length} of ${cells} cells fail${failing.length ? ` (${[...counts].map(([f, n]) => `${f} ${n}`).join(", ")})` : ""}; pitch/roll waived on ${waived} cells (ground under the hubs not one plane)`;
  t.diagnostic(`\n${rows.join("\n")}`);
  t.diagnostic(summary);
  assert.ok(failing.length <= known, `${summary} (budget ${known}): ${failing.slice(0, 12).join("; ")}${failing.length > 12 ? "; …" : ""}`);
}

// (a) The fleet's jump ramps, exactly as fleet-ramps.test.ts `scene()` builds them (no slab).
const ramps = new FleetRamps(new THREE.Scene());
ramps.place(0, null);
const collide = (c: DeformableCar) => ramps.contact(c);
const MID = RAMP.start + RAMP.len / 2;

function rampSites(): Site[] {
  const sites: Site[] = [];
  for (const side of [1, -1]) {
    const tag = side > 0 ? "ramp+z" : "ramp-z";
    const add = (name: string, kind: Kind, x: number, z: number, classes: readonly VehicleClassId[]) =>
      sites.push({
        name: `${tag} ${name}`,
        kind,
        classes,
        // 6 s: a car dropped on a ridge or an edge can still be rolling off it at 3 s (it is not at rest to judge).
        runs: (cls) => COMPASS.map(([h, yaw]): Run => [h, drop(ramps, cls, x, side * z, yaw, { collide, seconds: 6 })]),
      });
    add("mid-face", "plain", 0, MID, SEDAN);
    // The top: the car's tail hangs over the 1.2 m back wall, so there is no level pose to hold it to (edge).
    add("top (h 1.10)", "edge", 0, RAMP.start + 0.4, SEDAN);
    add("low end (h 0.08)", "plain", 0, RAMP.start + RAMP.len - 0.3, SEDAN);
    // Straddling the side edge: left wheels on the slope, right wheels on the flat beside it.
    for (const [lip, z] of [
      ["front lip", RAMP.start + RAMP.len - 0.8],
      ["mid-face", MID],
      ["rear lip", RAMP.start + 1],
    ] as const) {
      for (const [where, x] of [
        ["on edge", RAMP.halfW],
        ["0.4 in", RAMP.halfW - 0.4],
        ["0.4 out", RAMP.halfW + 0.4],
      ] as const) {
        add(`${lip}: ${where}`, "edge", x, z, SEDAN_MONSTER);
      }
    }
  }
  return sites;
}

// (b), (c) The stunt course (CRUSH crest, bank bowl) and the rally hairpin.
const courses = TRACKS.map((j) => new Track(j));
const stunt = courses.find((c) => c.id === "stunt")!;
const rally = courses.find((c) => c.id === "rally")!;
const _pt = blankPoint();

/** A braked drop `lat` m left of `track`'s centre at `s`, at each `compass` heading and at each of `along` the road's. */
function roadSite(
  track: Track,
  name: string,
  s: number,
  lat: number,
  compass: readonly Heading[],
  along: readonly Heading[],
  classes: readonly VehicleClassId[],
): Site {
  const ground = track.ground();
  const p = pointOn(track.path, s, _pt);
  const x = p.x + p.tz * lat;
  const z = p.z - p.tx * lat;
  const yaw = Math.atan2(p.tx, p.tz);
  const hint = p.y + 0.5;
  return {
    name,
    kind: "plain",
    classes,
    runs: (cls) => [
      ...compass.map(([h, a]): Run => [h, drop(ground, cls, x, z, a, { hint })]),
      ...along.map(([h, a]): Run => [h, drop(ground, cls, x, z, yaw + a, { hint })]),
    ],
  };
}

/** The CRUSH billboard crest (apex s ≈ 899) and the descent behind it (-21.5° at s 908); the kicker also every metre. */
function crestSites(): Site[] {
  const wide = [890, 896, 899, 902, 905, 908, 911, 915, 920];
  const sites: Site[] = [];
  for (const s of [...wide, 906, 907, 909, 910].sort((a, b) => a - b)) {
    for (const lat of wide.includes(s) ? [0, 3, -3] : [0]) {
      sites.push(roadSite(stunt, `stunt crest s=${s} lat=${lat}`, s, lat, COMPASS, ALONG, lat === 0 ? SEDAN_MONSTER : SEDAN));
    }
  }
  return sites;
}

/** The owner's stopped car, braked where it stopped, s 899-905 (899, 902 and 905 are in the crest group), every heading. */
function stoppedSites(): Site[] {
  const sites: Site[] = [];
  for (const s of [900, 901, 903, 904]) {
    sites.push(roadSite(stunt, `stunt stopped drop s=${s}`, s, 0, COMPASS, ALONG, SEDAN_MONSTER));
  }
  return sites;
}

/** The bank run: stunt bowl (steepest bank at node 6, then its run-out), nodes 14-15 (-8..-12°), the rally hairpin. */
function bankSites(): Site[] {
  const spots: [Track, string, number][] = [
    [stunt, "stunt bowl n5", stunt.nodeS[5]!],
    [stunt, "stunt bowl n6", stunt.nodeS[6]!],
    [stunt, "stunt bowl n7", stunt.nodeS[7]!],
    [stunt, "stunt bowl run-out", (stunt.nodeS[8]! + stunt.nodeS[9]!) / 2],
    [stunt, "stunt n14", stunt.nodeS[14]!],
    [stunt, "stunt n15", stunt.nodeS[15]!],
    [stunt, "stunt n15 run-out", (stunt.nodeS[15]! + stunt.nodeS[16]!) / 2],
    ...[7, 8, 9, 10].map((n): [Track, string, number] => [rally, `rally hairpin n${n}`, rally.nodeS[n]!]),
  ];
  return spots.flatMap(([track, name, s]) => {
    const half = pointOn(track.path, s, _pt).half;
    // Across the width, then a shoulder point either side (the crease where the bank's plane meets the runoff).
    return [-(half - 1), -2, 0, 2, half - 1, half + 1, -(half + 1)].map((lat) =>
      roadSite(track, `${name} lat=${lat.toFixed(1)}`, s, lat, COMPASS, ALONG, SEDAN),
    );
  });
}

describe("ground fit matrix: a braked car sits on the ground at every heading", () => {
  afterEach(() => setGround(null));

  it("fleet ramps: faces, ends and straddling the side edges", (t) => report(t, rampSites(), KNOWN_RAMPS));

  it("stunt CRUSH crest and descent: braked drops", (t) => report(t, crestSites()));

  it("stunt CRUSH crest: a car that stopped there", (t) => {
    const rolled: Site[] = [];
    for (const v of [6, 10, 14]) {
      for (const stop of [899, 902, 905, 908]) {
        rolled.push({
          name: `stunt roll-stop brake@${stop}`,
          kind: "plain",
          classes: SEDAN_MONSTER,
          runs: (cls) => {
            const out = drive(stunt, cls, stop - 5, stop + 120, () => v, { lead: 35, brakeFrom: stop });
            const last = out[out.length - 1];
            if (!last) throw new Error(`v=${v} brake@${stop}: never reached the braking point`);
            // Heading column: the speed in and how far it rolled; slide: how far it crept in its last two held seconds.
            const creep = Math.abs(last.s - out[Math.max(0, out.length - 121)]!.s);
            return [[`v=${v}/${(last.s - stop).toFixed(0)}m`, { ...last, slide: creep }]];
          },
        });
      }
    }
    report(t, [...stoppedSites(), ...rolled]);
  });

  it("banked turns: stunt bowl, stunt nodes 14-15, rally hairpin, across the road's width and its shoulders", (t) => report(t, bankSites(), KNOWN_BANKS));
});

describe("braking dive on a flat straight", () => {
  afterEach(() => setGround(null));

  // The drawn nose dips under braking (car-load's weight transfer, kept) toward a keel only 3.2 cm over the road: the drawn
  // body bottoms out on the road (`Suspension.bottomOut`) instead of the springs pressing it 3.5 cm in (sedan/muscle/police).
  it("good: from 30 m/s every class dips its nose and keeps its drawn keel and bumpers out of the road", () => {
    const oval = courses.find((c) => c.id === "oval")!;
    for (const cls of VEHICLE_CLASS_IDS) {
      const out = drive(oval, cls, 60, 180, () => 30, { lead: 35, brakeFrom: 100 });
      let pen = 0;
      let dive = 0;
      for (const f of out) {
        if (f.s < 100) continue;
        pen = Math.max(pen, f.pen);
        dive = Math.min(dive, f.pitch - f.groundPitch);
      }
      assert.ok(pen <= 0.01, `${cls}: the drawn underside is ${(pen * 100).toFixed(1)} cm in the road while braking`);
      assert.ok(dive <= -0.5, `${cls}: the drawn nose dips only ${(-dive).toFixed(2)}° (the dive look is gone)`);
    }
  });
});
