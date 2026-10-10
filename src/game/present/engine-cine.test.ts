import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { FLAT_GROUND } from "../world/ground.ts";
import { placeProps } from "../world/placements.ts";
import { parseTrack } from "../world/track-schema.ts";
import { blankPoint, Track } from "../world/track.ts";
import { TRACKS } from "../world/tracks/index.ts";
import stunt from "../world/tracks/stunt.json" with { type: "json" };
import { sampleAt } from "./track-mesh.ts";
import { camUsable, carsBlock, CLEAR, occluder, raceSight, solid, withCars, type Sight } from "./spectate-cam.ts";
import { CrashCam, CrashPick, crashEye, CUTS, heldCut, hitAim, laterHits } from "./engine-cine.ts";
import { contextEye, fovFor } from "./highlight-cam.ts";
import { DeformableCar } from "../vehicle/car.ts";
import { SLOMO_HOLD } from "../match/phase.ts";
import { assertSameNumbers } from "../vehicle/test-support.ts";

/** An eye's times through its cut, tried here: twice as many as the pick's, so half of them fall between its. */
const CUT_TIMES = 17;
const STILL = { x: 0, y: 0, z: 0 };

/** The crash cam's pick, whole: `n` turned to the best axis and each cut's reach into `reach`. */
function crashAxis(s: Sight, at: THREE.Vector3, n: THREE.Vector3, reach: Float32Array): void {
  const pick = new CrashPick();
  pick.begin(s, at, n, reach);
  pick.run(Infinity);
}
/** The cuts of axis `n` alone (no turning) that have an eye, their reach into `reach`. */
function crashSeen(s: Sight, at: THREE.Vector3, n: THREE.Vector3, reach: Float32Array): number {
  const pick = new CrashPick();
  pick.begin(s, at, n.clone(), reach, 1);
  pick.run(Infinity);
  return reach.reduce((k, r) => k + (r > 0 ? 1 : 0), 0);
}

describe("given the crash camera choosing eyes for cars hit against the walls of each course", () => {
  for (const json of TRACKS) {
    const track = new Track(parseTrack(json));
    it(`when a car slides along the wall at every wall spot of the ${track.id} course, then at most 22% of spots on stunt (8% elsewhere) leave a cut with no usable eye, and at most 0.2% of eyes lose their room or sight of the hit during their cut`, (t) => {
      const sight = raceSight(track, placeProps(track));
      const path = track.path;
      const ground = track.ground();
      const pt = blankPoint();
      const at = new THREE.Vector3();
      const n = new THREE.Vector3();
      const reach = new Float32Array(3);
      let spots = 0;
      let blindAsHit = 0;
      const blind: string[] = [];
      const eye = new THREE.Vector3();
      let eyes = 0;
      const lost: string[] = [];
      for (let s = 0; s < track.length; s += 8) {
        track.pointAt(s, pt);
        const k = sampleAt(path, s);
        for (const side of [1, -1]) {
          if (!(side > 0 ? path.wallL[k] : path.wallR[k])) continue;
          // A car against the wall, travelling along it (the director's axis for a wall hit: the car's velocity).
          const lat = side * (path.half[k]! + (side > 0 ? path.runL[k]! : path.runR[k]!) - 1);
          const x = pt.x + pt.tz * lat;
          const z = pt.z - pt.tx * lat;
          at.set(x, ground.heightAt(x, z, pt.y + 1) + 0.55, z);
          n.set(pt.tx, 0, pt.tz).normalize();
          spots++;
          if (crashSeen(sight, at, n, reach) < 3 || reach.some((r) => r < 1)) blindAsHit++;
          crashAxis(sight, at, n, reach);
          if (crashSeen(sight, at, n, reach) < 3) blind.push(`s ${s} side ${side}${path.tunnel[k] ? " tunnel" : ""} reach ${[...reach].join("/")}`);
          // Each eye the pick gave a cut, at `CUT_TIMES` times through it (the eye pans and turns over the cut).
          for (let cut = 0; cut < 3; cut++) {
            if (reach[cut] === 0) continue;
            eyes++;
            for (let i = 0; i < CUT_TIMES; i++) {
              crashEye(eye, CUTS[cut]! + ((CUTS[cut + 1]! - CUTS[cut]!) * i) / (CUT_TIMES - 1), at, n, 1, reach[cut]!);
              if (camUsable(sight, eye, at, STILL, 0)) continue;
              lost.push(`s ${s} side ${side} cut ${cut} at ${i}/${CUT_TIMES - 1}`);
              break;
            }
          }
        }
      }
      t.diagnostic(`${track.id}: ${spots} wall spots, ${blindAsHit} blind on the hit's own axis, ${blind.length} left a cut with no eye after the turn, ${lost.length} of ${eyes} eyes lose room or sight during their cut`);
      if (spots === 0) return;
      assert.ok(blindAsHit > 0, "the fixture puts no eye behind a wall: it tests nothing");
      // A cut with no usable eye (`CLEAR.radius` m of room and sight of the hit, at the cut's start, middle and end) is left to the chase / reel camera (`direct`),
      // never filmed from inside a wall's margin. Tight stunt walls leave the most: 55/272 (20%); rally 14/186 (8%); oval and city none.
      const most = track.id === "stunt" ? 0.22 : 0.08;
      assert.ok(blind.length <= spots * most, `${track.id}: ${blind.length}/${spots} wall hits leave a crash-cam cut with no usable eye: ${blind.slice(0, 5).join(", ")}`);
      // The eye pans (long lens), creeps (bumper) and turns (crane) through its cut: one the pick calls usable keeps its room and
      // sight all the way. A middle-only pick lost them for 36 of 549 eyes on rally, 75 of 432 on city and 61 of 761 on stunt (0 on oval);
      // a sliver of a post beside the car between two checked times (stunt: 1 of 730) is all that is left.
      assert.ok(lost.length <= eyes * 0.002, `${track.id}: ${lost.length}/${eyes} crash-cam eyes lose their room or sight during their cut: ${lost.slice(0, 5).join(", ")}`);
    });
    it(`when the ${track.id} course's eyes are checked after four different earlier unrelated queries, then each eye's usability is the same whichever spot was asked before it`, () => {
      // `solid` projects each point onto the road from the last one's segment: where a course crosses itself (stunt: 1 of 544 eyes
      // on main) a far-off previous query left the hint on the other road, and the wall beside the eye went unseen.
      const sight = raceSight(track, placeProps(track));
      const path = track.path;
      const ground = track.ground();
      const pt = blankPoint();
      const far = blankPoint();
      const at = new THREE.Vector3();
      const n = new THREE.Vector3();
      const eye = new THREE.Vector3();
      const differ: string[] = [];
      for (let s = 0; s < track.length; s += 8) {
        track.pointAt(s, pt);
        const k = sampleAt(path, s);
        for (const side of [1, -1]) {
          if (!(side > 0 ? path.wallL[k] : path.wallR[k])) continue;
          const lat = side * (path.half[k]! + (side > 0 ? path.runL[k]! : path.runR[k]!) - 1);
          const x = pt.x + pt.tz * lat;
          const z = pt.z - pt.tx * lat;
          at.set(x, ground.heightAt(x, z, pt.y + 1) + 0.55, z);
          n.set(pt.tx, 0, pt.tz).normalize();
          for (const time of [CUTS[1]!, CUTS[2]! + 0.8]) {
            crashEye(eye, time, at, n, 1, 1);
            const answers = [0, 1, 2, 3].map((q) => {
              track.pointAt((track.length * q) / 4, far);
              solid(sight, far.x, far.y + 1, far.z, CLEAR.pad);
              return camUsable(sight, eye, at, STILL, 0);
            });
            if (answers.some((a) => a !== answers[0])) differ.push(`s ${s} side ${side} t ${time}`);
          }
        }
      }
      assert.deepEqual(differ, [], `${track.id}: eyes whose answer depends on the previous query`);
    });
    it(`when the ${track.id} course's pick is spread over frames at 5 usability checks a call, then it chooses the same cut reach and axis as the whole pick, and its longest run fits in the lead-in before the first cut at 1000 calls a second`, () => {
      // The crash cam's pick runs a few calls a frame over its lead-in: at 240 Hz one frame must not take the whole of it.
      const sight = raceSight(track, placeProps(track));
      const path = track.path;
      const ground = track.ground();
      const pt = blankPoint();
      const at = new THREE.Vector3();
      const whole = new THREE.Vector3();
      const sliced = new THREE.Vector3();
      const wholeReach = new Float32Array(3);
      const slicedReach = new Float32Array(3);
      const pick = new CrashPick();
      let runs = 0;
      let longest = 0;
      let spots = 0;
      for (let s = 0; s < track.length; s += 8) {
        track.pointAt(s, pt);
        const k = sampleAt(path, s);
        for (const side of [1, -1]) {
          if (!(side > 0 ? path.wallL[k] : path.wallR[k])) continue;
          const lat = side * (path.half[k]! + (side > 0 ? path.runL[k]! : path.runR[k]!) - 1);
          const x = pt.x + pt.tz * lat;
          const z = pt.z - pt.tx * lat;
          at.set(x, ground.heightAt(x, z, pt.y + 1) + 0.55, z);
          whole.set(pt.tx, 0, pt.tz).normalize();
          sliced.copy(whole);
          crashAxis(sight, at, whole, wholeReach);
          pick.begin(sight, at, sliced, slicedReach);
          let mine = 0;
          while (!pick.run(5)) mine++;
          runs += mine;
          longest = Math.max(longest, mine);
          spots++;
          assertSameNumbers(slicedReach, wholeReach, `${track.id} s ${s} side ${side}: reach`);
          assert.ok(sliced.distanceTo(whole) < 1e-9, `${track.id} s ${s} side ${side}: axis`);
        }
      }
      // 1000 calls a second (`PICK_RATE`) must finish inside the lead-in before the first cut (`CUTS[0]` 1.3 s, less 0.05 s).
      assert.ok(longest * 5 <= 1000 * (CUTS[0] - 0.05), `${track.id}: the longest pick needs ${longest * 5}+ calls`);
      assert.ok(spots === 0 || runs > 0, "no pick took more than one run: the slicing is untested");
    });
  }
});

describe("given a reel's crash camera in an open field where every cut has its full eye", () => {
  it("when three hits shove the car about, then the camera keeps its first cut (the crane), a wall across its sight line moves it once to the long lens, it holds the long lens once the way is clear again, and with no eye on any cut it falls back to the reel's own camera", () => {
    const open: Sight = { ground: FLAT_GROUND, path: null, wallTop: 0.6, rim: Infinity, occ: [] };
    const at = new THREE.Vector3(0, 0.55, 0);
    const n = new THREE.Vector3(1, 0, 0);
    const reach = new Float32Array(3);
    crashAxis(open, at, n, reach);
    assert.deepEqual([...reach], [1, 1, 1], "an open field leaves every cut its full eye");
    // The car after each of three hits: shoved a few metres about the impact, all on the near side of the wall below.
    const walk = [[0, 0], [-3, 1], [2, -2], [-4, 4], [-6, -2], [-1, 3]];
    const target = new THREE.Vector3();
    const run = (s: Sight, from: number): { cut: number; cuts: number } => {
      let cut = from;
      let cuts = 0;
      for (const [x, z] of walk) {
        const next = heldCut(s, at, n, reach, target.set(x!, 0.55, z!), cut);
        if (cut >= 0 && next !== cut) cuts++;
        cut = next;
      }
      return { cut, cuts };
    };
    const first = heldCut(open, at, n, reach, target.set(0, 0.55, 0), -1);
    assert.equal(first, 1, "the crane is the first choice");
    assert.deepEqual(run(open, first), { cut: 1, cuts: 0 }, "no cut through the hits");
    // A tall wall across the crane eye's sight line to the car where the hits start.
    const eye = new THREE.Vector3();
    crashEye(eye, 2.9, at, n, 0, 1);
    const dx = eye.x - at.x;
    const dz = eye.z - at.z;
    const d = Math.hypot(dx, dz);
    const walled: Sight = { ...open, occ: [occluder(at.x + (dx / d) * 3.3, at.z + (dz / d) * 3.3, Math.atan2(dx, dz), 8, 0.5, false, 0, 30)] };
    assert.deepEqual(run(walled, first), { cut: 2, cuts: 1 }, "the long lens takes over from the blocked crane, once, and keeps the shot through the hits");
    assert.equal(heldCut(open, at, n, reach, target.set(0, 0.55, 0), 2), 2, "it holds once the way is clear again");
    assert.equal(heldCut(walled, at, n, new Float32Array(3), target, first), -1, "no eye on any cut: the reel's own camera");
  });
});

describe("given a reel's crash camera in an open field and a later impact of its window, 12 m from the first", () => {
  /** The field, the first hit, the crane eye's offset and the long lens's direction from the hit. */
  const open: Sight = { ground: FLAT_GROUND, path: null, wallTop: 0.6, rim: Infinity, occ: [] };
  const at = new THREE.Vector3(0, 0.55, 0);
  const n = new THREE.Vector3(1, 0, 0);
  const reach = new Float32Array([1, 1, 1]);
  const target = new THREE.Vector3(0, 0.55, 0);
  const crane = new THREE.Vector3();
  crashEye(crane, CUTS[1], at, n, 0, 1);
  const long = new THREE.Vector3();
  crashEye(long, CUTS[2], at, n, 0, 1);
  /** The later impact 12 m round from the first hit, off the crane's side; and 12 m past it on the long lens's line, so the long lens has both in line. */
  const beside = laterHits(1);
  beside.n = 1;
  beside.at[0]!.set(-crane.z * (12 / Math.hypot(crane.x, crane.z)), 0.55, crane.x * (12 / Math.hypot(crane.x, crane.z)));
  const beyond = laterHits(1);
  beyond.n = 1;
  beyond.at[0]!.set(-long.x * (12 / Math.hypot(long.x, long.z)), 0.55, -long.z * (12 / Math.hypot(long.x, long.z)));
  /** A wall 6 m wide, 8 m in front of the later point `p` on the line to the crane's eye. */
  const shadow = (p: THREE.Vector3): Sight => {
    const toEye = new THREE.Vector3(crane.x - p.x, 0, crane.z - p.z).normalize();
    return { ...open, occ: [occluder(p.x + toEye.x * 8, p.z + toEye.z * 8, Math.atan2(toEye.x, toEye.z), 3, 0.5, false, 0, 30)] };
  };
  const still = { x: 0, y: 0, z: 0 };

  it("when the crane's eye sees the car but a wall hides the later impact from it, and the long lens has the first hit in line with it, then the cam leaves the crane for the long lens until the impact has passed, and keeps the crane after it", () => {
    const shadowed = shadow(beyond.at[0]!);
    assert.equal(heldCut(shadowed, at, n, reach, target, 1), 1, "the wall hides only the later impact: the car alone, the crane holds");
    assert.equal(camUsable(shadowed, crane, beyond.at[0]!, still, 0), false, "the crane cannot see the later impact");
    assert.equal(heldCut(shadowed, at, n, reach, target, 1, beyond, 0), 2, "the long lens sees the car and the later impact, with the first hit in its frame as it turns to it");
    assert.equal(heldCut(shadowed, at, n, reach, target, 1, beyond, 1), 1, "the impact has passed: the crane holds again");
  });

  it("when a wall hides the later impact beside the first hit from the crane, and the cuts that see it cannot keep the first hit in frame as they turn to it, then the crane that sees the car holds, so the viewer keeps the place", () => {
    const shadowed = shadow(beside.at[0]!);
    const eye = new THREE.Vector3();
    const sees = [0, 2].filter((cut) => {
      crashEye(eye, CUTS[cut]!, at, n, 0, 1);
      return camUsable(shadowed, eye, target, still, 0) && camUsable(shadowed, eye, beside.at[0]!, still, 0);
    });
    assert.ok(sees.length >= 1, "another cut sees the car and the later impact");
    assert.equal(camUsable(shadowed, crane, beside.at[0]!, still, 0), false, "the crane cannot see the later impact");
    assert.equal(heldCut(shadowed, at, n, reach, target, 1, beside, 0), 1, "no cut that sees the later impact keeps the first hit in frame: the crane holds");
  });

  it("when a wall box round the later impact hides it from every cut, then the cam keeps the cut that sees the car alone, as it did before it knew the impacts", () => {
    const a = beside.at[0]!;
    const box: Sight = { ...open, occ: [occluder(a.x + 3, a.z, 0, 0.5, 4, false, 0, 30), occluder(a.x - 3, a.z, 0, 0.5, 4, false, 0, 30), occluder(a.x, a.z + 3, 0, 4, 0.5, false, 0, 30), occluder(a.x, a.z - 3, 0, 4, 0.5, false, 0, 30)] };
    assert.equal(heldCut(box, at, n, reach, target, 1, beside, 0), 1, "no cut sees the impact: the crane that sees the car holds");
  });
});

describe("given a reel's crash camera in an open field and walls boxing the wreck in, so no cut's eye can see it", () => {
  const open: Sight = { ground: FLAT_GROUND, path: null, wallTop: 0.6, rim: Infinity, occ: [] };
  const at = new THREE.Vector3(0, 0.55, 0);
  const n = new THREE.Vector3(1, 0, 0);
  const reach = new Float32Array([1, 1, 1]);
  const target = new THREE.Vector3(1, 0.55, 0);
  const boxed: Sight = { ...open, occ: [occluder(4, 0, 0, 0.5, 4, false, 0, 30), occluder(-2, 0, 0, 0.5, 4, false, 0, 30), occluder(1, 3, 0, 4, 0.5, false, 0, 30), occluder(1, -3, 0, 4, 0.5, false, 0, 30)] };

  it("when the car has moved behind the walls after the hit, then the cam keeps its cut instead of handing the shot to the reel's own camera, and with no eye on any cut it still hands over", () => {
    const eye = new THREE.Vector3();
    for (const cut of [0, 1, 2]) {
      crashEye(eye, CUTS[cut]!, at, n, 0, 1);
      assert.equal(camUsable(boxed, eye, target, STILL, 0), false, `the walls hide the car from cut ${cut}`);
    }
    assert.equal(heldCut(boxed, at, n, reach, target, 2), 2, "the long lens it holds keeps the shot");
    assert.equal(heldCut(boxed, at, n, reach, target, -1), 1, "no cut held yet: the crane, the first of the order");
    assert.equal(heldCut(boxed, at, n, new Float32Array(3), target, 2), -1, "no eye on any cut: the reel's own camera");
  });
});

describe("given a crash camera begun at a hit with the sandbox's slow-motion hold", () => {
  const camera = new THREE.PerspectiveCamera();
  const begin = (): CrashCam => {
    const cam = new CrashCam(false);
    cam.begin(new THREE.Vector3(0, 0.5, 0), new THREE.Vector3(1, 0, 0), null, SLOMO_HOLD);
    return cam;
  };

  it("when the cam steps from its hit through its hand-back, then it holds from the hit to `crashCamEnd`, through the lead-in before its first cut, and not before or after", () => {
    const idle = new CrashCam(false);
    assert.equal(idle.holding, false, "not begun");
    const cam = begin();
    assert.equal(cam.holding, true, "begun");
    for (let i = 0; i < 11; i++) cam.direct(camera, 0.1, true);
    assert.equal(cam.cutting, false, "still in the lead-in, 1.1 s in");
    assert.equal(cam.holding, true, "a ride-along waits through the lead-in");
    for (let i = 0; i < 48; i++) cam.direct(camera, 0.1, true);
    assert.equal(cam.cutting, true);
    assert.equal(cam.holding, true, "and through the cuts, 5.9 s in");
    for (let i = 0; i < 4; i++) cam.direct(camera, 0.1, true);
    assert.equal(cam.holding, false, "handed back by 6.3 s");
    assert.ok(cam.letterbox > 0, "the bars are still leaving");
  });

  it("when the user frames the camera in the window, then the crash cam stops and so does the wait", () => {
    const cam = begin();
    cam.direct(camera, 0.1, false);
    assert.equal(cam.holding, false);
  });
});

describe("given a reel's crash camera in an open field holding the crane, and two drivers thrown 3.2 m apart in the same moment", () => {
  const open: Sight = { ground: FLAT_GROUND, path: null, wallTop: 0.6, rim: Infinity, occ: [] };
  const camera = new THREE.PerspectiveCamera();
  /** The cam 2.4 s in, its hold's beats: `n` of them over 2.0 to 3.0 s, `gap` m apart across the hit's line. */
  const lens = (n: number, gap: number): number => {
    const cam = new CrashCam(false);
    cam.begin(new THREE.Vector3(0, 0.5, 0), new THREE.Vector3(1, 0, 0), open, SLOMO_HOLD);
    const later = laterHits(2);
    later.n = n;
    for (let k = 0; k < n; k++) {
      later.from[k] = 2.0;
      later.until[k] = 3.0;
      later.at[k]!.set(0, 1, (k - (n - 1) / 2) * gap);
    }
    const hold = { target: new THREE.Vector3(0, 0.55, 0), sight: () => open, hit: 0.3, later };
    for (let i = 0; i < 24; i++) cam.direct(camera, 0.1, true, hold);
    return camera.fov;
  };

  it("when one thrown driver is the moment, then the lens stays the crane's, and when two are, then it opens to keep both in the frame of the narrowest screen, never past 70 degrees", () => {
    assert.equal(lens(1, 0), LENS.crane, "one point, aimed at: the crane's own lens");
    const wide = lens(2, 3.2);
    assert.ok(wide > LENS.crane && wide <= 70, `two points 3.2 m apart: ${wide.toFixed(1)} deg`);
    assert.ok(lens(2, 12) <= 70, "never past the cap, however far apart");
  });
});

/** The crash cam's lens on each cut: bumper, crane, long lens. */
const LENS = { bumper: 34, crane: 46, long: 21 };
const SCHEDULES = [
  { hold: 6.5, take: 1.3, crane: 2.9, long: 4.5, back: 6.1 },
  { hold: 9.5, take: 1.3, crane: 3.9, long: 6.5, back: 9.1 },
  { hold: 11.2, take: 1.3, crane: 4.47, long: 7.63, back: 10.8 },
];

describe("given the crash cam on a hit in an open field", () => {
  for (const s of SCHEDULES) {
    it(`when the slow-mo holds ${s.hold} s of wall clock, then it takes the camera on the bumper cam at ${s.take} s, cuts to the crane at ${s.crane} s and the long lens at ${s.long} s, and hands the camera back at ${s.back} s`, () => {
      const cam = new CrashCam(false);
      const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 900);
      cam.begin(new THREE.Vector3(), new THREE.Vector3(1, 0, 0), null, s.hold);
      const dt = 1 / 240;
      const changes: [number, number][] = [];
      let lens = 0;
      while (cam.camT >= 0 && cam.camT < s.hold + 1) {
        const now = cam.direct(camera, dt, true) ? camera.fov : 0;
        if (now !== lens) changes.push([cam.camT, now]);
        lens = now;
      }
      const want: [number, number][] = [[s.take, LENS.bumper], [s.crane, LENS.crane], [s.long, LENS.long], [s.back, 0]];
      assert.equal(changes.length, want.length, `lens changes ${JSON.stringify(changes)}`);
      for (const [i, [t, f]] of changes.entries()) {
        assert.equal(f, want[i]![1], `change ${i} to a ${f}° lens, not ${want[i]![1]}°`);
        assert.ok(Math.abs(t - want[i]![0]) < 0.02, `change ${i} at ${t.toFixed(3)} s, not ${want[i]![0]} s`);
      }
    });
  }
});

/** A car this far above the road (m) at its hit: in flight over the stunt course. */
const FLIGHT_HEIGHT = 5;
/** A car this deep in the road (m) at its hit: a wheel through the surface. */
const SUNK_DEPTH = 0.3;

describe("given the crash camera aiming at a hit on the stunt course's road", () => {
  const track = new Track(parseTrack(stunt));
  const spot = blankPoint();
  track.pointAt(track.length / 2, spot);
  const sight: Sight = { ground: track.ground(), path: null, wallTop: 0, rim: Infinity, occ: [] };
  const roadHeight = sight.ground.heightAt(spot.x, spot.z, spot.y + 1);
  const riseOverCar = hitAim(new THREE.Vector3(), 0, 0, 0, null).y;
  const aimHeight = (carHeight: number): number => hitAim(new THREE.Vector3(), spot.x, carHeight, spot.z, sight).y;
  const assertAimsAt = (carHeight: number, want: number): void => {
    assert.ok(Math.abs(aimHeight(carHeight) - want) < 1e-9, `aims ${aimHeight(carHeight).toFixed(3)} m, not ${want.toFixed(3)} m, for a car ${carHeight.toFixed(3)} m up`);
  };

  it("when the car is on the road at the hit, then the camera aims the same rise over the road as over a car on flat ground", () => {
    assertAimsAt(roadHeight, roadHeight + riseOverCar);
  });

  it(`when the car is ${FLIGHT_HEIGHT} m above the road at the hit, then the camera aims that rise over the car, not over the road under it`, () => {
    assertAimsAt(roadHeight + FLIGHT_HEIGHT, roadHeight + FLIGHT_HEIGHT + riseOverCar);
  });

  it(`when the car is ${SUNK_DEPTH} m into the road at the hit, then the camera aims that rise over the road, not over the car`, () => {
    assertAimsAt(roadHeight - SUNK_DEPTH, roadHeight + riseOverCar);
  });
});

describe("given a crash in an open field and the cars of the pile standing about the hit", () => {
  const open: Sight = { ground: FLAT_GROUND, path: null, wallTop: 0.6, rim: Infinity, occ: [] };
  const at = new THREE.Vector3(0, 0.55, 0);
  const axis = new THREE.Vector3(1, 0, 0);
  const scene = new THREE.Scene();
  /** The times through a cut the pick tries an eye at (`CUT_SAMPLES`). */
  const PICKED = 9;
  /** A parked car with its wheels at height `y`, its nose along `yaw` (rad from +z). */
  const carAt = (x: number, y: number, z: number, yaw = 0): DeformableCar => {
    const car = new DeformableCar({ body: 0x808080, accent: 0x404040, name: "car" }, scene);
    car.group.position.set(x, y, z);
    car.fwdFlat.set(Math.sin(yaw), 0, Math.cos(yaw));
    return car;
  };
  const _eye = new THREE.Vector3();
  /** The eye of cut `cut` at `reach`, a share `u` of the way through the cut. */
  const eyeAt = (cut: number, reach: number, u: number): THREE.Vector3 => {
    crashEye(_eye, CUTS[cut]! + (CUTS[cut + 1]! - CUTS[cut]!) * u, at, axis, 1, reach);
    return _eye.clone();
  };
  /** Each cut's reach after one axis of the pick over `s`. */
  const reachOf = (s: Sight): Float32Array => {
    const reach = new Float32Array(3);
    crashSeen(s, at, axis, reach);
    return reach;
  };
  /** No eye the pick samples on cut `cut` at `reach` is inside a car or has one on its line to the hit. */
  const eyesClear = (s: Sight, cut: number, reach: number): boolean => {
    for (let i = 0; i < PICKED; i++) if (carsBlock(s, eyeAt(cut, reach, i / (PICKED - 1)), at)) return false;
    return true;
  };
  const free = reachOf(open);

  it("when a car stands where the bumper cam's eye would be, then that cut takes a nearer eye or none, and no eye the pick samples is inside the car", () => {
    assert.equal(free[0], 1, "no cars: the bumper cam's eye at full reach");
    const old = eyeAt(0, 1, 0.5);
    const s = withCars(open, [carAt(old.x, 0, old.z)]);
    assert.equal(carsBlock(s, old, at), true, "the eye the pick would take is inside the car");
    const reach = reachOf(s);
    assert.ok(reach[0]! < 1, `the bumper cam kept its eye in the car (reach ${reach[0]})`);
    assert.ok(reach[0] === 0 || eyesClear(s, 0, reach[0]!), "an eye of the cut it took is in the car");
  });

  it("when a car stands between the long lens's eye and the hit, then that cut takes a nearer eye or none, and no eye the pick samples has a car on its line to the hit", () => {
    assert.equal(free[2], 1, "no cars: the long lens's eye at full reach");
    const old = eyeAt(2, 1, 0.5);
    const car = carAt(old.x / 2, 0, old.z / 2);
    const s = withCars(open, [car]);
    assert.equal(carsBlock(s, old, at), true, "a car stands on the line from the eye the pick would take");
    assert.ok(Math.hypot(old.x - car.group.position.x, old.z - car.group.position.z) > 4, "the eye itself is well clear of the car");
    const reach = reachOf(s);
    assert.ok(reach[2]! < 1, `the long lens kept its eye behind the car (reach ${reach[2]})`);
    assert.ok(reach[2] === 0 || eyesClear(s, 2, reach[2]!), "an eye of the cut it took has the car on its line");
  });

  it("when the cars stand above and below the line and the eyes, then the pick answers as it does with no cars", () => {
    const old = eyeAt(2, 1, 0.5);
    const s = withCars(open, [carAt(old.x / 2, 6, old.z / 2), carAt(old.x / 2, -3, old.z / 2), carAt(old.x, 6, old.z), carAt(old.x, -3, old.z)]);
    const reach = reachOf(s);
    for (let cut = 0; cut < 3; cut++) assert.equal(reach[cut], free[cut], `cut ${cut} reach with cars over and under: ${reach[cut]}, without: ${free[cut]}`);
  });

  it("when a car stands on the context shot's eye, then it takes another eye that is outside every car and has none on its lines to either point", () => {
    const a = new THREE.Vector3(0, 0.55, 0);
    const b = new THREE.Vector3(10, 0.55, 0);
    const old = new THREE.Vector3();
    assert.ok(contextEye(open, a, b, 0.3, old, new THREE.Vector3()) > 0, "an open field has an eye");
    const s = withCars(open, [carAt(old.x, old.y - 0.4, old.z, 0.7)]);
    assert.equal(carsBlock(s, old, a), true, "the old eye is inside the car");
    const eye = new THREE.Vector3();
    assert.ok(contextEye(s, a, b, 0.3, eye, new THREE.Vector3()) > 0, "the field still has an eye");
    assert.equal(carsBlock(s, eye, a) || carsBlock(s, eye, b), false, "the eye the shot takes is in a car or has one on its line");
  });

  it("when a car stands between the context shot's eye and one of its points, then it takes another eye with no car on either line", () => {
    const a = new THREE.Vector3(0, 0.55, 0);
    const b = new THREE.Vector3(10, 0.55, 0);
    const old = new THREE.Vector3();
    contextEye(open, a, b, 0.3, old, new THREE.Vector3());
    const mid = old.clone().add(a).multiplyScalar(0.5);
    const s = withCars(open, [carAt(mid.x, mid.y - 0.7, mid.z)]);
    assert.equal(carsBlock(s, old, a), true, "a car stands on the old eye's line to the first point");
    const eye = new THREE.Vector3();
    assert.ok(contextEye(s, a, b, 0.3, eye, new THREE.Vector3()) > 0, "the field still has an eye");
    assert.equal(carsBlock(s, eye, a) || carsBlock(s, eye, b), false, "the eye the shot takes has a car on a line");
  });
});

describe("given a reel's crash camera holding the crane with two drivers thrown 6 m apart, and a wall that then hides the crane's eye", () => {
  const open: Sight = { ground: FLAT_GROUND, path: null, wallTop: 0.6, rim: Infinity, occ: [] };
  const at = new THREE.Vector3(0, 0.55, 0);
  const n = new THREE.Vector3(1, 0, 0);

  it("when the held cut changes to the long lens as they are thrown, then its lens is open to keep both in frame of the narrowest screen on the new cut's first frame, not eased open after it", () => {
    const eye = new THREE.Vector3();
    crashEye(eye, CUTS[1]!, at, n, 0, 1);
    const d = Math.hypot(eye.x - at.x, eye.z - at.z);
    const walled: Sight = { ...open, occ: [occluder(at.x + ((eye.x - at.x) / d) * 3.3, at.z + ((eye.z - at.z) / d) * 3.3, Math.atan2(eye.x - at.x, eye.z - at.z), 8, 0.5, false, 0, 30)] };
    let wall = false;
    const later = laterHits(2);
    later.n = 2;
    for (let k = 0; k < 2; k++) {
      later.from[k] = 2.0;
      later.until[k] = 3.4;
      later.at[k]!.set(0, 1, k === 0 ? -3 : 3);
    }
    const hold = { target: new THREE.Vector3(0, 0.55, 0), sight: () => (wall ? walled : open), hit: 0.3, later };
    const cam = new CrashCam(false);
    const camera = new THREE.PerspectiveCamera();
    cam.begin(at.clone(), n.clone(), open, SLOMO_HOLD);
    let held = cam["held"];
    let changed = false;
    for (let i = 0; i < 80 && !changed; i++) {
      wall = cam.camT >= 2.1;
      cam.direct(camera, 0.05, true, hold);
      changed = held === 1 && cam["held"] === 2;
      held = cam["held"];
    }
    assert.ok(changed, "the wall moved the cam from the crane to the long lens");
    for (const p of later.at.slice(0, 2)) assert.ok(fovFor(camera.position, cam["aim"], p, camera.fov) <= camera.fov + 1e-6, `the thrown driver at z ${p.z} needs a ${fovFor(camera.position, cam["aim"], p, camera.fov).toFixed(1)} deg lens, the long lens's first frame has ${camera.fov.toFixed(1)}`);
  });
});
