import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import type { GlassName } from "../vehicle/car-core.ts";
import { makeCar } from "../contact/crash-scenarios.test-util.ts";
import { RagdollSystem } from "./engine-ragdoll.ts";

const FRAME = 1 / 60;
/** One physics step of the dummies' world: the strikes are followed step by step. */
const STEP = 1 / 480;
/** Steps a strike is followed: 0.125 s, before a torso through a pane can reach the far side of the cabin. */
const FOLLOW = 60;
/** How far out of the pane (m) the dummy's leading face starts. */
const START_GAP = 0.19;
/** How far the torso's centre is behind its leading face (m): chest first its half depth; head first, the tips of his raised arms (he is thrown arms up, `ARM`) are 0.80 m out along his spine, the end of his torso 0.27 m. */
const LEAD = { chest: 0.11, head: 0.8 } as const;
const TORSO_HALF_LENGTH = 0.27;

type Body = { translation(): THREE.Vector3Like; linvel(): THREE.Vector3Like; collider(i: number): { setCollisionGroups(g: number): void } };
type Dolls = { bodies: Body[] }[];

/** World centre of pane `name` of `car` and its outward unit normal (out of the cabin), from the drawn pane itself. */
function paneFrame(car: DeformableCar, name: GlassName): { centre: THREE.Vector3; out: THREE.Vector3 } {
  const centre = car.glassWorld(name, new THREE.Vector3());
  const pane = car["glassPanes"].find((g) => g.name === name)!;
  const normals = pane.mesh.geometry.getAttribute("normal");
  const out = new THREE.Vector3();
  for (let i = 0; i < normals.count; i++) out.add(new THREE.Vector3(normals.getX(i), normals.getY(i), normals.getZ(i)));
  out.transformDirection(pane.mesh.matrixWorld);
  // Out of the cabin: away from the middle of the greenhouse.
  const cabin = new THREE.Vector3(0, 1, -0.1).applyMatrix4(car.group.matrixWorld);
  if (out.dot(centre.clone().sub(cabin)) < 0) out.negate();
  return { centre, out };
}

/** Each pane's state, by name. */
function glassOf(car: DeformableCar): Record<string, string> {
  const names: GlassName[] = ["windshield", "rear", "doorL", "doorR", "quarterL", "quarterR"];
  const bits = car.glassBits();
  const states = ["intact", "cracked", "shattered"];
  return Object.fromEntries(names.map((n, i) => [n, states[(bits >> (2 * i)) & 3]!]));
}

type Strike = {
  /** The torso's velocity along the pane's outward normal (m/s): the step before the strike (the dummy reaching the glass, or stopping short of it), the step after it, and the most outward over the 12 steps (25 ms) after it. */
  before: number;
  next: number;
  peakOut: number;
  /** How far the torso's centre got past the glass into the cabin (m; negative: it stayed that far outside). */
  through: number;
};

/** How the dummy comes at the pane: his torso flat to it (its long side across the pane), or head first along its normal, arms up. */
type Pose = keyof typeof LEAD;

/**
 * A parked sedan at the origin facing +z (car 1); the thrower's own car parked 60 m away (car 0). Each of `speeds` throws
 * a dummy straight at pane `name` of car 1, aimed `up` m up and `along` m across the pane from its middle (across: the car's
 * width on the windshield, its length on a side window), in `pose`, his leading face `START_GAP` m off the glass;
 * `torsoOnly`: his head and limbs touch nothing, so his torso alone meets the car. Each throw is followed `FOLLOW` steps:
 * what his torso did, and the car's glass at the end.
 */
async function strikes(name: GlassName, up: number, along: number, pose: Pose, torsoOnly: boolean, speeds: readonly number[]): Promise<{ throws: Strike[]; glass: Record<string, string> }> {
  const own = makeCar();
  const car = makeCar();
  own.spawnFacing(-60, 0, 0, 0);
  car.spawnFacing(0, 0, 0, 0);
  car.group.updateMatrixWorld(true);
  const cars = [own, car];
  const ragdolls = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
  await ragdolls.preload();
  ragdolls.update(FRAME, cars, true, false, 0, null);
  const { centre, out } = paneFrame(car, name);
  const side = Math.abs(out.x) > 0.5;
  const across = (side ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0)).addScaledVector(out, -(side ? out.z : out.x)).normalize();
  const upPane = new THREE.Vector3().crossVectors(out, across);
  const aim = centre.clone().addScaledVector(upPane, up).addScaledVector(across, along);
  const inward = out.clone().negate();
  // Chest first: the torso's width down the pane, its length across it, its thin side to the glass. Head first: his spine along the pane's normal.
  const basis = pose === "chest" ? new THREE.Matrix4().makeBasis(upPane.clone().negate(), across, out) : new THREE.Matrix4().makeBasis(across, inward, new THREE.Vector3().crossVectors(across, inward));
  const q = new THREE.Quaternion().setFromRotationMatrix(basis);
  const throws: Strike[] = [];
  for (const speed of speeds) {
    ragdolls["spawn"]({ car: 0, p: aim.clone().addScaledVector(out, LEAD[pose] + START_GAP), q, v: inward.clone().multiplyScalar(speed), w: new THREE.Vector3(), age: 0, cop: false });
    const bodies = (ragdolls["dolls"] as Dolls)[ragdolls["lastSlot"]]!.bodies;
    if (torsoOnly) for (let k = 1; k < bodies.length; k++) bodies[k]!.collider(0).setCollisionGroups(0);
    const torso = bodies[0]!;
    const normal: number[] = [];
    const apart: number[] = [];
    for (let f = 0; f < FOLLOW; f++) {
      ragdolls.update(STEP, cars, true, false, 0, null);
      const v = torso.linvel();
      const t = torso.translation();
      normal.push(v.x * out.x + v.y * out.y + v.z * out.z);
      apart.push((t.x - aim.x) * out.x + (t.y - aim.y) * out.y + (t.z - aim.z) * out.z);
    }
    // The strike: the first step whose leading face is within 1 cm of the glass, or whose inward speed fell by over 1 m/s (stopped short of it).
    const at = apart.findIndex((d, f) => d < LEAD[pose] + 0.01 || (f > 0 && normal[f]! - normal[f - 1]! > 1));
    throws.push({ before: normal[Math.max(0, at - 1)]!, next: normal[at + 1]!, peakOut: Math.max(...normal.slice(at + 1, at + 13)), through: -Math.min(...apart) });
  }
  const glass = glassOf(car);
  ragdolls.dispose();
  return { throws, glass };
}

const show = (throws: readonly Strike[]): string => JSON.stringify(throws.map((s) => ({ before: +s.before.toFixed(2), next: +s.next.toFixed(2), peakOut: +s.peakOut.toFixed(2), through: +s.through.toFixed(3) })));

describe("given a parked car's glass (each pane intact, then cracked, then shattered) and a thrown dummy whose head and limbs touch nothing, so his torso alone meets the car", () => {
  const torsoStrikeCases = [
    { it: "when his torso strikes the windshield once at 10 m/s, then the windshield cracks and holds, and he bounces back off it", pane: "windshield", up: 0.1, along: 0, speeds: [10], expected: "cracked", goesThrough: false },
    { it: "when torsos strike the windshield twice at 10 m/s, then the second strike shatters it and that torso goes on through into the cabin", pane: "windshield", up: 0.1, along: 0, speeds: [10, 10], expected: "shattered", goesThrough: true },
    { it: "when his torso strikes the windshield at 3 m/s, under the 4 m/s that breaks glass, then the windshield stays intact and he bounces back off it", pane: "windshield", up: 0.1, along: 0, speeds: [3], expected: "intact", goesThrough: false },
    { it: "when his torso strikes the left door window once at 10 m/s, then the window cracks and holds, and he bounces back off it", pane: "doorL", up: 0.02, along: -0.18, speeds: [10], expected: "cracked", goesThrough: false },
    { it: "when torsos strike the left door window twice at 10 m/s, then the second strike shatters it and that torso goes on through into the cabin", pane: "doorL", up: 0.02, along: -0.18, speeds: [10, 10], expected: "shattered", goesThrough: true },
    { it: "when his torso strikes the left door window at 3 m/s, under the 4 m/s that breaks glass, then the window stays intact and he bounces back off it", pane: "doorL", up: 0.02, along: -0.18, speeds: [3], expected: "intact", goesThrough: false },
  ] as const;
  for (const testCase of torsoStrikeCases) {
    it(testCase.it, async (t) => {
      const { throws, glass } = await strikes(testCase.pane, testCase.up, testCase.along, "chest", true, testCase.speeds);
      t.diagnostic(`glass ${JSON.stringify(glass)}; throws ${show(throws)}`);
      for (const [name, state] of Object.entries(glass)) assert.equal(state, name === testCase.pane ? testCase.expected : "intact", `${name}'s state`);
      const last = throws.at(-1)!;
      assert.ok(last.before < -0.9 * testCase.speeds.at(-1)!, `the torso came at the pane at ${(-last.before).toFixed(2)} m/s`);
      if (testCase.goesThrough) {
        assert.ok(last.next < -0.9 * testCase.speeds.at(-1)!, `the step after the pane went it moved in at ${(-last.next).toFixed(2)} m/s`);
        assert.ok(last.through > LEAD.chest, `its centre got ${last.through.toFixed(3)} m past the glass, not its whole depth`);
      } else {
        assert.ok(last.peakOut > 0, `it never moved back out: at most ${last.peakOut.toFixed(2)} m/s out after the strike`);
        assert.ok(last.through < 0, `its centre got ${last.through.toFixed(3)} m past the glass`);
      }
    });
  }
});

describe("given a parked car's intact windshield and whole thrown dummies", () => {
  it("when two dummies strike it chest first at 10 m/s, one after the other, then the first leaves it cracked and the second shatters it", async (t) => {
    const once = await strikes("windshield", 0.1, 0, "chest", false, [10]);
    const twice = await strikes("windshield", 0.1, 0, "chest", false, [10, 10]);
    t.diagnostic(`once ${show(once.throws)}; twice ${show(twice.throws)}`);
    assert.equal(once.glass.windshield, "cracked");
    assert.equal(twice.glass.windshield, "shattered");
  });

  it("when a dummy strikes it head first at 10 m/s, arms up, then his arms and head stop him at the glass before his torso reaches it, and the windshield stays intact (only a torso breaks glass)", async (t) => {
    const { throws, glass } = await strikes("windshield", 0, 0, "head", false, [10]);
    t.diagnostic(`glass ${JSON.stringify(glass)}; torso ${show(throws)}`);
    const torso = throws[0]!;
    assert.ok(torso.before < -9 && torso.peakOut > -5, `the torso came at ${(-torso.before).toFixed(2)} m/s and went on at ${(-torso.peakOut).toFixed(2)} m/s or slower`);
    assert.ok(torso.through < -TORSO_HALF_LENGTH, `the torso's centre got within ${(-torso.through).toFixed(3)} m of the glass`);
    assert.equal(glass.windshield, "intact");
  });
});
