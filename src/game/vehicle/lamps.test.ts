import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "./car.ts";
import { LampLights, SPOT_POOL } from "./lamp-lights.ts";
import { DT, forModes, paint } from "./test-support.ts";

type LampRow = { kind: string; side: number; intact: boolean; on: boolean };
/** Lamp order inside the car: head L, head R, tail L, tail R. */
const HEAD_L = 0;
const HEAD_R = 1;

function lampRows(car: DeformableCar): LampRow[] {
  const snap = car.snapshot() as { lamps: LampRow[] }; // snapshot() is the test-facing record
  return snap.lamps;
}

/** Where lamp `i` is seated on the body skin, in car space. */
function lampLocal(car: DeformableCar, i: number): THREE.Vector3 {
  const p = new THREE.Vector3();
  car.lampWorld(i, p, new THREE.Vector3());
  return car.group.worldToLocal(p);
}

/** Distance (m) from a car-space point to the nearest facet of the current body skin. */
function offSkin(car: DeformableCar, p: THREE.Vector3): number {
  const pos = car.body.geometry.getAttribute("position");
  const index = car.body.geometry.index!;
  const tri = new THREE.Triangle();
  const q = new THREE.Vector3();
  let best = Infinity;
  for (let t = 0; t < index.count; t += 3) {
    tri.a.fromBufferAttribute(pos, index.getX(t));
    tri.b.fromBufferAttribute(pos, index.getX(t + 1));
    tri.c.fromBufferAttribute(pos, index.getX(t + 2));
    best = Math.min(best, tri.closestPointToPoint(p, q).distanceTo(p));
  }
  return best;
}

/** Wall pushed into the front-left corner only (car-local x = −0.7). */
function crushFrontLeft(car: DeformableCar, deferSkin = false): void {
  car.group.updateMatrixWorld();
  const hit = car.group.position.clone().addScaledVector(car.forward, 2.0).addScaledVector(car.right, -0.7);
  hit.y = 0.4;
  const inward = car.forward.clone().negate();
  car.applyImpact(hit, inward, 22, 22);
  for (let i = 0; i < 20; i++) {
    car.deform.notifyContact();
    car.deform.feedOverlap(hit, inward, 0.08, 10, DT);
    car.deform.stepStructure(DT);
    car.syncPose(DT);
    car.deform.skinDeferred = deferSkin;
    car.updateDeform(DT);
  }
}

function spawned(mode: "lattice" | "shape"): DeformableCar {
  const car = new DeformableCar(paint(), new THREE.Scene());
  car.deform.setMode(mode);
  car.spawn(8, 12, 14);
  return car;
}

forModes("lamps live on the body and break per corner", (mode) => {
  it("good: a front-left crush puts out the left headlamp alone", () => {
    const car = spawned(mode);
    crushFrontLeft(car);
    const rows = lampRows(car);
    const out = rows.filter((l) => !l.intact).map((l) => `${l.kind}${l.side < 0 ? "L" : "R"}`);
    assert.deepEqual(out, ["headL"], `lamps out: ${out.join(",") || "none"}`);
    assert.ok(rows.every((l) => l.on === l.intact), "a lamp's glow must follow its intact state");
  });

  it("good: the crushed corner carries its lamp with the skin, and the lamp stays seated on it", () => {
    const car = spawned(mode);
    const rest = lampLocal(car, HEAD_L);
    crushFrontLeft(car);
    const lamp = lampLocal(car, HEAD_L);
    assert.ok(lamp.distanceTo(rest) > 0.03, `left headlamp did not follow the crushed skin (moved ${lamp.distanceTo(rest).toFixed(3)} m)`);
    for (const i of [HEAD_L, HEAD_R]) {
      const gap = offSkin(car, lampLocal(car, i));
      assert.ok(gap < 0.005, `lamp ${i} floats ${gap.toFixed(3)} m off the skin`);
    }
  });

  it("close-but-wrong: a deferred (LoD) skin re-seats the lamp when it is flushed, not before", () => {
    const car = spawned(mode);
    const rest = lampLocal(car, HEAD_L);
    crushFrontLeft(car, true);
    assert.ok(lampLocal(car, HEAD_L).distanceTo(rest) < 1e-6, "lamp moved while its skin was deferred");
    car.flushDeferredSkin();
    const lamp = lampLocal(car, HEAD_L);
    assert.ok(lamp.distanceTo(rest) > 0.03, "flushing the owed skin left the lamp behind");
    assert.ok(offSkin(car, lamp) < 0.005, "flushed lamp is off the skin");
  });
});

describe("a detached bumper leaves the lamps behind", () => {
  it("bad: tearing the front bumper off with no corner crush keeps every lamp lit and on the body", () => {
    const car = new DeformableCar(paint(), new THREE.Scene());
    car.spawn(8, 12, 0);
    const before = [0, 1, 2, 3].map((i) => lampLocal(car, i));
    const priv = car as unknown as { parts: { name: string; object: THREE.Object3D }[]; detachPart(p: unknown, impulse: number): void };
    const bumper = priv.parts.find((p) => p.name === "bumperF")!;
    const bumperAt = bumper.object.getWorldPosition(new THREE.Vector3());
    priv.detachPart(bumper, 20);
    for (let i = 0; i < 30; i++) car.step(DT);
    assert.ok(bumper.object.getWorldPosition(new THREE.Vector3()).distanceTo(bumperAt) > 0.2, "bumper never left the car");
    assert.ok(lampRows(car).every((l) => l.intact && l.on), "a lamp went out with the bumper");
    for (let i = 0; i < 4; i++) {
      const d = lampLocal(car, i).distanceTo(before[i]!);
      assert.ok(d < 1e-4, `lamp ${i} moved ${d.toFixed(4)} m relative to the body`);
    }
  });
});

describe("lamp light pool", () => {
  /** Followed car far ahead, a nearer car between, a nearest car behind the camera. */
  function rig(): { lights: LampLights; scene: THREE.Scene; camera: THREE.PerspectiveCamera; far: DeformableCar; near: DeformableCar; behind: DeformableCar } {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 200);
    camera.position.set(0, 3, -10);
    camera.lookAt(0, 0, 20);
    const far = new DeformableCar(paint(), scene);
    const near = new DeformableCar(paint(), scene);
    const behind = new DeformableCar(paint(), scene);
    far.spawnFacing(0, 30, 0, 0);
    near.spawnFacing(3, 4, 0, 0);
    behind.spawnFacing(0, -16, 0, 0);
    return { lights: new LampLights(scene, 12), scene, camera, far, near, behind };
  }

  const lightCount = (scene: THREE.Scene): number => {
    let n = 0;
    scene.traverseVisible((o) => {
      if (o instanceof THREE.Light) n++;
    });
    return n;
  };
  /** Is a lit spot sitting on one of `car`'s headlamps? */
  const spotOn = (s: THREE.SpotLight, car: DeformableCar): boolean => {
    const p = new THREE.Vector3();
    for (const i of [HEAD_L, HEAD_R]) {
      car.lampWorld(i, p, new THREE.Vector3());
      if (s.intensity > 0 && p.distanceTo(s.position) < 1e-6) return true;
    }
    return false;
  };

  it("good: the followed car's headlamps get spots first, then the nearest on-screen ones; every intact lamp glows", () => {
    const { lights, camera, far, near, behind } = rig();
    lights.update([far, near, behind], camera, far);
    const want = [far, far, near, near].slice(0, SPOT_POOL);
    want.forEach((car, k) => assert.ok(spotOn(lights.spots[k]!, car), `spot ${k} is not on the expected car`));
    assert.equal(lights.glow.geometry.drawRange.count, 12);
  });

  it("bad: a broken lamp never gets a light or a glow; spare spots go dark, never away", () => {
    const { lights, scene, camera, far, near } = rig();
    lights.update([far, near], camera, far);
    const count = lightCount(scene);
    const priv = far as unknown as { lamps: unknown[]; breakLamp(l: unknown): void };
    priv.breakLamp(priv.lamps[HEAD_L]);
    priv.breakLamp(priv.lamps[HEAD_R]);
    lights.update([far, near], camera, far);
    assert.ok(lights.spots.every((s) => !spotOn(s, far)), "a broken headlamp kept its spot");
    assert.equal(lights.spots.filter((s) => spotOn(s, near)).length, Math.min(2, SPOT_POOL));
    assert.ok(lights.spots.slice(2).every((s) => s.intensity === 0), "an unassigned spot stayed lit");
    assert.equal(lights.glow.geometry.drawRange.count, 6);
    assert.equal(lightCount(scene), count, "the pool added or hid a light");
  });

  it("good: police sirens flash red then blue, each lit lens taking a pooled point in its colour; off, nothing", () => {
    const { lights, scene, camera, far } = rig();
    const cop = new DeformableCar(paint(), scene, null, "police");
    cop.spawnFacing(-3, 8, 0, 0);
    const count = lightCount(scene);
    // A tail point is dim red (0.5); a siren point is bright (3), red or blue.
    const sirenPoints = () => lights.points.filter((p) => p.intensity > 1);
    lights.update([far, cop], camera, far, 0.1);
    assert.equal(sirenPoints().length, 0, "a siren lit with the sirens off");
    assert.equal(lights.glow.geometry.drawRange.count, 8);

    cop.setSirens(true);
    for (const [now, red] of [[0.1, true], [0.35, false], [0.6, true]] as const) {
      lights.update([far, cop], camera, far, now);
      const lit = sirenPoints();
      assert.equal(lit.length, 1, `t=${now}: ${lit.length} siren points`);
      assert.equal(lit[0]!.color.r > lit[0]!.color.b, red, `t=${now}: wrong colour`);
      assert.ok(lit[0]!.position.y > 1.4, `t=${now}: siren light at y=${lit[0]!.position.y.toFixed(2)}, not over the roof`);
      assert.equal(lights.glow.geometry.drawRange.count, 9);
    }
    assert.equal(lightCount(scene), count, "sirens added or hid a light");

    cop.setSirens(false);
    lights.update([far, cop], camera, far, 0.1);
    assert.equal(sirenPoints().length, 0, "sirens stayed lit after setSirens(false)");
    assert.equal(new DeformableCar(paint(), scene).lampCount, 4, "a car without a light bar grew siren slots");
  });
});
