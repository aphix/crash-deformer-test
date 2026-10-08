import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import { type CrashWorld, launch, makeCar, makeWorld, tickWorld } from "../contact/crash-scenarios.test-util.ts";
import { assertSameDigest } from "../vehicle/test-support.ts";
import { headOn } from "../vehicle/ejection.test-util.ts";
import type { GlassName } from "../vehicle/car-core.ts";
import { glassOf } from "../vehicle/car-glass.test-util.ts";
import { B_PILLAR_Z } from "../vehicle/car-mesh.ts";
import { RagdollSystem } from "./engine-ragdoll.ts";

const FRAME = 1 / 60;

/** Every car's whole sim state: pose, velocities, each mass, the drivetrain. */
function simState(cars: readonly DeformableCar[]): number[] {
  return cars.flatMap((c) => [
    ...c.group.position.toArray(),
    ...c.group.quaternion.toArray(),
    ...c.velocity.toArray(),
    ...c.angular.toArray(),
    ...c.deform.masses.flatMap((m) => [...m.world.toArray(), ...m.vel.toArray()]),
    c.deform.drivetrainAlive ? 1 : 0,
    c.deform.engineTravel,
  ]);
}

describe("given thrown drivers (dummies that are cosmetic: the cars move the same with or without them)", () => {
  const crashes = [
    { label: "a 2×56 km/h head-on that kills both engines", pair: () => {
      const [a, b] = [makeCar(), makeCar()];
      launch(a, -5, 0, Math.PI / 2, 56 / 3.6, 0);
      launch(b, 5, 0, -Math.PI / 2, -56 / 3.6, 0);
      return [a, b];
    } },
    { label: "a fleet 2×72 km/h head-on whose cars run on", pair: () => headOn(20) },
  ];
  for (const { label, pair } of crashes) {
    for (const sandbox of [true, false]) {
      it(`when ${sandbox ? "the sandbox" : "a race or a derby"} runs ${label} and both drivers are thrown, then both dummies fly, the cars move as they do without dummies, and ${sandbox ? "the ride-along slow-mo is asked for both drivers" : "no ride-along slow-mo is asked"}`, async () => {
        const cars = pair();
        const plain = pair();
        const scene = new THREE.Scene();
        const rideAlong: number[] = [];
        const ragdolls = new RagdollSystem(scene, (i) => rideAlong.push(i), () => {});
        await ragdolls.preload();
        const w = makeWorld(cars, false, false);
        w.onEject = (e) => ragdolls.launch(e, cars);
        const wPlain = makeWorld(plain, false, false);
        for (let f = 0; f < 240; f++) {
          tickWorld(w);
          tickWorld(wPlain);
          ragdolls.update(FRAME, cars, true, sandbox, 0, null);
        }
        assert.ok(scene.getObjectByName("ragdolls")!.visible, "the dummies fly in every mode");
        ragdolls.dispose();
        assertSameDigest(simState(cars), simState(plain), "every car's sim state with dummies vs without");
        assert.equal(rideAlong.join(), sandbox ? "0,1" : "", "ride-along / slow-mo requests");
      });
    }
  }
});

describe("given a fleet 2×36 km/h head-on that crashes both cars, cracks their windshields and leaves the rest of their glass whole, and a dummy's torso that strikes their glass (each strike cracks a pane, the next shatters it)", () => {
  it("when every pane of both cars is struck twice in the second after the hit, then every pane ends shattered and the cars move exactly as they do with the glass left to the crash", () => {
    const cars = headOn(10);
    const plain = headOn(10);
    const w = makeWorld(cars, false, false);
    const wPlain = makeWorld(plain, false, false);
    const panes = ["windshield", "rear", "doorL", "doorR", "quarterL", "quarterR"] as const;
    const first = 24;
    for (let f = 0; f < 240; f++) {
      tickWorld(w);
      tickWorld(wPlain);
      // From 0.4 s (the hit lands about 0.3 s in), a strike every other frame: every pane of both cars twice over.
      const k = (f - first) / 2;
      if (Number.isInteger(k) && k >= 0 && k < 2 * 2 * panes.length) cars[k % 2]!.hitGlass(panes[(k >> 1) % panes.length]!);
    }
    assert.ok(cars.every((c) => c.crashed), "both cars crashed");
    let allShattered = 0;
    for (let p = 0; p < panes.length; p++) allShattered |= 2 << (2 * p);
    for (const [i, car] of cars.entries()) assert.equal(car.glassBits(), allShattered, `car ${i}: every pane struck twice is gone`);
    assert.ok(plain.some((c) => c.glassBits() !== allShattered), "the crash alone left some pane unshattered");
    assertSameDigest(simState(cars), simState(plain), "every car's sim state with struck glass vs without");
  });
});

describe("given a head-on crash between two fleet cars whose physics engine for the dummies loads late", () => {
  /** The fleet head-on with Rapier loading `late` frames in (the hit lands about 0.2 s in): dummies out at the end. */
  async function thrownAfterLoad(late: number): Promise<boolean> {
    const cars = headOn(20);
    const scene = new THREE.Scene();
    const ragdolls = new RagdollSystem(scene, () => {}, () => {});
    const w = makeWorld(cars, false, false);
    w.onEject = (e) => ragdolls.launch(e, cars);
    for (let f = 0; f < 150; f++) {
      if (f === late) await ragdolls.preload();
      tickWorld(w);
      ragdolls.update(FRAME, cars, true, true, 0, null);
    }
    const out = scene.getObjectByName("ragdolls")!.visible;
    ragdolls.dispose();
    return out;
  }

  it("when the physics engine loads 0.5 s into the run, then the driver is still thrown", async () => {
    assert.equal(await thrownAfterLoad(42), true);
  });

  it("when the physics engine loads more than a second after the hit, then the throw is dropped and no dummy flies", async () => {
    assert.equal(await thrownAfterLoad(120), false);
  });
});

/** A car's cabin at rest size in its own frame (m; +z forward, −x its left): a crushed nose ahead of it is not inside. */
const CABIN = new THREE.Box3(new THREE.Vector3(-0.7, 0.8, -0.75), new THREE.Vector3(0.7, 1.34, 0.61));

/**
 * The cabin face a torso moving from `from` (outside) to `to` (inside) came in through: of the faces `from` is beyond, the
 * one its path crosses last. A side face is a door's pane ahead of the B pillar and a quarter pane behind it.
 */
function entryFace(from: THREE.Vector3, to: THREE.Vector3): GlassName | "roof" | "lower body" | "B pillar" {
  let axis = 0;
  let last = -Infinity;
  for (let a = 0; a < 3; a++) {
    const start = from.getComponent(a);
    const low = CABIN.min.getComponent(a);
    const high = CABIN.max.getComponent(a);
    if (start >= low && start <= high) continue;
    const along = ((start < low ? low : high) - start) / (to.getComponent(a) - start);
    if (along > last) {
      last = along;
      axis = a;
    }
  }
  if (axis === 1) return from.y > CABIN.max.y ? "roof" : "lower body";
  if (axis === 2) return from.z > CABIN.max.z ? "windshield" : "rear";
  const z = from.z + (to.z - from.z) * last;
  if (z >= B_PILLAR_Z.front) return from.x < 0 ? "doorL" : "doorR";
  if (z <= B_PILLAR_Z.rear) return from.x < 0 ? "quarterL" : "quarterR";
  return "B pillar";
}

/**
 * Runs `w` and the dummies for 2 s and lists each time a dummy's torso came into the cabin of the car `facing(slot)` other
 * than through a pane already shattered: the frame, the slot, its way in and that pane's state.
 */
function wrongCabinEntries(w: CrashWorld, ragdolls: RagdollSystem, facing: (slot: number) => DeformableCar): string[] {
  const inv = new THREE.Quaternion();
  // Each slot's torso last frame, in its car's frame.
  const was = new Map<number, THREE.Vector3>();
  const local = new THREE.Vector3();
  const wrong: string[] = [];
  for (let f = 0; f < 120; f++) {
    tickWorld(w);
    ragdolls.update(FRAME, w.cars, true, true, 0, null);
    for (const [s, d] of ragdolls["dolls"].entries()) {
      if (!d.live) continue;
      const car = facing(s);
      const t = d.bodies[0]!.translation();
      local.set(t.x, t.y, t.z).sub(car.group.position).applyQuaternion(inv.copy(car.group.quaternion).invert());
      const from = was.get(s);
      if (CABIN.containsPoint(local) && !(from && CABIN.containsPoint(from))) {
        const face = from ? entryFace(from, local) : "thrown in";
        const pane = glassOf(car)[face];
        if (pane !== "shattered") wrong.push(`frame ${f} dummy ${s} through ${face}${pane ? ` (${pane})` : ""}`);
      }
      was.set(s, (from ?? new THREE.Vector3()).copy(local));
    }
  }
  ragdolls.dispose();
  return wrong;
}

describe("given a fleet head-on crash that throws both drivers", () => {
  it("when the dummies fly for 2 s, then each driver flies into the other car and enters its cabin only through a pane already shattered, never through its roof, its lower body, a pillar or standing glass", async () => {
    const cars = headOn(20);
    const ragdolls = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
    await ragdolls.preload();
    const w = makeWorld(cars, false, false);
    w.onEject = (e) => ragdolls.launch(e, cars);
    // Slots fill in car order: car 0's driver first, and each flies at the other car.
    assert.deepEqual(wrongCabinEntries(w, ragdolls, (slot) => cars[1 - slot]!), [], "a torso entered the other car's cabin where no pane is gone");
  });
});

describe("given a parked car with its glass whole", () => {
  it("when a dummy drops onto its roof from 1 m over it, then he never enters its cabin", async () => {
    const car = makeCar();
    const ragdolls = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
    await ragdolls.preload();
    const w = makeWorld([car], false, false);
    const over = new THREE.Vector3(0, CABIN.max.y + 1, (CABIN.min.z + CABIN.max.z) / 2);
    ragdolls.place(over, new THREE.Quaternion(), new THREE.Vector3(), new THREE.Vector3(), 2, -1);
    assert.deepEqual(wrongCabinEntries(w, ragdolls, () => car), [], "a torso entered the cabin of a car with no pane gone");
  });
});
