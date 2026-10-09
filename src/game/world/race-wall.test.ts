import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "./ground.ts";
import { FRAME, frame, makeWorld, type World } from "./race-world.test-util.ts";
import { Track, blankProjection } from "./track.ts";
import { placeProps, propColliders, type PropCollider } from "./placements.ts";
import { wallColliders } from "./track-sections.ts";
import { TRACKS } from "./tracks/index.ts";
import { parseTrack } from "./track-schema.ts";
import { applyDrive, type DriveInput } from "../vehicle/car-drive.ts";
import { bodyPoints } from "../vehicle/body-points.test-util.ts";
import { makeCar } from "../vehicle/ground-probe.test-util.ts";
import { physicsSlice, sliceSpeed } from "../contact/sat.ts";
import { FOOT_HALF_L, FOOT_HALF_W } from "../vehicle/car-mesh.ts";
import { newWorld, settleStep, stepWorld } from "../engine/world-step.ts";
import type { DeformableCar } from "../vehicle/car.ts";

/**
 * Owner-facing symptom (TurnSmooth, 10-04): on the city course a car "jumps along the road". The course wall pushed a car up to
 * 3 m in ONE physics step at the back alley's exit: a car arriving beyond the wall line from another road (the alley, 13 m
 * from the loop's centreline) had its footprint probes read as 2.9 m of penetration, undone in full. A car coming from the road
 * side only ever penetrates by a step of travel, so any bigger pose change is not a wall push, it is a teleport.
 */
const SLACK = 0.15;
/** Most a wall may move a car in one step: what the step's travel explains (twice, for the bounce), never under `SLACK`. */
const bound = (speed: number, h: number): number => Math.max(SLACK, 2 * speed * h);

function raceWorld(course: string, aiCount: number): World {
  const w = makeWorld();
  w.race.enter();
  w.race.command({ type: "quit" });
  w.race.command({ type: "options", options: { trackId: course, laps: 3, aiCount, noReset: false } });
  w.race.reseed(1);
  w.race.command({ type: "start" });
  w.seat.mode = "follow";
  return w;
}

/**
 * The back alley's last 12 m before the loop's wall line, as the measured trace drove it (x 167, z 26 at yaw 2.48): 13 m from
 * the loop's centreline, probes 2.9 m beyond the line where the wall's flag is still set (it opens at node 21, z 26).
 */
const ALLEY = { x: 159.55, z: 35.7, yaw: 2.48 };

type Push = { t: number; car: number; moved: number; allowed: number };

/** Runs `secs` of sim from the `start` command and returns every collide-step pose change beyond what its travel explains. */
function overPushes(w: World, secs: number): Push[] {
  const out: Push[] = [];
  const state = { acc: 0 };
  let t = 0;
  let h = 0;
  const hit = w.step.collide!;
  w.step.collide = (car, i, step) => {
    const x = car.group.position.x;
    const z = car.group.position.z;
    const speed = Math.hypot(car.velocity.x, car.velocity.z);
    hit(car, i, step);
    const moved = Math.hypot(car.group.position.x - x, car.group.position.z - z);
    const allowed = bound(speed, h);
    if (moved > allowed) out.push({ t, car: i, moved, allowed });
  };
  for (let n = 0; n < secs / FRAME; n++) {
    frame(w, state, (step) => {
      h = step;
      t += step;
    });
  }
  return out;
}

const fmt = (pushes: Push[]): string =>
  pushes
    .slice(0, 6)
    .map((p) => `t=${p.t.toFixed(1)} car ${p.car} moved ${p.moved.toFixed(3)} m (allowed ${p.allowed.toFixed(3)})`)
    .join("; ");

describe("given a city race of 5 cars (4 AI rivals and the AI-driven player slot) through the real stack, where the course wall must push a car by a step of travel and never teleport it", () => {
  // The city's wall pushed car 4 by 3.0 m at 23.6 s of this race (5 AI cars, seed 1), 17 more over 120 s.
  it("when the race runs for 40 s, then no car is moved further than its step's travel explains", () => {
    const w = raceWorld("city", 4);
    try {
      const pushes = overPushes(w, 40);
      assert.deepEqual(pushes, [], fmt(pushes));
    } finally {
      w.race.exit();
      setGround(null);
    }
  });
});

describe("given a lone car in the city race, racing down the back alley to its exit at 29 m/s with the throttle held", () => {
  it("when it reaches the exit, then it is not thrown across the loop's wall line: no wall push moves it further than its step's travel explains", () => {
    const w = raceWorld("city", 0);
    try {
      const car = w.cars[0]!;
      // Racing (the countdown holds the cars), then straight down the alley with the throttle held.
      w.seat.mode = "drive";
      w.seat.carIndex = 0;
      w.seat.intent.analogGas = true;
      w.seat.intent.gas = 1;
      const state = { acc: 0 };
      for (let n = 0; w.race.phase !== "racing" && n < 60 * 30; n++) frame(w, state);
      assert.equal(w.race.phase, "racing");
      car.spawnFacing(ALLEY.x, ALLEY.z, ALLEY.yaw, 29);
      const pushes = overPushes(w, 2.5);
      assert.deepEqual(pushes, [], fmt(pushes));
    } finally {
      w.race.exit();
      setGround(null);
    }
  });
});

describe("given a lone car in the city race driving at 20 m/s along the loop with its footprint 0.7 m past the wall line, in an open mouth 7 samples before a wall starts", () => {
  // Measured: 0.82 m at 28 m/s (city, 54 s) and 0.18 m (rally) where a wall starts under a car whose footprint is already past the line.
  it("when the wall starts under it, then the wall moves it no more than its step's travel", () => {
    const w = raceWorld("city", 0);
    try {
      const track = new Track(TRACKS.find((j) => parseTrack(j).id === "city"));
      const p = track.path;
      let k = 1;
      while (!(!p.wallL[k - 1] && p.wallL[k] && p.wallL[k + 12] && p.wallL[k + 2])) k++;
      const limit = p.half[k]! + p.runL[k]!;
      // Seven samples before the wall starts, the footprint 0.7 m past the line (the car's flank is 0.95 m off its middle).
      const j = k - 7;
      const lat = limit - 0.25;
      const car = w.cars[0]!;
      w.seat.mode = "drive";
      w.seat.carIndex = 0;
      w.seat.intent.analogGas = true;
      w.seat.intent.gas = 1;
      const state = { acc: 0 };
      for (let n = 0; w.race.phase !== "racing" && n < 60 * 30; n++) frame(w, state);
      car.spawnFacing(p.x[j]! + p.tz[j]! * lat, p.z[j]! - p.tx[j]! * lat, Math.atan2(p.tx[j]!, p.tz[j]!), 20);
      const pushes = overPushes(w, 1);
      assert.deepEqual(pushes, [], fmt(pushes));
    } finally {
      w.race.exit();
      setGround(null);
    }
  });
});

describe("given a lone car in the city race on a walled stretch of the loop, 2 m inside the wall line on the road side", () => {
  it("when it is shoved 1.35 m toward the wall in one step (a car-car shove, five times a slice's passes at their cap), its flank 0.3 m into the 0.6 m wall, then the wall returns it to the road, having left it alone before the shove", () => {
    const w = raceWorld("city", 0);
    try {
      const track = new Track(TRACKS.find((j) => parseTrack(j).id === "city"));
      const p = track.path;
      // A stretch of the loop walled on the left for 10 samples either side.
      let k = 20;
      while (!Array.from({ length: 21 }, (_, d) => p.wallL[(k + d - 10 + p.count) % p.count]).every(Boolean)) k++;
      const limit = p.half[k]! + p.runL[k]!;
      const lat = (at: number) => track.project(w.cars[0]!.group.position.x, w.cars[0]!.group.position.z, k, blankProjection()).lateral - at;
      const car = w.cars[0]!;
      car.spawnFacing(p.x[k]! + p.tz[k]! * (limit - 2), p.z[k]! - p.tx[k]! * (limit - 2), Math.atan2(p.tx[k]!, p.tz[k]!), 0);
      w.race.courseHit(car, 0, 1 / 120);
      assert.ok(Math.abs(lat(limit - 2)) < 0.05, "on the road side, the wall leaves the car alone");
      // A car-car shove: 1.35 m toward the wall in one step, the flank 0.3 m into the drawn wall and the car's middle still on the
      // road side of it. (A one-step shove of 3.5 m, this test's old one, carried the middle past the whole wall: through it.)
      car.group.position.x += p.tz[k]! * 1.35;
      car.group.position.z -= p.tx[k]! * 1.35;
      w.race.courseHit(car, 0, 1 / 120);
      const back = lat(0);
      assert.ok(back < limit - 0.9 && back > limit - 3, `returned to ${back.toFixed(2)} m, the wall line at ${limit.toFixed(2)} m`);
    } finally {
      w.race.exit();
      setGround(null);
    }
  });
});

describe("given a lone car in the city race on a walled stretch of the loop with no solid prop near, first on the road and then 2.8 m beyond the wall line", () => {
  // A replay keyframe puts a car on its recorded spot with the course memory the record held (`ClipSim` -> `remember`): a car the
  // live race had just placed holds no road segment.
  it("when a replay keyframe puts it beyond the wall line, clear of the wall, and another then puts it with its footprint just into the wall from the road side, then the first is not pushed (it stands outside the wall) and the second is pushed back by its footprint's depth in the drawn wall", () => {
    const w = raceWorld("city", 0);
    try {
      const track = new Track(TRACKS.find((j) => parseTrack(j).id === "city"));
      const p = track.path;
      // A walled stretch (10 samples either side) with no prop within a car's length of the three poses below: a prop would push the car too.
      const props = propColliders(placeProps(track));
      const free = (j: number) =>
        [-2, -0.9, 2.8].every((d) => {
          const lat = p.half[j]! + p.runL[j]! + d;
          return props.every((c) => Math.hypot(c.x - (p.x[j]! + p.tz[j]! * lat), c.z - (p.z[j]! - p.tx[j]! * lat)) > c.r + 2 * FOOT_HALF_L);
        });
      let k = 20;
      while (k < p.count && !(free(k) && Array.from({ length: 21 }, (_, d) => p.wallL[(k + d - 10 + p.count) % p.count]).every(Boolean))) k++;
      assert.ok(k < p.count, "the city has a walled stretch with no prop near");
      const limit = p.half[k]! + p.runL[k]!;
      const car = w.cars[0]!;
      const lateral = () => track.project(car.group.position.x, car.group.position.z, k, blankProjection()).lateral;
      const put = (lat: number) => car.spawnFacing(p.x[k]! + p.tz[k]! * lat, p.z[k]! - p.tx[k]! * lat, Math.atan2(p.tx[k]!, p.tz[k]!), 0);
      // On the road first (the course hint finds this stretch), then 2.8 m beyond the line: its footprint (0.95 m to a side)
      // clear of the 0.6 m wall behind the line.
      put(limit - 2);
      w.race.courseHit(car, 0, 1 / 120);
      put(limit + 2.8);
      w.race.courseHit(car, 0, 1 / 120);
      assert.ok(Math.abs(lateral() - (limit + 2.8)) < 0.01, `a car outside the wall is not pushed (now ${lateral().toFixed(2)} m, line ${limit.toFixed(2)} m)`);
      // A keyframe puts it 3.7 m back, its flank 0.05 m into the drawn wall: freshly placed, and the wall returns it that far.
      // (The old line probe read 0.13 m: it measured the front probes across the bend in the frame of the car's middle.)
      put(limit - 0.9);
      const depth = footDepth(car);
      w.race.remember(0, Float64Array.of(-1), 0);
      w.race.courseHit(car, 0, 1 / 120);
      const pushed = limit - 0.9 - lateral();
      assert.ok(depth > 0.03 && Math.abs(pushed - depth) < 0.01, `the placed car, ${depth.toFixed(3)} m into the wall, is pushed back ${pushed.toFixed(3)} m`);
    } finally {
      w.race.exit();
      setGround(null);
    }
  });
});

/**
 * Owner's highlight 'Wall hit, 74 km/h' (city, 2026-10-07): a muscle coupe, a wreck on its masses, left the road where the
 * course narrows, crossed the open pavement inside the bend and drove into the BACK of the inner wall at 78-82 km/h, its
 * path 9-21° off the wall as the wall bent across it, and went straight through: the course wall pushed only cars that came
 * from the road side. Replayed headless (bdf8027a), the footprint met the back face at step 864 (77.7 km/h, 7.6 m/s into
 * it), a mass crossed the road face at 913 and the car's middle at 945. `OWNER` is the recording's pose at step 840,
 * 0.1 s before the touch; the front row is the same approach mirrored across the wall, from the road.
 */
const OWNER = { x: 162.101, z: 49.32, yaw: 1.3796, speed: 82.5 / 3.6 };
/** Seconds of throttle into the wall, then of coasting off it. */
const PRESS = 1.5;
const COAST = 1.5;
/** The shared solid rule's bars (prop-wall.test.ts): no body point more than 2 cm past the far face, at most 5 cm left in the wall once off the throttle. */
const PAST = 0.02;
const INSIDE = 0.05;

type Approach = { label: string; wreck: boolean; front: boolean };
const APPROACHES: Approach[] = [
  { label: "a muscle coupe, intact, on the owner's path across the pavement into the wall's back", wreck: false, front: false },
  { label: "a muscle coupe already a wreck on its masses (the owner's), on the owner's path into the wall's back", wreck: true, front: false },
  { label: "a muscle coupe on the owner's path mirrored across the wall: from the road into its face", wreck: false, front: true },
];

/** The city's walls as drawn (`wallColliders`), and per piece the side (±1 along its local x) the road is on. */
const CITY = new Track(TRACKS.find((j) => parseTrack(j).id === "city"));
const CITY_WALLS = wallColliders(CITY);
const ROAD_SIDE = CITY_WALLS.map((c) => {
  const k = CITY.project(c.x, c.z, -1, blankProjection()).k;
  return (CITY.path.x[k]! - c.x) * Math.cos(c.yaw) - (CITY.path.z[k]! - c.z) * Math.sin(c.yaw) > 0 ? 1 : -1;
});

/**
 * How deep (m) the car's contact footprint (the rectangle `FOOT_HALF_W` by `FOOT_HALF_L` span) stands in the city's drawn wall from its road
 * face: its outline sampled every centimetre (on a bend the deepest point of a flank is between its corners).
 */
function footDepth(car: DeformableCar): number {
  const p = car.group.position;
  const [fw, fl] = [FOOT_HALF_W, FOOT_HALF_L];
  let depth = 0;
  for (let q = 0; q <= 400; q++) {
    // Round the outline: t in [0, 1) per side, sides +x, −x (flanks) and +z, −z (ends).
    const t = (q % 100) / 100;
    const side = Math.floor(q / 100);
    const ox = side < 2 ? (side === 0 ? fw : -fw) : -fw + 2 * fw * t;
    const oz = side < 2 ? -fl + 2 * fl * t : side === 2 ? fl : -fl;
    const x = p.x + car.rightFlat.x * ox + car.fwdFlat.x * oz;
    const z = p.z + car.rightFlat.z * ox + car.fwdFlat.z * oz;
    for (const c of CITY_WALLS) {
      const u = (x - c.x) * Math.cos(c.yaw) - (z - c.z) * Math.sin(c.yaw);
      const along = (x - c.x) * Math.sin(c.yaw) + (z - c.z) * Math.cos(c.yaw);
      const d = c.hx - ROAD_SIDE[c.index]! * u;
      if (Math.abs(along) <= c.hz && d > 0 && d < 2 * c.hx) depth = Math.max(depth, d);
    }
  }
  return depth;
}

/**
 * How far the body reaches past the far face of any wall piece it is over (m), and how deep it is inside one from the face it
 * came at (m). `from`: per piece, the side (±1 along its local x) the car came from. A piece counts only while some point of the
 * body is inside its bounding circle (`PropCollider.r`): a car that got through a piece has points beside it, and a point
 * across a short piece's band metres from it (the band `|along| ≤ hz` runs on past the piece for ever) is a car passing by.
 */
function reachWall(car: DeformableCar, walls: readonly PropCollider[], from: (c: PropCollider) => number): { past: number; inside: number } {
  let past = 0;
  let inside = 0;
  const points = bodyPoints(car);
  for (const c of walls) {
    if (!points.some(([x, z]) => Math.hypot(x - c.x, z - c.z) <= c.r)) continue;
    const s = from(c);
    const cs = Math.cos(c.yaw);
    const sn = Math.sin(c.yaw);
    for (const [x, z] of points) {
      const u = (x - c.x) * cs - (z - c.z) * sn;
      const along = (x - c.x) * sn + (z - c.z) * cs;
      if (Math.abs(along) > c.hz) continue;
      past = Math.max(past, -s * u - c.hx);
      const depth = c.hx - s * u;
      if (depth > 0 && depth < 2 * c.hx) inside = Math.max(inside, depth);
    }
  }
  return { past, inside };
}

describe("given the city course's inner wall at the top of the bend past the course's narrowing, where the owner's highlight 'Wall hit, 74 km/h' went through it", () => {
  for (const a of APPROACHES) {
    it(`when ${a.label} at 82.5 km/h, gas held ${PRESS} s then off, then it hits the wall hard, no point of its body ever ends more than ${PAST * 100} cm past the wall's far face and at most ${INSIDE * 100} cm of it is left in the wall`, (t) => {
      const w = makeWorld();
      w.race.showLobby("city");
      try {
        const touch = CITY_WALLS.reduce((a, b) => (Math.hypot(b.x - 164.3, b.z - 51.1) < Math.hypot(a.x - 164.3, a.z - 51.1) ? b : a));
        const car = makeCar("muscle");
        w.dress(car);
        // The front row: the owner's pose and heading mirrored across the middle plane of the piece the owner's car first met.
        const n = { x: Math.cos(touch.yaw), z: -Math.sin(touch.yaw) };
        const off = (OWNER.x - touch.x) * n.x + (OWNER.z - touch.z) * n.z;
        const f = { x: Math.sin(OWNER.yaw), z: Math.cos(OWNER.yaw) };
        const fn = f.x * n.x + f.z * n.z;
        const pose = a.front ? { x: OWNER.x - 2 * off * n.x, z: OWNER.z - 2 * off * n.z, yaw: Math.atan2(f.x - 2 * fn * n.x, f.z - 2 * fn * n.z) } : OWNER;
        car.spawnFacing(pose.x, pose.z, pose.yaw, OWNER.speed);
        if (a.wreck) {
          car.crashed = true;
          car.deform.armMasses(car.group, car.velocity, car.angular);
        }
        const world = newWorld([car]);
        world.collide = (c, i, h) => w.race.courseHit(c, i, h);
        let hardest = 0;
        w.race.onWallHit = (_i, closing) => (hardest = Math.max(hardest, closing));
        // The side each piece's near face looks to: the road for the front row, away from it for the back.
        const from = (c: PropCollider): number => (a.front ? ROAD_SIDE[c.index]! : -ROAD_SIDE[c.index]!);
        const gas: DriveInput = { throttle: 1, steer: 0, brake: 0, ebrake: false, boost: false };
        const off2: DriveInput = { throttle: 0, steer: 0, brake: 0, ebrake: false, boost: false };
        let acc = 0;
        let past = 0;
        let deepest = 0;
        for (let fr = 0; fr < (PRESS + COAST) / FRAME; fr++) {
          acc = Math.min(0.05, acc + FRAME);
          while (acc > 1e-5) {
            const h = Math.fround(physicsSlice(acc, sliceSpeed(world.cars)));
            applyDrive(car, fr * FRAME < PRESS ? gas : off2, h);
            stepWorld(world, h);
            settleStep(world.cars, h, false);
            acc -= h;
          }
          car.updateSkin();
          const r = reachWall(car, CITY_WALLS, from);
          past = Math.max(past, r.past);
          deepest = Math.max(deepest, r.inside);
        }
        const { inside } = reachWall(car, CITY_WALLS, from);
        const note = `hit at ${hardest.toFixed(1)} m/s, ${car.deform.massActive ? "wreck" : "rigid"}, ${(Math.hypot(car.velocity.x, car.velocity.z) * 3.6).toFixed(1)} km/h at the end, deepest ${deepest.toFixed(3)} m in the wall, ${past.toFixed(3)} m past its far face, ${inside.toFixed(3)} m left in it`;
        t.diagnostic(note);
        assert.ok(hardest > 5, `${a.label}: met the wall at ${hardest.toFixed(1)} m/s, not the owner's hard hit (${note})`);
        assert.ok(past <= PAST, `${a.label}: the body reached ${past.toFixed(3)} m past the wall's far face (${note})`);
        assert.ok(inside <= INSIDE, `${a.label}: ${inside.toFixed(3)} m of the body left in the wall (${note})`);
      } finally {
        setGround(null);
      }
    });
  }
});
