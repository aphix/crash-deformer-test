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
import { camUsable, CLEAR, occluder, raceSight, solid, type Sight } from "./spectate-cam.ts";
import { CrashCam, CrashPick, crashEye, CUTS, heldCut, hitAim, laterHits } from "./engine-cine.ts";
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

describe("given a reel's crash camera in an open field and a later impact of its window, 12 m beside the first", () => {
  /** The field, the first hit, the crane eye's offset, and the later impact's point (12 m round from the first hit, off the crane's side). */
  const open: Sight = { ground: FLAT_GROUND, path: null, wallTop: 0.6, rim: Infinity, occ: [] };
  const at = new THREE.Vector3(0, 0.55, 0);
  const n = new THREE.Vector3(1, 0, 0);
  const reach = new Float32Array([1, 1, 1]);
  const target = new THREE.Vector3(0, 0.55, 0);
  const crane = new THREE.Vector3();
  crashEye(crane, CUTS[1], at, n, 0, 1);
  const later = laterHits(1);
  later.n = 1;
  later.at[0]!.set(-crane.z * (12 / Math.hypot(crane.x, crane.z)), 0.55, crane.x * (12 / Math.hypot(crane.x, crane.z)));
  /** A wall 6 m wide, 8 m in front of the later point on the line to the crane's eye: the long lens, from the far side, sees both. */
  const toEye = new THREE.Vector3(crane.x - later.at[0]!.x, 0, crane.z - later.at[0]!.z).normalize();
  const wall = occluder(later.at[0]!.x + toEye.x * 8, later.at[0]!.z + toEye.z * 8, Math.atan2(toEye.x, toEye.z), 3, 0.5, false, 0, 30);
  const shadowed: Sight = { ...open, occ: [wall] };

  it("when the crane's eye sees the car but a wall hides the later impact from it, then the cam leaves the crane for a cut that sees both until the impact has passed, and keeps the crane after it", () => {
    assert.equal(heldCut(shadowed, at, n, reach, target, 1), 1, "the wall hides only the later impact: the car alone, the crane holds");
    const seen = heldCut(shadowed, at, n, reach, target, 1, false, later, 0);
    assert.notEqual(seen, 1, "the crane cannot see the later impact");
    assert.ok(seen >= 0, "another cut sees the car and the later impact");
    assert.equal(heldCut(shadowed, at, n, reach, target, 1, false, later, 1), 1, "the impact has passed: the crane holds again");
  });

  it("when a wall box round the later impact hides it from every cut, then the cam keeps the cut that sees the car alone, as it did before it knew the impacts", () => {
    const a = later.at[0]!;
    const box: Sight = { ...open, occ: [occluder(a.x + 3, a.z, 0, 0.5, 4, false, 0, 30), occluder(a.x - 3, a.z, 0, 0.5, 4, false, 0, 30), occluder(a.x, a.z + 3, 0, 4, 0.5, false, 0, 30), occluder(a.x, a.z - 3, 0, 4, 0.5, false, 0, 30)] };
    assert.equal(heldCut(box, at, n, reach, target, 1, false, later, 0), 1, "no cut sees the impact: the crane that sees the car holds");
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
