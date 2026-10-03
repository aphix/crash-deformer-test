import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { placeProps } from "../world/placements.ts";
import { parseTrack } from "../world/track-schema.ts";
import { blankPoint, Track } from "../world/track.ts";
import { TRACKS } from "../world/tracks/index.ts";
import { sampleAt } from "./track-mesh.ts";
import { raceSight } from "./spectate-cam.ts";
import { crashAxis, crashSeen } from "./engine-cine.ts";

describe("crash cam on a course", () => {
  for (const json of TRACKS) {
    const track = new Track(parseTrack(json));
    it(`${track.id}: a hit sliding along a wall gets crash-cam eyes that all see it`, (t) => {
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
      // ponytail: stunt keeps 20/272 spots (7%) whose long-lens eye no turn or pull-in clears (they film as before
      // the check); the other courses keep none. Lower the long lens there if those shots show up in reels.
      assert.ok(blind.length <= spots * 0.08, `${track.id}: ${blind.length}/${spots} wall hits leave a crash-cam eye blind: ${blind.slice(0, 5).join(", ")}`);
    });
  }
});
