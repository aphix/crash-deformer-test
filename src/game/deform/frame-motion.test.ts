import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { StreamedDeformation } from "./streamed-deform.ts";
import { DT, dummyGeom, mass } from "../vehicle/test-support.ts";
import { Ground, setGround } from "../world/ground.ts";

/**
 * What `followGroup` reports for a wreck (its `velocity` and `angular`) is what its masses do. It fits a frame to them
 * (heading, height), and a fit moves for reasons the masses do not: a mass pushed or crushed sideways, a re-measure
 * after a pair push, the first read of a tilted body. Those moves were written out as the car's spin and vertical speed.
 */
type Wreck = { d: StreamedDeformation; group: THREE.Group; vel: THREE.Vector3; omega: THREE.Vector3 };

function wreck(tilt?: { pitch: number; roll: number; y: number }, hit = { x: 0, speed: 0 }): Wreck {
  const d = new StreamedDeformation(dummyGeom());
  d.mode = "shape";
  const group = new THREE.Group();
  if (tilt) {
    group.rotation.set(tilt.pitch, 0, tilt.roll, "YXZ");
    group.position.y = tilt.y;
  }
  group.updateMatrixWorld();
  const vel = new THREE.Vector3(0, 0, hit.speed);
  const omega = new THREE.Vector3();
  d.beginCrush(new THREE.Vector3(hit.x, 0.36, 2.06), new THREE.Vector3(0, 0, -1), hit.speed, hit.speed, group, vel, omega);
  return { d, group, vel, omega };
}

/** Every mass moving as one rigid body turning `w` rad/s about the masses' centroid (v = w (z, −x)), the centroid at (vx, vz). */
function spinRigid(d: StreamedDeformation, w: number, vx: number, vz: number): void {
  let m = 0;
  let cx = 0;
  let cz = 0;
  for (const q of d.masses) {
    m += q.mass;
    cx += q.world.x * q.mass;
    cz += q.world.z * q.mass;
  }
  cx /= m;
  cz /= m;
  for (const q of d.masses) {
    q.vel.x = vx + w * (q.world.z - cz);
    q.vel.y = 0;
    q.vel.z = vz - w * (q.world.x - cx);
  }
}

/** Sim time (s) of a resting wreck's quiet steps before the checks: past the yaw sample's old minimum span. */
const SETTLE = 6;

function settled(): Wreck {
  const s = wreck();
  for (let i = 0; i < SETTLE; i++) {
    s.d.stepStructure(DT);
    s.d.followGroup(s.group, s.vel, s.omega, DT);
  }
  return s;
}

describe("given a crashed car whose parts keep moving (the game reads its spin and velocity from the parts, not from its body frame)", () => {
  it("when all its parts turn rigidly at 2 rad/s about their centre moving at (1.5, −0.5) m/s, then the reported spin is 2 rad/s and the reported velocity is the centre's", () => {
    const s = settled();
    spinRigid(s.d, 2, 1.5, -0.5);
    s.d.followGroup(s.group, s.vel, s.omega, DT);
    assert.ok(Math.abs(s.omega.y - 2) < 1e-6, `spin ${s.omega.y.toFixed(4)} rad/s, the masses turn at 2`);
    assert.ok(Math.abs(s.vel.x - 1.5) < 1e-6 && Math.abs(s.vel.z + 0.5) < 1e-6, `velocity ${s.vel.x.toFixed(3)}, ${s.vel.z.toFixed(3)}`);
  });

  it("when the engine pair is swung 0.35 rad about the rear axle in one step while the parts turn at 2 rad/s, then the reported spin stays within 0.5 rad/s of 2 rather than following the engine-to-axle line's faster turn", () => {
    const s = settled();
    spinRigid(s.d, 2, 0, 0);
    const axle = mass(s.d, "axleR").world;
    const engines = [mass(s.d, "engineL").world, mass(s.d, "engineR").world];
    const before = new THREE.Vector2(engines[0]!.x + engines[1]!.x, engines[0]!.z + engines[1]!.z).multiplyScalar(0.5).sub(new THREE.Vector2(axle.x, axle.z));
    const turn = 0.35;
    // Turn the engine pair about the axle, as a swung block: the same axis read 0.35 rad on.
    for (const e of engines) {
      const dx = e.x - axle.x;
      const dz = e.z - axle.z;
      e.x = axle.x + dx * Math.cos(turn) + dz * Math.sin(turn);
      e.z = axle.z - dx * Math.sin(turn) + dz * Math.cos(turn);
    }
    const after = new THREE.Vector2(engines[0]!.x + engines[1]!.x, engines[0]!.z + engines[1]!.z).multiplyScalar(0.5).sub(new THREE.Vector2(axle.x, axle.z));
    const axis = Math.abs(Math.atan2(after.x, after.y) - Math.atan2(before.x, before.y));
    assert.ok(Math.abs(axis - turn) < 1e-9, `the axis turned ${axis.toFixed(3)} rad`);
    s.d.stepStructure(DT);
    s.d.followGroup(s.group, s.vel, s.omega, DT);
    assert.ok(Math.abs(s.omega.y - 2) < 0.5, `spin ${s.omega.y.toFixed(2)} rad/s: the frame's turn is not the masses'`);
  });

  it("when a tilted car in flight has its body frame re-fitted to its parts with no time passing and the frame moves over 0.05 m, then the next timed read reports a vertical speed under 1 m/s", () => {
    const s = wreck({ pitch: 0.4, roll: 0.5, y: 1.5 });
    s.d.aloft = true;
    const y0 = s.group.position.y;
    s.d.followGroup(s.group, s.vel, s.omega, 0);
    const moved = Math.abs(s.group.position.y - y0);
    assert.ok(moved > 0.05, `the first read moved the frame ${moved.toFixed(3)} m: the setup no longer re-poses it`);
    s.d.stepStructure(DT);
    s.d.followGroup(s.group, s.vel, s.omega, DT);
    assert.ok(Math.abs(s.vel.y) < 1, `vertical speed ${s.vel.y.toFixed(2)} m/s from a ${moved.toFixed(3)} m re-measure`);
  });
});

/** The masses' angular momentum about their centroid (kg·m²/s about +y: Σ m r × v). */
function momentum(d: StreamedDeformation): number {
  let m = 0;
  let cx = 0;
  let cz = 0;
  let vx = 0;
  let vz = 0;
  for (const q of d.masses) {
    m += q.mass;
    cx += q.world.x * q.mass;
    cz += q.world.z * q.mass;
    vx += q.vel.x * q.mass;
    vz += q.vel.z * q.mass;
  }
  return d.masses.reduce((l, q) => l + q.mass * ((q.world.z - cz / m) * (q.vel.x - vx / m) - (q.world.x - cx / m) * (q.vel.z - vz / m)), 0);
}

describe("given a crashed car in flight, hit off-centre by a 14 m/s push so that it is spinning", () => {
  // Shape matching and the engine block's spacing correct positions only: over the masses' velocities each correction moved
  // Σ m r × v (derby seed 8: a car shoved against a wall went 0.9 → 7.5 rad/s, shape matching alone adding 6400 kg·m²/s in 1.2 s).
  it("when 12 steps of contact are followed by 16 steps with no contact, then the car's own steps keep its angular momentum (no step moves over 1%, the total within 2%)", () => {
    const s = wreck({ pitch: 0, roll: 0, y: 1 }, { x: 0.62, speed: 14 });
    s.d.aloft = true;
    for (let f = 0; f < 12; f++) {
      s.d.notifyContact();
      const fl = mass(s.d, "bumperFL").world;
      s.d.feedOverlap(new THREE.Vector3(0.62, fl.y, fl.z), new THREE.Vector3(0, 0, -1), 0.08, 14, DT);
      s.d.applyImpulse(0, 0, -1, 14 * s.d.totalMass * DT * 0.7);
      s.d.stepStructure(DT);
      s.d.followGroup(s.group, s.vel, s.omega, DT);
    }
    const l0 = momentum(s.d);
    let worst = 0;
    for (let f = 0; f < 16; f++) {
      const before = momentum(s.d);
      s.d.stepStructure(DT);
      worst = Math.max(worst, Math.abs(momentum(s.d) - before));
      s.d.followGroup(s.group, s.vel, s.omega, DT);
    }
    assert.ok(Math.abs(l0) > 400, `the hit left ${l0.toFixed(0)} kg·m²/s: the setup no longer turns the wreck`);
    assert.ok(worst < 0.01 * Math.abs(l0), `a step moved ${worst.toFixed(1)} of ${l0.toFixed(0)} kg·m²/s`);
    assert.ok(Math.abs(momentum(s.d) - l0) < 0.02 * Math.abs(l0), `${l0.toFixed(0)} → ${momentum(s.d).toFixed(0)} kg·m²/s over the live window`);
  });
});

/**
 * A plateau `TOP` m up under the wreck over the road (0): a wedge's high end. Walled: one prism a body falls beside (`WALLED_HALF`
 * either side of the wreck's anchor, so its sides are nearer than its top for a point 0.25 m under it); not walled: a plane within
 * `KERB` of every body point, with no sides.
 */
const TOP = 1.2;
const KERB = 0.35;
const WALLED_HALF = 0.2;
class Plateau extends Ground {
  constructor(walled: boolean) {
    super();
    this.addPlane(0, -1e4, 1e4, -1e4, 1e4, Infinity);
    if (walled) this.addPrism({ x: 0, z: 0, yaw: 0, hx: WALLED_HALF, hz: WALLED_HALF, base: 0, top: TOP, id: 0 });
    else this.addPlane(TOP, -1e4, 1e4, -1e4, 1e4, KERB);
  }
}

/** Where the frame's ground is read (a wreck's anchor, the middle of its masses) stands this far over the frame's origin. */
function anchorHeight(): number {
  const probe = wreck();
  return probe.d["at"].cell.world.y - probe.group.position.y;
}

const plateauLandingCases = [
  { it: "when the same car is over a plateau with no walls, then its frame rises over 0.24 m, landing on it", walls: false, depth: 0.25, minFrameRise: 0.24 },
  { it: "when its anchor is 0.05 m under the top of a walled plateau (a settled car's sag), then its frame rises over 0.04 m, landing on it", walls: true, depth: 0.05, minFrameRise: 0.04 },
] as const;

describe("given a crashed car in flight beside a raised plateau (the high end of a ramp)", () => {
  // The frame is where the masses are, within the band over the ground under the wreck's anchor. Under a wedge's end that ground is a
  // wall to a body falling beside it: the frame stepped up onto the top (0.24-0.27 m in one call, fleet-ramps D1) and `clampLocal`
  // shoved the masses after it (0.18-0.29 m), with no speed to show for it. A prism answers by the face a point leaves it by, so the
  // wall is a point under the top that is nearer a side than the top (the walled cases put the anchor there); the unwalled plateau is the same car over a plane with no sides.
  afterEach(() => setGround(null));

  /** A wreck in flight with its anchor (walled) or its origin (not) `depth` m under the plateau's top, middle over it: how far the frame and the highest-moved mass rose in its first read. */
  function rise(walls: boolean, depth: number): { frame: number; mass: number } {
    setGround(new Plateau(walls));
    const s = wreck({ pitch: 0, roll: 0, y: TOP - depth - (walls ? anchorHeight() : 0) });
    s.d.aloft = true;
    const y0 = s.group.position.y;
    const before = s.d.masses.map((m) => m.world.y);
    s.d.followGroup(s.group, s.vel, s.omega, DT);
    return { frame: s.group.position.y - y0, mass: Math.max(...s.d.masses.map((m, i) => m.world.y - before[i]!)) };
  }

  it("when its anchor is 0.25 m under the top of a walled plateau, nearer its side than its top, then its frame and parts stay put (under 2 cm) instead of climbing onto the plateau", () => {
    const r = rise(true, 0.25);
    assert.ok(r.frame < 0.02 && r.mass < 0.02, `the frame rose ${r.frame.toFixed(3)} m and a mass ${r.mass.toFixed(3)} m onto a top 0.25 m above the wreck's anchor`);
  });

  for (const testCase of plateauLandingCases) {
    it(testCase.it, () => {
      const r = rise(testCase.walls, testCase.depth);
      assert.ok(r.frame > testCase.minFrameRise, `the frame rose ${r.frame.toFixed(3)} m`);
    });
  }
});
