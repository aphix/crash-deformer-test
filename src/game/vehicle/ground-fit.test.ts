import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import type { DeformableCar } from "./car.ts";
import { ALONG, COMPASS, report, type Heading, type Kind, type Run, type Site } from "./ground-judge.test-util.ts";
import { drive, drop } from "./ground-probe.test-util.ts";
import { VEHICLE_CLASS_IDS, type VehicleClassId } from "./vehicle-classes.ts";
import { FleetRamps, RAMP } from "../scenes/fleet-ramps.ts";
import { setGround } from "../world/ground.ts";
import { blankPoint, pointOn, Track } from "../world/track.ts";
import { TRACKS } from "../world/tracks/index.ts";

/**
 * The owner's drop matrix, generalising ramp.test.ts's wedge: a car dropped 0.5 m onto each site at every heading, brake
 * and handbrake held for 3 s, must sit ON the ground, whatever the ground is (the judge: ground-judge.test-util.ts). A new
 * site is one line in a table below.
 */

const SEDAN = ["sedan"] as const;
const SEDAN_MONSTER = ["sedan", "monster"] as const;

/**
 * Cells still breaking a bound: a budget that only goes down (main 4677c4b had 272 ramp and 113 bank cells; 7ec7db6 105 and 4; now
 * 20 of 336 ramp cells and 0 of 1078 bank cells). The judge departs from its first form in three ways, measured on 7ec7db6 (336 ramp
 * cells of the 2166):
 * - Ramp drops run 6 s, not 3: a car dropped across an edge is still sliding or rolling at 3 s (60 of the 336 cells above 5 cm/s,
 *   49 at 6 s; one slides 0.86 m between 3 s and 6 s), so a pose read at 3 s is a frame of a motion. 6 s changed the verdict of
 *   4 cells (109 → 105 failing).
 * - A car rolled past 60° rests on its side or roof, where no tyre, pose or slide bound applies (its tyres are metres up). Its whole
 *   hull (underside, bumpers, beltline and roof corners, as the drawn body carries them) must still be out of the ground and of the
 *   walls. It skipped 0 of the 2166 cells on 7ec7db6; with the ramps' wall and ground one rule, 15 ramp cells roll (a car dropped
 *   half on a 0.6–1.1 m ledge falls off it onto its side or roof, where it used to sink into the wedge upright) and 0 elsewhere.
 * - A tyre tilted θ off the ground it stands on rests on its lower tread shoulder, while the sim holds the tread's centre on the
 *   ground: the drawn shoulder digs in by `shoulder · sin θ` (≤ 5 cm sedan, 8.9 cm monster at 30°). That is the one-point tyre's
 *   error, bounded by the tyre's own width, and a tyre that sinks further than it plus 2 cm still fails; it was the verdict of 64
 *   ramp cells on 7ec7db6 (169 → 105 failing; the bank, crest and stopped groups did not change).
 * A face the car lies on yields by its crush (`Fit.crush`); its stock-face hull probes read that much too deep, so pen and overlap
 * allow it.
 * The 20 ramp cells, ten families each mirrored over ±z, are all a car perched across a wedge's edge or corner (sunk 8, float 5, slide 4, pen 9, overlap 9):
 * - Plateau, 45°/315° (4): the tail hangs over the 1.2 m back wall and the rear-left tread's centre is on the side wall's plane (hub x
 *   1.50 m), so the sim, which holds one point per tyre and one more at each of ±45°/±90° of its arc, has the tyre on the floor while
 *   its inner shoulder (the judge probes ±0.104 m) is 29 cm into the corner; the other rear tyre hangs 103 cm (that tilt is 4°).
 * - Mid-face 0.4 m out, 225° (2): the same corner, from the front-left tyre (centre 4 cm behind the back wall, 3 cm inside the side
 *   wall): 26 cm of its shoulder in the top's corner, car at rest 22° nose up.
 * - Rear lip, monster on the edge 135° (1): a tyre 22 cm in and the car tilted 35°; sedan on the edge 180° (1): a hull corner 8.5 cm into
 *   the face edge, a tyre 14 cm in and another 51 cm up (tilt 26°).
 * - Hull point 2.3–4.6 cm into a face's side edge (8 cells: mid-face 0.4 m in at 0°, mid-face 0.4 m out at 45°, monster rear lip 0.4 m in at
 *   0°/180°; the first and last rolled onto their side, 51–68°): a belly or roof corner within the 0.2 m `SKIN` that lets a body point
 *   mount the face, so it is not pushed out of a wall it is that near the top of.
 * - Low end 135°/225° (4): slides of 0.62–0.75 m against 0.5 m down the 15° face from 0.08 m high; nothing in the ground.
 */
const KNOWN_RAMPS = 20;

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

  it("banked turns: stunt bowl, stunt nodes 14-15, rally hairpin, across the road's width and its shoulders", (t) => report(t, bankSites()));
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
