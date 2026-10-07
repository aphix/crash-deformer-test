import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import type { RigidBody, World } from "@dimforge/rapier3d";
import { launch, makeCar, makeWorld, tickWorld } from "../contact/crash-scenarios.test-util.ts";
import { armKill, DEFAULT_REALISM } from "../vehicle/vehicle-classes.ts";
import { THROW_ONSET } from "../match/phase.ts";
import { RANGE } from "../scenes/range.ts";
import { RagdollSystem } from "./engine-ragdoll.ts";
import { shed } from "./ragdoll-body.ts";

const GRAVITY = 9.6;
type Doll = { live: boolean; bodies: RigidBody[] };

/** A deterministic stream in [0, 1). */
function stream(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

/** Kinetic energy (translation and spin) and kinetic plus gravitational energy of `bodies` (J). */
function energy(bodies: RigidBody[]): { kinetic: number; total: number } {
  let kinetic = 0;
  let potential = 0;
  for (const b of bodies) {
    const v = b.linvel();
    const w = b.angvel();
    const I = b.effectiveAngularInertia();
    kinetic += 0.5 * b.mass() * (v.x * v.x + v.y * v.y + v.z * v.z);
    kinetic += 0.5 * (I.m11 * w.x * w.x + I.m22 * w.y * w.y + I.m33 * w.z * w.z + 2 * (I.m12 * w.x * w.y + I.m13 * w.x * w.z + I.m23 * w.y * w.z));
    potential += b.mass() * GRAVITY * b.translation().y;
  }
  return { kinetic, total: kinetic + potential };
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();
/** The farthest apart two jointed parts' anchor points are in `world` (m). */
function jointGap(world: World): number {
  let gap = 0;
  for (const j of world.impulseJoints.getAll()) {
    const p = j.body1();
    const c = j.body2();
    const pa = p.translation();
    const ca = c.translation();
    _a.set(j.anchor1().x, j.anchor1().y, j.anchor1().z).applyQuaternion(_q.copy(p.rotation())).add(_b.set(pa.x, pa.y, pa.z));
    const first = _a.clone();
    _a.set(j.anchor2().x, j.anchor2().y, j.anchor2().z).applyQuaternion(_q.copy(c.rotation())).add(_b.set(ca.x, ca.y, ca.z));
    gap = Math.max(gap, first.distanceTo(_a));
  }
  return gap;
}

/** The fastest part's speed (m/s). */
function fastest(bodies: RigidBody[]): number {
  return Math.max(...bodies.map((b) => Math.hypot(b.linvel().x, b.linvel().y, b.linvel().z)));
}

type Run = {
  /** Torso x (m past the wall) once he has lain still for a second. */
  landing: number;
  /** Largest anchor gap over the whole throw (m). */
  gap: number;
  /** Largest per-frame rise of kinetic plus gravitational energy after his first ground contact (J). */
  rise: number;
  /** Fastest part (m/s) 3 sim seconds after his first ground contact. */
  speedAt3: number;
  /** Kinetic energy (J) at the end of the first ground contact's frame, and 3 s on. */
  kinetic: [number, number];
};

/**
 * The ejection range: a sedan at 100 km/h into the jersey barrier, the driver thrown over it onto sand, one frame
 * every `frame()` seconds (the engine's order: the car world, then `update` with the slow-mo's sim seconds).
 */
async function rangeThrow(frame: () => number): Promise<Run> {
  const car = makeCar("shape", 0.32, 0.45);
  armKill(car.deform, "sedan", DEFAULT_REALISM, "default");
  launch(car, -RANGE.run, 0, Math.PI / 2, RANGE.kph / 3.6, 0);
  const w = makeWorld([car], true, false);
  w.onEject = (e) => ragdolls.launch(e, [car]);
  w.clock.slomoAt = THROW_ONSET;
  const ragdolls = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
  await ragdolls.preload();
  ragdolls.sand = true;
  const barrier = new THREE.Group();
  const dolls: Doll[] = ragdolls["dolls"];
  const torso = new THREE.Vector3();
  const run: Run = { landing: NaN, gap: 0, rise: 0, speedAt3: NaN, kinetic: [NaN, NaN] };
  let sim = 0;
  let ground = -1;
  let before = 0;
  for (let wall = 0; wall < 30 && (Number.isNaN(run.landing) || ground < 0 || sim - ground < 3); ) {
    const frameDt = frame();
    wall += frameDt;
    tickWorld(w, frameDt);
    const simDt = frameDt * w.clock.timeScale;
    sim += simDt;
    ragdolls.update(simDt, [car], true, true, 0, barrier);
    const landed = ragdolls.latest(torso) > 1;
    if (landed && Number.isNaN(run.landing)) run.landing = torso.x;
    const d = dolls.find((x) => x.live);
    if (!d) continue;
    run.gap = Math.max(run.gap, jointGap(ragdolls["world"]!));
    const e = energy(d.bodies);
    // His first ground contact: any part's centre within a part's half-length of the sand.
    if (ground < 0 && d.bodies.some((b) => b.translation().y < 0.29)) {
      ground = sim;
      run.kinetic[0] = e.kinetic;
    } else if (ground >= 0) run.rise = Math.max(run.rise, e.total - before);
    before = e.total;
    if (ground >= 0 && sim - ground >= 3) {
      run.speedAt3 = fastest(d.bodies);
      run.kinetic[1] = e.kinetic;
    }
  }
  ragdolls.dispose();
  return run;
}

describe("given the ejection range (a sedan at 100 km/h into the jersey barrier, the driver thrown over it onto sand)", () => {
  it("when the throw is run at 60 and 240 Hz display rates, then he lands within 1 m of the same spot, inside FlatOut's 25–40 m", async () => {
    const slow = await rangeThrow(() => 1 / 60);
    const fast = await rangeThrow(() => 1 / 240);
    assert.ok(slow.landing >= 25 && slow.landing <= 40, `60 Hz landing ${slow.landing.toFixed(1)} m`);
    assert.ok(fast.landing >= 25 && fast.landing <= 40, `240 Hz landing ${fast.landing.toFixed(1)} m`);
    assert.ok(Math.abs(slow.landing - fast.landing) <= 1, `60 Hz ${slow.landing.toFixed(1)} m, 240 Hz ${fast.landing.toFixed(1)} m`);
  });

  it("when one throw is run at 30–360 Hz and with frames that vary 0.5–1.5×, then it lands in the same place", async () => {
    const land = async (dtOf: () => number): Promise<number> => {
      const ragdolls = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
      await ragdolls.preload();
      ragdolls.sand = true;
      ragdolls.update(1 / 60, [], true, true, 0, null);
      ragdolls["spawn"]({ car: 0, p: new THREE.Vector3(0, 1.2, 0), q: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2 + 0.3), v: new THREE.Vector3(27, 3.5, 0), w: new THREE.Vector3(0, 0, -3), age: 0, cop: false });
      const torso = new THREE.Vector3();
      let x = NaN;
      for (let t = 0; t < 12 && Number.isNaN(x); ) {
        const dt = dtOf();
        t += dt;
        ragdolls.update(dt, [], true, true, 0, null);
        if (ragdolls.latest(torso) > 1) x = torso.x;
      }
      ragdolls.dispose();
      return x;
    };
    const xs: number[] = [];
    for (const hz of [30, 60, 144, 240, 360]) xs.push(await land(() => 1 / hz));
    for (const seed of [1, 2]) {
      const r = stream(seed);
      xs.push(await land(() => (0.5 + r()) / 144));
    }
    assert.ok(Math.max(...xs) - Math.min(...xs) <= 0.1, `landings ${xs.map((x) => x.toFixed(2)).join(", ")} m`);
  });
});

describe("given a dummy thrown while time runs at 0.03× (the deepest slow-mo)", () => {
  it("when he is drawn at 60 and at 240 Hz, then every frame from the one after the throw shows him further along, by 0.5–2× the frame before's move", async () => {
    const out: string[] = [];
    for (const hz of [60, 240]) {
      const ragdolls = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
      await ragdolls.preload();
      ragdolls.update(1 / 60, [], true, true, 0, null);
      ragdolls["spawn"]({ car: 0, p: new THREE.Vector3(0, 1.2, 0), q: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2 + 0.3), v: new THREE.Vector3(27, 3.5, 0), w: new THREE.Vector3(0, 0, -3), age: 0, cop: false });
      // What the GPU gets: his slot's pieces (slot 0, the first throw), the throw frame's pose first.
      const drawn: Float32Array = ragdolls["mesh"].instanceMatrix.array as Float32Array;
      const per = drawn.length / ragdolls["dolls"].length;
      ragdolls.update(0.03 / hz, [], true, true, 0, null);
      const last = drawn.slice(0, per);
      const moves: number[] = [];
      for (let f = 0; f < hz / 2; f++) {
        ragdolls.update(0.03 / hz, [], true, true, 0, null);
        let move = 0;
        for (let o = 0; o < per; o += 16) {
          move = Math.max(move, Math.hypot(drawn[o + 12]! - last[o + 12]!, drawn[o + 13]! - last[o + 13]!, drawn[o + 14]! - last[o + 14]!));
          last.set(drawn.subarray(o, o + 16), o);
        }
        moves.push(move);
      }
      ragdolls.dispose();
      for (const [f, m] of moves.entries()) {
        const before = f === 0 ? m : moves[f - 1]!;
        if (m === 0 || m < 0.5 * before || m > 2 * before) out.push(`${hz} Hz frame ${f + 1}: moved ${(m * 1000).toFixed(2)} mm after ${(before * 1000).toFixed(2)} mm`);
      }
    }
    assert.deepEqual(out, []);
  });
});

describe("given a thrown dummy (the ejected driver's jointed ragdoll)", () => {
  // 240 Hz is the owner's display: frames of 0.5–1.5× with an occasional 5× hitch (main: one such run landed 58 m out).
  for (const [hz, seed] of [[240, 3], [240, 4], [240, 16], [60, 3]] as const) {
    it(`when the range throw is run at ${hz} Hz (frames of 0.5–1.5×, seed ${seed}), then after his first ground contact energy never rises, he is at rest in 3 s, and no joint comes 3 cm apart`, async () => {
      const r = stream(seed);
      const run = await rangeThrow(() => (0.5 + r() + (r() < 0.02 ? 4 : 0)) / hz);
      // Kinetic plus gravitational energy: a part falling gains kinetic energy for free, so only the rest is counted. The
      // sand pushing a part a few mm out of its penetration adds a few joules (2.8 J measured over 60 runs); what the
      // old per-frame steps pumped was 173 J and 5090 J.
      assert.ok(run.rise < 5, `energy rose ${run.rise.toFixed(2)} J in one frame`);
      assert.ok(run.speedAt3 < 0.05, `3 s after the first ground contact the fastest part still moves at ${run.speedAt3.toFixed(3)} m/s`);
      assert.ok(run.kinetic[1] < run.kinetic[0] * 1e-3, `kinetic energy ${run.kinetic[0].toFixed(0)} J at the first ground contact, ${run.kinetic[1].toFixed(1)} J 3 s on`);
      assert.ok(run.gap < 0.03, `a joint came ${(run.gap * 100).toFixed(1)} cm apart`);
    });
  }

  it("when a part's motion is shed against another part at any velocities, then it takes kinetic energy out of the pair and keeps their momentum", async () => {
    const ragdolls = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
    await ragdolls.preload();
    ragdolls.update(1 / 60, [], true, true, 0, null);
    ragdolls["spawn"]({ car: 0, p: new THREE.Vector3(0, 1, 0), q: new THREE.Quaternion(), v: new THREE.Vector3(), w: new THREE.Vector3(), age: 0, cop: false });
    const bodies: RigidBody[] = ragdolls["dolls"][0]!.bodies;
    const [torso, arm] = [bodies[0]!, bodies[2]!];
    const r = stream(7);
    const rand = () => (r() - 0.5) * 60;
    for (let n = 0; n < 200; n++) {
      torso.setLinvel({ x: rand(), y: rand(), z: rand() }, true);
      arm.setLinvel({ x: rand(), y: rand(), z: rand() }, true);
      torso.setAngvel({ x: rand(), y: rand(), z: rand() }, true);
      arm.setAngvel({ x: rand(), y: rand(), z: rand() }, true);
      const before = energy([torso, arm]).kinetic;
      const p = torso.linvel().x * torso.mass() + arm.linvel().x * arm.mass();
      shed(torso, arm, r(), r());
      const after = energy([torso, arm]).kinetic;
      assert.ok(after <= before, `pair ${n}: ${before.toFixed(3)} J became ${after.toFixed(3)} J`);
      assert.ok(Math.abs(torso.linvel().x * torso.mass() + arm.linvel().x * arm.mass() - p) < 1e-2, `pair ${n}: momentum moved`);
    }
    ragdolls.dispose();
  });

  it("when a car drives into a dummy that has gone to sleep, then he is woken and shoved by it", async () => {
    const car = makeCar("shape", 0.32, 0.45);
    launch(car, -30, 0, Math.PI / 2, 0, 0);
    const w = makeWorld([car], false, false);
    w.onEject = (e) => ragdolls.launch(e, [car]);
    const ragdolls = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
    await ragdolls.preload();
    const frame = () => {
      tickWorld(w);
      ragdolls.update(1 / 60, [car], true, true, 0, null);
    };
    frame();
    ragdolls["spawn"]({ car: 5, p: new THREE.Vector3(0, 0.3, 0), q: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2), v: new THREE.Vector3(), w: new THREE.Vector3(), age: 0, cop: false });
    const torso: RigidBody = ragdolls["dolls"][0]!.bodies[0]!;
    for (let f = 0; f < 120; f++) frame();
    assert.ok(torso.isSleeping(), "he lies asleep after two seconds on the ground");
    launch(car, -6, 0, Math.PI / 2, 5, 0);
    for (let f = 0; f < 240; f++) frame();
    const x = torso.translation().x;
    ragdolls.dispose();
    assert.ok(x > 3, `the car pushed him ${x.toFixed(1)} m`);
  });

  it("when every dummy lies asleep and no car is near, then nothing is stepped, and a car coming within reach steps the world again", async () => {
    const ragdolls = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
    await ragdolls.preload();
    ragdolls.update(1 / 60, [], true, true, 0, null);
    ragdolls["spawn"]({ car: 5, p: new THREE.Vector3(0, 0.3, 0), q: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2), v: new THREE.Vector3(), w: new THREE.Vector3(), age: 0, cop: false });
    const world: World = ragdolls["world"]!;
    const step = world.step.bind(world);
    let steps = 0;
    world.step = () => {
      steps++;
      step();
    };
    const torso: RigidBody = ragdolls["dolls"][0]!.bodies[0]!;
    for (let f = 0; f < 240; f++) ragdolls.update(1 / 60, [], true, true, 0, null);
    assert.ok(torso.isSleeping(), "he lies asleep after four seconds");
    const asleep = steps;
    for (let f = 0; f < 60; f++) ragdolls.update(1 / 60, [], true, true, 0, null);
    assert.equal(steps, asleep, "a second of him asleep stepped nothing");
    const car = makeCar("shape", 0.32, 0.45);
    launch(car, -3, 0, Math.PI / 2, 0, 0);
    for (let f = 0; f < 60; f++) ragdolls.update(1 / 60, [car], true, true, 0, null);
    assert.equal(steps, asleep, "a wreck lying 3 m from him steps nothing either");
    launch(car, -8, 0, Math.PI / 2, 5, 0);
    ragdolls.update(1 / 60, [car], true, true, 0, null);
    ragdolls.dispose();
    assert.ok(steps > asleep, "a car driving 8 m away steps the world");
  });
});
