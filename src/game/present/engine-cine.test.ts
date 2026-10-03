import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { FLAT_GROUND } from "../world/ground.ts";
import { placeProps } from "../world/placements.ts";
import { parseTrack } from "../world/track-schema.ts";
import { blankPoint, Track } from "../world/track.ts";
import { TRACKS } from "../world/tracks/index.ts";
import { sampleAt } from "./track-mesh.ts";
import { occluder, raceSight, type Sight } from "./spectate-cam.ts";
import { crashAxis, crashEye, crashSeen, heldCut } from "./engine-cine.ts";

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
        }
      }
      t.diagnostic(`${track.id}: ${spots} wall spots, ${blindAsHit} blind on the hit's own axis, ${blind.length} after the turn`);
      if (spots === 0) return;
      assert.ok(blindAsHit > 0, "the fixture puts no eye behind a wall: it tests nothing");
      // A cut with no usable eye (`CLEAR.radius` m of room and sight of the hit) is left to the chase / reel camera (`direct`),
      // never filmed from inside a wall's margin. Tight stunt walls leave the most: 54/272 (20%); rally 9/186 (5%); oval and city none.
      const most = track.id === "stunt" ? 0.22 : 0.08;
      assert.ok(blind.length <= spots * most, `${track.id}: ${blind.length}/${spots} wall hits leave a crash-cam cut with no usable eye: ${blind.slice(0, 5).join(", ")}`);
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
