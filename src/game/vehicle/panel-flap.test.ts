import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "./car.ts";
import type { DetachPart } from "./car-core.ts";
import { applyDrive, type DriveInput } from "./car-drive.ts";
import { makeChassisGeometry } from "./car-mesh.ts";
import { makeShell, panelRegions, type PanelRegion, poseShell, STAND_MAX } from "./car-panels.ts";
import { CAR_STYLE_IDS, CAR_STYLES } from "./car-variants.ts";
import { flapAmp, FLAP_TEAR_MPS, PANEL_FRAGILE_T } from "./car-wear.ts";
import { physicsSlice, sliceSpeed } from "../contact/sat.ts";
import { newWorld, stepWorld } from "../engine/world-step.ts";
import { assertSameNumbers, DT, paint } from "./test-support.ts";

/**
 * Quarter panels stand off the body at most `STAND_MAX`; a panel stretched to `PANEL_FRAGILE_T` is easy to break (a fresh
 * contact, a scrape of the ground); every hinged panel flaps with the car's speed and wears off in sustained speed
 * (docs/PANEL_FLAP.md).
 */

class Probe extends DeformableCar {
  part(name: string): DetachPart {
    return this.parts.find((p) => p.name === name)!;
  }
  /** Hinge the panel to `t` through the game's own posing. */
  hang(name: string, t: number): DetachPart {
    const p = this.part(name);
    p.hingeT = t;
    this.posePart(p);
    return p;
  }
}

/** A car in the middle of a crash that has not touched the quarter panels (a nose tap, at `v` m/s). */
function crashed(v = 0): Probe {
  const car = new Probe(paint(), new THREE.Scene());
  car.deform.setMode("shape");
  car.spawnFacing(0, 0, 0, v);
  car.group.updateMatrixWorld(true);
  car.applyImpact(car.group.position.clone().addScaledVector(car.forward, 2.05), car.forward.clone().negate(), 0.5, 0.5);
  return car;
}

/** How far the free end of a quarter panel stands off the body (m) hinged to `t`: its lever turned by the peel angle. */
const standoff = (r: PanelRegion, t: number): number => r.reach * Math.sin(r.peel * t);

const IDLE: DriveInput = { throttle: 0, steer: 0, brake: 0, ebrake: false, boost: false };

/** Frames of the engine's own step: slices, drive held at `v` m/s, structure, skin. */
function run(car: Probe, frames: number, v: number | null = null): void {
  const w = newWorld([car]);
  let acc = 0;
  for (let f = 0; f < frames; f++) {
    acc = Math.min(0.05, acc + DT);
    while (acc > 1e-5) {
      const h = physicsSlice(acc, sliceSpeed(w.cars));
      if (v !== null) applyDrive(car, { ...IDLE, throttle: Math.max(0, Math.min(1, (v - car.speed) * 0.5 + 0.3)) }, h);
      stepWorld(w, h);
      car.stepBreakage(h);
      acc -= h;
    }
    car.updateSkin();
  }
}

describe("given a car body of any style with a hinged quarter panel (a quarter panel stands off the body at most STAND_MAX, the longest stand-off a panel may take)", () => {
  it("when the panel is at full hinge, then the free end of every style's quarter panel is within the longest stand-off", () => {
    for (const id of CAR_STYLE_IDS) {
      const body = makeChassisGeometry(CAR_STYLES[id]);
      const pos = body.getAttribute("position") as THREE.BufferAttribute;
      for (const r of panelRegions(CAR_STYLES[id], body).filter((q) => q.kind === "quarter")) {
        assert.ok(standoff(r, 1) <= STAND_MAX + 1e-9, `${id} ${r.name}: ${standoff(r, 1).toFixed(3)} m by the lever`);
        const shell = makeShell(r, body);
        poseShell(r, shell, body, 1, 0);
        const out = shell.getAttribute("position") as THREE.BufferAttribute;
        let far = 0;
        for (let k = 0; k < r.verts.length; k++) {
          const v = new THREE.Vector3().fromBufferAttribute(out, k).add(r.origin);
          far = Math.max(far, v.distanceTo(new THREE.Vector3().fromBufferAttribute(pos, r.verts[k]!)));
        }
        // The peel plus the 3 cm lift and the 4 mm skin.
        assert.ok(far <= STAND_MAX + 0.05, `${id} ${r.name}: a vertex ${far.toFixed(3)} m off its body vertex`);
        assert.ok(far > STAND_MAX * 0.8, `${id} ${r.name}: only ${far.toFixed(3)} m, the cap cut the peel away`);
      }
    }
  });

  it("when the hinge value grows from 0 to 1, then the sedan's quarter panel stands further off the body at each step", () => {
    const body = makeChassisGeometry(CAR_STYLES.sedan);
    const r = panelRegions(CAR_STYLES.sedan, body).find((q) => q.name === "quarterR")!;
    let last = -1;
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const s = standoff(r, t);
      assert.ok(s > last, `${t}: ${s}`);
      last = s;
    }
  });
});

describe("given a stretched panel on a crashed car (a panel stretched past its fragile hinge is easy to break)", () => {
  it("when a fresh contact touches a panel hinged past the fragile hinge value or one hinged 0.2 less, then the more hinged panel comes off and the other stays on", () => {
    for (const [t, off] of [
      [PANEL_FRAGILE_T + 0.1, true],
      [PANEL_FRAGILE_T - 0.2, false],
    ] as const) {
      const car = crashed();
      run(car, 40);
      const p = car.hang("quarterR", t);
      run(car, 20);
      assert.ok(!p.detached, `hinge ${t}: it came off with nothing touching it`);
      car.deform.notifyContact();
      run(car, 2);
      assert.equal(p.detached, off, `hinge ${t}: contact ${off ? "left it on" : "tore it"}`);
    }
  });

  it("when a contact goes on step after step and later one resumes after a pause, then the continuing contact does not tear the panel off and the resumed one does", () => {
    const car = crashed();
    const p = car.hang("quarterR", 0.7);
    // The crash's own contact: touching every step.
    for (let f = 0; f < 20; f++) {
      car.deform.notifyContact();
      run(car, 1);
    }
    assert.ok(!p.detached, "the contact that made the hinge tore it");
    run(car, 30);
    car.deform.notifyContact();
    run(car, 2);
    assert.ok(p.detached, "a touch after a pause left it on");
  });

  it("when the car sits 0.5 m below the ground, then a panel hinged to 0.7 scrapes off and one hinged to 0.3 does not", () => {
    for (const [t, off] of [
      [0.7, true],
      [0.3, false],
    ] as const) {
      const car = crashed();
      run(car, 40);
      const p = car.hang("quarterR", t);
      car.group.position.y = -0.5;
      car.group.updateMatrixWorld(true);
      car.stepBreakage(DT);
      assert.equal(p.detached, off, `hinge ${t}`);
    }
  });

  it("when the drawn body skin is thrown far below or high above the car, then whether the panel scrapes off is still decided on the simulation's state, never on the drawn skin (a replay draws at other times than the simulation it re-ran)", () => {
    // The same car and hinge, the body's drawn vertices (the skin the shell is posed on) thrown far below the car or high above it:
    // the scrape is the sim's, so no change.
    for (const [y, drawn, off] of [
      [-0.5, 5, true],
      [3, -5, false],
    ] as const) {
      const car = crashed();
      run(car, 40);
      const skin = car.body.geometry.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 1; i < skin.array.length; i += 3) (skin.array as Float32Array)[i] = drawn;
      const p = car.hang("quarterR", 0.7);
      car.group.position.y = y;
      car.group.updateMatrixWorld(true);
      car.stepBreakage(DT);
      assert.equal(p.detached, off, `car at ${y} m, drawn skin at ${drawn} m`);
    }
  });
});

/** The first time (s) `name` came off a crashed car cruising at `v` m/s with `name` hinged to `t`, or null in `secs`. */
function cruise(name: string, t: number, v: number, secs: number): number | null {
  const car = crashed(v);
  const p = car.part(name);
  const w = newWorld([car]);
  let acc = 0;
  for (let f = 0; f < secs * 60; f++) {
    p.hingeT = Math.max(p.hingeT, t);
    acc = Math.min(0.05, acc + DT);
    while (acc > 1e-5) {
      const h = physicsSlice(acc, sliceSpeed(w.cars));
      applyDrive(car, { ...IDLE, throttle: Math.max(0, Math.min(1, (v - car.speed) * 0.5 + 0.3)) }, h);
      stepWorld(w, h);
      car.stepBreakage(h);
      acc -= h;
    }
    car.updateSkin();
    if (p.detached) return f / 60;
  }
  return null;
}

describe("given a crashed car cruising with a hinged panel, sustained speed wears hinged panels and bumpers off", () => {
  it("when a quarter panel hinged to 0.6 cruises at 40 m/s or at 10 m/s, then it goes in under 2 s at 40 m/s and holds for 12 s at 10 m/s", () => {
    const fast = cruise("quarterR", 0.6, 40, 12);
    assert.ok(fast !== null && fast < 2, `off at ${fast}`);
    assert.equal(cruise("quarterR", 0.6, 10, 12), null);
  });

  it("when a lightly hinged quarter panel cruises at 40 m/s, then it takes longer to go than a stretched one, and a flat one never goes", () => {
    const light = cruise("quarterR", 0.3, 40, 12);
    const stretched = cruise("quarterR", 0.6, 40, 12)!;
    assert.ok(light !== null && light > stretched, `light ${light} vs stretched ${stretched}`);
    assert.equal(cruise("quarterR", 0, 40, 12), null);
  });

  it("when an arch flare and a hanging bumper cruise at 40 m/s, then they wear off in under 3 s, and below the tear speed they stay", () => {
    for (const name of ["archFL", "bumperF"]) {
      const at = cruise(name, 0.6, 40, 12);
      assert.ok(at !== null && at < 3, `${name} off at ${at}`);
      assert.equal(cruise(name, 0.6, FLAP_TEAR_MPS - 6, 12), null, `${name} at ${FLAP_TEAR_MPS - 6} m/s`);
    }
  });
});

/** Largest turn (rad) the shell mesh took off its rest transform over `frames` of a car holding `v` m/s. */
function flutter(name: string, t: number, v: number, frames = 90): number {
  const car = crashed();
  const p = car.hang(name, t);
  let most = 0;
  for (let f = 0; f < frames; f++) {
    car.velocity.set(0, 0, v);
    car.stepBreakage(DT);
    car.updateSkin();
    most = Math.max(most, p.object.quaternion.angleTo(p.restQuat));
  }
  return most;
}

describe("given a hinged panel on a crashed car, its flutter follows the car's speed", () => {
  it("when the car goes from rest up to 21 m/s (below the tear speed), then the quarter panel's flutter is 0 at rest and grows with speed", () => {
    const at = [0, 8, 15, 21].map((v) => flutter("quarterR", 0.4, v));
    assert.equal(at[0], 0, "a parked car's panel moved");
    for (let i = 1; i < at.length; i++) assert.ok(at[i]! > at[i - 1]!, `flutter ${at.map((a) => a.toFixed(3)).join(" < ")}`);
    // The amplitude is the model's, 90 frames reach most of the wave.
    assert.ok(at[3]! > 0.5 * flapAmp(21, 0.4) && at[3]! <= flapAmp(21, 0.4) + 1e-6, `${at[3]} against ${flapAmp(21, 0.4)}`);
  });

  it("when an arch flare and a hanging bumper are driven faster, then the flare turns about its top and the bumper rolls more, and neither moves at rest", () => {
    assert.equal(flutter("archFL", 0.4, 0), 0);
    assert.ok(flutter("archFL", 0.4, 20) > 0.02);
    const car = crashed();
    const b = car.hang("bumperF", 0.4);
    const roll = (v: number) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (let f = 0; f < 90; f++) {
        car.velocity.set(0, 0, v);
        car.stepBreakage(DT);
        car.updateSkin();
        lo = Math.min(lo, b.object.rotation.z);
        hi = Math.max(hi, b.object.rotation.z);
      }
      return hi - lo;
    };
    const still = roll(0);
    assert.equal(still, 0, "a parked bumper swung");
    assert.ok(roll(20) > 0.03, "a bumper at speed did not flap");
  });

  it("when the same run is made twice, then the flutter agrees and never rebuilds the shell", () => {
    const trace = () => {
      const car = crashed();
      run(car, 120);
      const p = car.hang("quarterR", 0.4);
      const mesh = p.object as THREE.Mesh;
      const out: number[] = [];
      const uploads = (mesh.geometry.getAttribute("position") as THREE.BufferAttribute).version;
      for (let f = 0; f < 60; f++) {
        car.velocity.set(0, 0, 18);
        car.stepBreakage(DT);
        car.updateSkin();
        out.push(p.object.quaternion.y, p.object.position.x, p.object.position.z);
      }
      assert.equal((mesh.geometry.getAttribute("position") as THREE.BufferAttribute).version, uploads, "a flapping shell was rebuilt");
      return out;
    };
    assertSameNumbers(trace(), trace(), "flutter trace");
  });

  it("when a quarter panel flutters at 20 m/s, then it flutters about its tail and the tail end stays on the body", () => {
    const car = crashed();
    const p = car.hang("quarterR", 0.4);
    const r = p.region!;
    car.velocity.set(0, 0, 20);
    for (let f = 0; f < 30; f++) {
      car.stepBreakage(DT);
      car.updateSkin();
    }
    // A point on the hinge line (x, z) = pivot stays where it was whatever the angle.
    const tail = new THREE.Vector3(r.pivot[0], r.origin.y, r.pivot[1]).sub(r.origin);
    const before = tail.clone().add(r.origin);
    const after = tail.clone().applyQuaternion(p.object.quaternion).add(p.object.position);
    assert.ok(before.distanceTo(after) < 1e-6, `the hinge line moved ${before.distanceTo(after)} m`);
  });
});
