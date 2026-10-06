import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "./car.ts";
import { applyDrive, type DriveInput } from "./car-drive.ts";
import { assignClass } from "./vehicle-classes.ts";
import { paint } from "./test-support.ts";
import { makeWorld, tickWorld, type CrashWorld } from "../contact/crash-scenarios.test-util.ts";
import { Ground, setGround } from "../world/ground.ts";

/**
 * E2 of docs/UNIFIED_CONTACT.md (7.2), as measured on main 5ad7839 (section 10): a settled sedan stack leaves the top car's
 * tyres 0.23-0.41 m over the car below (belly on the roof's crown, hood and trunk far under it), so no tyre model drives it;
 * a monster's belly rides 0.48 m over its tyre plane, so on a sedan's roof its tyres stand on the hood and trunk. A car
 * touching only with its belly is resting, not flying, and has no drive (its wheels are free).
 */
const FRAME = 1 / 60;
const FULL: DriveInput = { throttle: 1, steer: 0, brake: 0, ebrake: false, boost: false };

/** A flat asphalt platform at height `y`, under everything. */
class Platform extends Ground {
  constructor(y: number) {
    super();
    this.addPlane(y, -1e4, 1e4, -1e4, 1e4, Infinity);
  }
}

function car(cls: "sedan" | "monster", y: number, airborne: boolean): DeformableCar {
  const c = new DeformableCar(paint(), new THREE.Scene());
  assignClass(c, cls);
  c.spawnFacing(0, 0, 0, 0);
  c.group.position.y = y;
  c.airborne = airborne;
  return c;
}

function settle(w: CrashWorld, seconds: number): void {
  for (let f = 0; f < seconds / FRAME; f++) tickWorld(w, FRAME);
}

/** Full throttle for 1.5 s: the speed after 0.25, 0.5, 1.0 and 1.5 s, the z it has reached, and whether it was ever airborne in its first 0.2 s. */
function driveOff(w: CrashWorld, c: DeformableCar): { v: number[]; z: number; airEarly: boolean } {
  const v = [0, 0, 0, 0];
  let airEarly = false;
  for (let f = 1; f <= 90; f++) {
    applyDrive(c, FULL, FRAME);
    tickWorld(w, FRAME);
    if (f <= 12 && c.airborne) airEarly = true;
    const k = f === 15 ? 0 : f === 30 ? 1 : f === 60 ? 2 : f === 90 ? 3 : -1;
    if (k >= 0) v[k] = Math.hypot(c.velocity.x, c.velocity.z);
  }
  return { v, z: c.group.position.z, airEarly };
}

describe("given a monster truck resting with its belly on a sedan's roof and its tyres on the hood and trunk", () => {
  afterEach(() => setGround(null));

  it("when it drives at full throttle, then it is never flagged airborne while its tyres are on the sedan, its speed after 0.25 s is within 5 % of the same truck on a flat platform at its rest height, and it has driven off the sedan and onto the ground by 1.5 s", (t) => {
    const sedan = car("sedan", 0, false);
    const truck = car("monster", 0.8, true);
    const stack = makeWorld([sedan, truck], false, false);
    settle(stack, 5);
    const y = truck.group.position.y;
    const top = driveOff(stack, truck);
    setGround(new Platform(y));
    const flat = car("monster", y, false);
    const platform = makeWorld([flat], false, false);
    settle(platform, 5);
    const ref = driveOff(platform, flat);
    t.diagnostic(`rest y ${y.toFixed(3)}; on the sedan ${top.v.map((s) => s.toFixed(2)).join("/")} m/s, z ${top.z.toFixed(1)}, airborne early ${top.airEarly}; on the platform ${ref.v.map((s) => s.toFixed(2)).join("/")} m/s`);
    assert.ok(!top.airEarly, "flagged airborne in its first 0.2 s with its tyres on the sedan");
    assert.ok(Math.abs(top.v[0]! - ref.v[0]!) <= 0.05 * ref.v[0]!, `0.25 s: ${top.v[0]!.toFixed(2)} m/s against the platform's ${ref.v[0]!.toFixed(2)}`);
    assert.ok(top.z > 5, `drove only ${top.z.toFixed(1)} m in 1.5 s`);
    assert.ok(truck.group.position.y < 0.8, `still up at y ${truck.group.position.y.toFixed(2)}`);
  });
});

describe("given a sedan resting belly-down on another sedan's roof, its tyres 0.3 m off the hood and trunk", () => {
  it("when it stands there for 2 s and then drives at full throttle for 2 s, then it is resting, not flying, and its wheels free: it is never airborne and does not move", (t) => {
    const lower = car("sedan", 0, false);
    const upper = car("sedan", 1.19, true);
    const w = makeWorld([lower, upper], false, false);
    settle(w, 8);
    let air = 0;
    const z0 = upper.group.position.z;
    for (let f = 0; f < 120; f++) {
      if (upper.airborne) air++;
      tickWorld(w, FRAME);
    }
    for (let f = 0; f < 120; f++) {
      applyDrive(upper, FULL, FRAME);
      tickWorld(w, FRAME);
      if (upper.airborne) air++;
    }
    const moved = Math.abs(upper.group.position.z - z0);
    t.diagnostic(`y ${upper.group.position.y.toFixed(3)}, flagged airborne in ${air} of 240 frames, moved ${moved.toFixed(3)} m`);
    assert.equal(air, 0, `flagged airborne in ${air} frames while resting on the roof`);
    assert.ok(moved < 0.05, `moved ${moved.toFixed(3)} m with no tyre on anything`);
  });
});
