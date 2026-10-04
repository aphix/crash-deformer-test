import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { FLAT_GROUND } from "../world/ground.ts";
import { placeProps } from "../world/placements.ts";
import { parseTrack } from "../world/track-schema.ts";
import { blankPoint, Track } from "../world/track.ts";
import { TRACKS } from "../world/tracks/index.ts";
import { sampleAt } from "./track-mesh.ts";
import { camUsable, CLEAR, occluder, raceSight, solid, type Sight } from "./spectate-cam.ts";
import { crashAxis, crashEye, crashSeen, CrashPick, CUTS, heldCut } from "./engine-cine.ts";

/** An eye's times through its cut, tried here: twice as many as the pick's, so half of them fall between its. */
const CUT_TIMES = 17;
const STILL = { x: 0, y: 0, z: 0 };

describe("crash cam on a course", () => {
  for (const json of TRACKS) {
    const track = new Track(parseTrack(json));
    it(`${track.id}: a hit sliding along a wall gets crash-cam eyes with room that all see it`, (t) => {
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
    it(`${track.id}: a crash-cam eye reads the same whichever spot was asked before it`, () => {
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
    it(`${track.id}: a pick spread over frames (5 camUsable calls a run) chooses what the whole pick does`, () => {
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
          assert.deepEqual([...slicedReach], [...wholeReach], `${track.id} s ${s} side ${side}: reach`);
          assert.ok(sliced.distanceTo(whole) < 1e-9, `${track.id} s ${s} side ${side}: axis`);
        }
      }
      // 1000 calls a second (`PICK_RATE`) must finish inside the lead-in before the first cut (`CUTS[0]` 1.3 s, less 0.05 s).
      assert.ok(longest * 5 <= 1000 * (CUTS[0] - 0.05), `${track.id}: the longest pick needs ${longest * 5}+ calls`);
      assert.ok(spots === 0 || runs > 0, "no pick took more than one run: the slicing is untested");
    });
  }
});

describe("held crash cam", () => {
  it("bad: a reel's crash cam keeps one cut through hits that shove the car about, and a wall across its sight moves it once", () => {
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
