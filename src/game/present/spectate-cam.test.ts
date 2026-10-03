import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { FLAT_GROUND, setGround } from "../world/ground.ts";
import { PREFABS } from "../world/catalog.ts";
import { placeProps, propColliders, type Placed, type PropCollider } from "../world/placements.ts";
import { parseTrack } from "../world/track-schema.ts";
import { blankPoint, blankProjection, projectPath, Track } from "../world/track.ts";
import { TRACKS } from "../world/tracks/index.ts";
import { FRAME, frame, makeWorld } from "../world/race-world.test-util.ts";
import { aheadPoints, camUsable, CINE, CineCam, CLEAR, clearSpot, DutchCam, occluder, raceSight, type Sight } from "./spectate-cam.ts";
import { WHEEL_POS } from "../vehicle/car-mesh.ts";
import { levelAt } from "./track-mesh.ts";

/** The dutch cam's mounts: each wheel well, looking forward and back. */
const MOUNT_COUNT = WHEEL_POS.length * 2;

/**
 * Oracle for the trackside eye, independent of `solid`: the cars' own collision footprints (props and the wall
 * line, `RaceField.props` / `wall`) at the props' drawn heights, the wall's 0.6 m body, and the ground.
 */
function blocked(track: Track, placed: readonly Placed[], cols: readonly PropCollider[], x: number, y: number, z: number): string | null {
  const ground = track.ground();
  if (y <= ground.heightAt(x, z, y)) return "under the ground";
  for (const c of cols) {
    const p = placed[c.index]!;
    if (y > p.y + PREFABS[p.prefab].size[1] * p.sy) continue;
    const ex = x - c.x;
    const ez = z - c.z;
    const cos = Math.cos(c.yaw);
    const sin = Math.sin(c.yaw);
    const inside = c.kind === "circle" ? ex * ex + ez * ez < c.r * c.r : Math.abs(ex * cos - ez * sin) < c.hx && Math.abs(ex * sin + ez * cos) < c.hz;
    if (inside) return `in ${c.prefab} #${c.index}`;
  }
  const path = track.path;
  const pr = projectPath(path, x, z, -1, blankProjection());
  const left = pr.lateral > 0;
  const over = Math.abs(pr.lateral) - path.half[pr.k]! - (left ? path.runL[pr.k]! : path.runR[pr.k]!);
  if ((left ? path.wallL[pr.k] : path.wallR[pr.k]) && over > 0 && over < 0.6 && y < levelAt(path, pr.k, pr.lateral) + track.json.road.wallHeight) return "in the wall";
  return null;
}

const COURSES = TRACKS.map((j) => new Track(parseTrack(j)));
const scene = new THREE.Scene();

describe("trackside cinematic cam", () => {
  for (const track of COURSES) {
    it(`${track.id}: over a lap every pick stands clear of every solid and sees the car`, (t) => {
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
          const p = car.group.position;
          const at = blocked(track, placed, cols, e.x, e.y, e.z);
          if (at) bad.push(`s ${s}: eye (${e.x.toFixed(1)}, ${e.y.toFixed(1)}, ${e.z.toFixed(1)}) ${at}`);
          if (e.y - ground.heightAt(e.x, e.z, e.y) > CINE.heights.at(-1)! + 0.01) bad.push(`s ${s}: eye ${e.y.toFixed(1)} m too high`);
          // The sight line, 10 cm at a time, up to the car's own `stop` margin.
          const len = e.distanceTo(p);
          for (let d = 0.1; d < len - CINE.stop; d += 0.1) {
            const f = d / len;
            const why = blocked(track, placed, cols, e.x + (p.x - e.x) * f, e.y + (p.y + CINE.aimUp - e.y) * f, e.z + (p.z - e.z) * f);
            if (why) {
              bad.push(`s ${s}: sight line ${why} at ${d.toFixed(1)} m of ${len.toFixed(1)}`);
              break;
            }
          }
          // Room: no solid within 1.9 m flat of the eye (a spot may stand beside a bank, so not the ground).
          for (let i = 0; i < 12; i++) {
            const a = (i * Math.PI) / 6;
            const why = blocked(track, placed, cols, e.x + 1.9 * Math.cos(a), e.y, e.z + 1.9 * Math.sin(a));
            if (why && why !== "under the ground") bad.push(`s ${s}: ${why} within 1.9 m of the eye`);
          }
        }
        t.diagnostic(`${track.id}: ${found}/${spots} spots framed, pick ${(total / spots).toFixed(2)} ms mean, ${worst.toFixed(2)} ms worst`);
        assert.deepEqual(bad, []);
        assert.ok(found >= spots * 0.9, `${track.id}: only ${found}/${spots} spots found a clear eye`);
      } finally {
        setGround(null);
      }
    });
  }

  it("oval: holds a shot until shortly after the car passes the eye, then picks the next one ahead", () => {
    const track = COURSES.find((c) => c.id === "oval")!;
    const sight = raceSight(track, placeProps(track));
    const ground = track.ground();
    setGround(ground);
    try {
      const car = new DeformableCar({ body: 0x808080, accent: 0x404040, name: "watched" }, scene, null);
      const camera = new THREE.PerspectiveCamera(56, 16 / 9, 0.1, 900);
      const cine = new CineCam();
      const pt = blankPoint();
      const v = 40;
      const dt = 1 / 60;
      track.pointAt(0, pt);
      car.spawnFacing(pt.x, pt.z, Math.atan2(pt.tx, pt.tz), v);
      const L = track.length;
      const eye = new THREE.Vector3();
      const look = new THREE.Vector3();
      let shots = 0;
      let passedAt = -1;
      let shotAt = 0;
      let eyeS = 0;
      for (let i = 0; i * dt * v < L; i++) {
        const s = i * dt * v;
        track.pointAt(s, pt);
        car.group.position.set(pt.x, ground.heightAt(pt.x, pt.z, pt.y + 0.5), pt.z);
        car.velocity.set(pt.tx * v, 0, pt.tz * v);
        assert.ok(cine.update(camera, car, () => sight, dt), `no shot at frame ${i}`);
        const p = car.group.position;
        if (!cine.eye.equals(eye)) {
          if (shots > 0) {
            const held = (i - shotAt) * dt;
            // Cut: CINE.after s after the car passed the eye (0.1 s of slack: the eye's pass plane is square to the
            // course at the spot, so on a bend it differs a little from the arc length), or the shot's time limit.
            assert.ok(passedAt >= 0 ? Math.abs((i - passedAt) * dt - CINE.after) <= 0.1 : held >= CINE.maxShot - dt, `cut at frame ${i}: passed ${passedAt}, held ${held.toFixed(2)} s`);
          }
          // The new eye stands ahead of the car along the course.
          eyeS = projectPath(track.path, cine.eye.x, cine.eye.z, -1, blankProjection()).s;
          const ahead = (((eyeS - s) % L) + L) % L;
          assert.ok(ahead > 0 && ahead < CINE.lead[1]! * 1.5, `eye ${ahead.toFixed(1)} m ahead`);
          eye.copy(cine.eye);
          shots++;
          shotAt = i;
          passedAt = -1;
        }
        // Passed: the car's arc length is beyond the eye's.
        if (passedAt < 0 && (((s - eyeS) % L) + L) % L < L / 2) passedAt = i;
        // The lens stays on the car.
        assert.ok(camera.position.equals(cine.eye));
        camera.getWorldDirection(look);
        const to = new THREE.Vector3(p.x, p.y + CINE.aimUp, p.z).sub(camera.position).normalize();
        assert.ok(look.dot(to) > 0.9999, `frame ${i} looks ${Math.acos(Math.min(1, look.dot(to))).toFixed(4)} rad off the car`);
      }
      assert.ok(shots >= 6, `${shots} shots in a lap`);
    } finally {
      setGround(null);
    }
  });
});

describe("wheel-well dutch cam", () => {
  it("keeps at least as many rivals in view over a race as any one fixed well", (t) => {
    const w = makeWorld();
    try {
      w.race.enter();
      w.race.command({ type: "options", options: { trackId: "oval", laps: 1, aiCount: 4, spectate: true } });
      w.race.reseed(3);
      w.race.command({ type: "start" });
      const camera = new THREE.PerspectiveCamera(56, 16 / 9, 0.1, 900);
      const dutch = new DutchCam();
      const fixed = new Array<number>(MOUNT_COUNT).fill(0);
      let mine = 0;
      let cuts = 0;
      let last = dutch.mount;
      const state = { acc: 0 };
      const watched = w.seat.carIndex;
      for (let n = 0; n < 70 / FRAME; n++) {
        frame(w, state);
        const car = w.cars[watched]!;
        const rivals = w.live();
        dutch.update(camera, car, () => rivals, FRAME);
        if (dutch.mount !== last) cuts++;
        last = dutch.mount;
        // Sampled 4 times a second.
        if (n % 15 !== 0) continue;
        mine += dutch.seen(car, rivals, dutch.mount, camera);
        for (let j = 0; j < MOUNT_COUNT; j++) fixed[j]! += dutch.seen(car, rivals, j, camera);
      }
      t.diagnostic(`rival-samples in view: dutch ${mine}, fixed wells ${fixed.join(" ")}; ${cuts} cuts`);
      assert.ok(cuts >= 15, `${cuts} cuts in 70 s`);
      for (let j = 0; j < MOUNT_COUNT; j++) assert.ok(mine >= fixed[j]!, `well ${j} kept ${fixed[j]} in view, the dutch cam ${mine}`);
    } finally {
      w.race.exit();
      setGround(null);
    }
  });
});

describe("camera clearance", () => {
  // One 12 × 14 × 12 m building, yawed 0.3 rad, on open flat ground.
  const yaw = 0.3;
  const sight: Sight = { ground: FLAT_GROUND, path: null, wallTop: 0.6, rim: Infinity, occ: [occluder(0, 0, yaw, 6, 6, false, 0, 14)] };
  /** A point `d` m out of the building's face `side` (0..3), `slide` m along it, at height y. */
  const off = (side: number, d: number, slide: number, y: number): [number, number, number] => {
    const a = yaw + (side * Math.PI) / 2;
    return [(6 + d) * Math.cos(a) - slide * Math.sin(a), y, -(6 + d) * Math.sin(a) - slide * Math.cos(a)];
  };

  it("clearSpot: false in the building, within 1.9 m of any face or roof, and at ground level; true in the open", () => {
    assert.equal(clearSpot(sight, 0, 1.5, 0), false, "inside");
    for (let side = 0; side < 4; side++) {
      for (const slide of [0, 4]) {
        assert.equal(clearSpot(sight, ...off(side, 1.9, slide, 1.5)), false, `side ${side} slide ${slide}: 1.9 m off the face`);
        assert.equal(clearSpot(sight, ...off(side, 2.6, slide, 1.5)), true, `side ${side} slide ${slide}: 2.6 m off the face`);
      }
    }
    assert.equal(clearSpot(sight, 0, 15.5, 0), false, "1.5 m over the roof");
    assert.equal(clearSpot(sight, 0, 17, 0), true, "3 m over the roof");
    assert.equal(clearSpot(sight, 40, 0.1, 0), false, "on the ground");
    assert.equal(clearSpot(sight, 40, 1.5, 0), true, "open air");
  });

  it("camUsable: the building between eye and target blocks, and so does the car driving behind it within the horizon", () => {
    const eye = { x: -30, y: 1.5, z: 0 };
    const target = { x: 30, y: 0.7, z: -45 };
    const still = { x: 0, y: 0, z: 0 };
    const north = { x: 0, y: 0, z: 25 };
    assert.equal(camUsable(sight, eye, { x: 30, y: 0.7, z: 0 }, still, 0), false, "building in the line");
    assert.equal(camUsable(sight, eye, target, still, 2), true, "open line to a still car");
    assert.equal(camUsable(sight, eye, target, north, 1), true, "1 s on it is still at z -20, clear of the building");
    assert.equal(camUsable(sight, eye, target, north, 2), false, "2 s on it is behind the building");
    assert.equal(camUsable(sight, { x: 0, y: 1.5, z: 0 }, target, still, 0), false, "eye inside the building");
  });

  it("aheadPoints: on a course the car is predicted along it, not on the straight of its velocity", () => {
    const track = COURSES.find((c) => c.id === "oval")!;
    const open = raceSight(track, placeProps(track));
    setGround(track.ground());
    try {
      const pt = blankPoint();
      const pr = blankProjection();
      const out = new Float64Array(3 * (CLEAR.ahead + 1));
      let bends = 0;
      for (let s = 0; s < track.length; s += 10) {
        track.pointAt(s, pt);
        const n = aheadPoints(open, pt.x, pt.y + 0.5, pt.z, pt.tx * 40, pt.tz * 40, 4, out);
        assert.ok(n >= 1 && n <= CLEAR.ahead + 1, `s ${s}: ${n} samples`);
        for (let i = 0; i < n; i++) assert.ok(Math.abs(projectPath(track.path, out[3 * i]!, out[3 * i + 2]!, -1, pr).lateral) < 1, `s ${s}: sample ${i} is ${pr.lateral.toFixed(1)} m off the course`);
        // The straight on its velocity leaves the road there: the prediction is not that line.
        const lat = Math.abs(projectPath(track.path, pt.x + pt.tx * 160, pt.z + pt.tz * 160, -1, pr).lateral);
        if (lat > 10) bends++;
      }
      assert.ok(bends > 0, "no bend in the lap leaves the straight 10 m off the road");
    } finally {
      setGround(null);
    }
  });
});
