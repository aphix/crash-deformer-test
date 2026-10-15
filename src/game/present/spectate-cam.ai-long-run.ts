import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { setGround } from "../world/ground.ts";
import { placeProps, propColliders } from "../world/placements.ts";
import { parseTrack } from "../world/track-schema.ts";
import { blankPoint, Track } from "../world/track.ts";
import { TRACKS } from "../world/tracks/index.ts";
import { FRAME, frame, makeWorld } from "../world/race-world.test-util.ts";
import { CINE, CineCam, raceSight } from "./spectate-cam.ts";
import { AutoCam, type AutoScene } from "./auto-cam.ts";
import { eyeProblems } from "./spectate-cam.test-util.ts";

/**
 * Full-sanity sweeps, not per-commit tests: every course's lap picked at every 8 m, and a 90 s watched race on every course. The per-commit
 * `spectate-cam.test.ts` holds the same claims on the oval alone.
 */
const COURSES = TRACKS.map((j) => new Track(parseTrack(j)));
const scene = new THREE.Scene();

describe("given the trackside cinematic camera (a fixed eye beside the course that cuts to the followed car)", () => {
  for (const track of COURSES) {
    it(`when a lap is driven on ${track.id}, then every spot the camera picks stands clear of every solid and sees the car`, (t) => {
      const placed = placeProps(track);
      const cols = propColliders(placed);
      const sight = raceSight(track, placed);
      const ground = track.ground();
      setGround(ground);
      try {
        const car = new DeformableCar({ body: 0x808080, accent: 0x404040, name: "watched" }, scene, null);
        const cine = new CineCam();
        const pt = blankPoint();
        let spots = 0;
        let found = 0;
        let worst = 0;
        let total = 0;
        const bad: string[] = [];
        for (let s = 0; s < track.length; s += 8) {
          track.pointAt(s, pt);
          car.spawnFacing(pt.x, pt.z, Math.atan2(pt.tx, pt.tz), 30);
          car.group.position.y = ground.heightAt(pt.x, pt.z, pt.y + 0.5);
          spots++;
          const t0 = performance.now();
          const ok = cine.pick(sight, car) === "found";
          const ms = performance.now() - t0;
          worst = Math.max(worst, ms);
          total += ms;
          if (!ok) continue;
          found++;
          const e = cine.eye;
          for (const why of eyeProblems(track, cols, e, car.group.position)) bad.push(`s ${s}: ${why}`);
          if (e.y - ground.heightAt(e.x, e.z, e.y) > CINE.heights.at(-1)! + 0.01) bad.push(`s ${s}: eye ${e.y.toFixed(1)} m too high`);
        }
        t.diagnostic(`${track.id}: ${found}/${spots} spots framed, pick ${(total / spots).toFixed(2)} ms mean, ${worst.toFixed(2)} ms worst`);
        assert.deepEqual(bad, []);
        assert.ok(found >= spots * 0.9, `${track.id}: only ${found}/${spots} spots found a clear eye`);
      } finally {
        setGround(null);
      }
    });
  }
});

describe("given the Auto spectator camera (the shot director that cuts between shot kinds while watching a race)", () => {
  for (const { id } of COURSES) {
    it(`when a race is watched on ${id}, then every trackside or high cut stands clear and sees the car, and the cuts mix shot kinds`, (t) => {
      const track = COURSES.find((c) => c.id === id)!;
      const placed = placeProps(track);
      const cols = propColliders(placed);
      const w = makeWorld();
      try {
        w.race.enter();
        w.race.command({ type: "options", options: { trackId: id, laps: 1, aiCount: 4, spectate: true } });
        w.race.reseed(3);
        w.race.command({ type: "start" });
        const camera = new THREE.PerspectiveCamera(56, 16 / 9, 0.1, 900);
        const auto = new AutoCam();
        const scene: AutoScene = { sight: () => w.race.courseSight()!, cut: (car) => car };
        const state = { acc: 0 };
        const kinds = new Set<string>();
        const bad: string[] = [];
        let cuts = 0;
        let playing: typeof auto.shot = null;
        let checked = 0;
        for (let n = 0; n < 90 / FRAME; n++) {
          frame(w, state);
          const car = w.cars[w.seat.carIndex]!;
          auto.update(camera, car, scene, FRAME);
          if (auto.shot === playing) continue;
          playing = auto.shot;
          cuts++;
          const kind = auto.shot!.kind;
          kinds.add(kind);
          // A wheel mount rides the car and a chase pose has no spot to find: only the searched spots promise room and sight.
          if (kind === "chase" || kind === "dutch" || !auto.cam.found) continue;
          checked++;
          for (const why of eyeProblems(track, cols, camera.position, car.group.position)) bad.push(`cut ${cuts} (${kind}) at ${(n * FRAME).toFixed(1)} s: ${why}`);
        }
        t.diagnostic(`${id}: ${cuts} cuts in 90 s (${[...kinds].join(", ")}), ${checked} searched spots checked`);
        assert.deepEqual(bad, []);
        assert.ok(cuts >= 8, `${cuts} cuts in 90 s`);
        assert.ok(kinds.size >= 3, `only ${[...kinds].join(", ")}`);
        assert.ok(checked >= 3, `${checked} searched spots`);
      } finally {
        w.race.exit();
        setGround(null);
      }
    });
  }
});
