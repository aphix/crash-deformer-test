import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyDrive, DRIVE, idleDrive, THROTTLE_STEPS, type DriveInput } from "./car-drive.ts";
import type { DeformableCar } from "./car.ts";
import { FLIGHT } from "./car-flight.ts";
import { makeCar } from "./ground-probe.test-util.ts";
import { carGear, carRpm, CLASSES, gearHi, gearLo, HANDLING, rollingOver, rotatingShare, terminalSpeed, tractionLimit, VEHICLE_CLASS_IDS, type ClassStats, type Driveline, type VehicleClassId } from "./vehicle-classes.ts";
import { Ground, setGround } from "../world/ground.ts";
import { SURFACE } from "../world/constants.ts";
import { SURFACE_IDS, SURFACES, type SurfaceId } from "../world/catalog.ts";
import { FINE_HZ, QUIET_HZ } from "../kernel/constants.ts";
import { FRICTION_G } from "../deform/physics-util.ts";

// The engine's pull reaches the road through the driven axles' traction (`tractionLimit`, by the class's driveline layout); what the road
// won't take spins the driven wheels (`drive.spinSpeed`, Uncharted 4 15:42-16:55), which revs the gauge and fades those axles' sideways grip.

const RATES = [1 / QUIET_HZ, 1 / FINE_HZ] as const;
const DEFAULT_REALISM = HANDLING.realism;
const LAYOUTS: readonly Driveline[] = ["fwd", "rwd", "awd", "4wd"];
const FULL: DriveInput = { ...idleDrive(), throttle: 1 };
/** Seconds a launch is watched for its spin to build, and a lift for it to fade. */
const BUILD_S = 1;
const FADE_S = 1;
/** The slip ratio a launch on grass passes (measured peak 0.79) and the gauge drop that reads as an upshift. */
const SPIN_PASSED = 0.6;
const SHIFT_DROP = 0.3;

afterEach(() => {
  HANDLING.realism = DEFAULT_REALISM;
  setGround(null);
});

/** A flat ground of one surface, or split under the car's middle: `rear` behind z = 0, `front` ahead of it. */
function flat(front: SurfaceId, rear = front): Ground {
  const g = new Ground();
  const wide = { nu: 2, nv: 2, step: 2e7, u0: -1e7, heights: new Float32Array(4), ox: 0, oy: 0, oz: 0, reach: Infinity };
  g.addGrid({ ...wide, stepV: 1e7, v0: 0, surface: SURFACE_IDS.indexOf(front) });
  g.addGrid({ ...wide, stepV: 1e7, v0: -1e7, surface: SURFACE_IDS.indexOf(rear) });
  return g;
}

function along(car: DeformableCar): number {
  return car.velocity.x * car.fwdFlat.x + car.velocity.z * car.fwdFlat.z;
}

/** `cls` from rest at the origin on `ground`, driven `seconds` with `input` per slice `h`; `each` sees the car after every slice. */
function drive(cls: VehicleClassId, ground: Ground, seconds: number, h: number, input: DriveInput, each: (car: DeformableCar, t: number) => void, car = makeCar(cls)): DeformableCar {
  setGround(ground);
  if (car.velocity.lengthSq() === 0) car.spawnFacing(0, 0, 0, 0);
  for (let t = 0; t < seconds; t += h) {
    applyDrive(car, input, h);
    car.integrate(h);
    each(car, t + h);
  }
  return car;
}

describe("given the traction law of each driveline layout (a pure function of the axle grips)", () => {
  const on = (drive: Driveline, muF: number, muR: number, realism: number) => tractionLimit({ ...CLASSES.sedan, drive } as ClassStats, muF, muR, realism);

  it("when both axles stand on dry asphalt, then every layout passes the class's launch pull at both ends of the slider (the sourced launch was driven on real tyres: a cap under it would count the tyre twice)", () => {
    for (const layout of LAYOUTS) {
      assert.ok(Math.abs(on(layout, 1, 1, 0) - CLASSES.sedan.launch[0]) < 1e-9, `${layout} arcade`);
      assert.ok(Math.abs(on(layout, 1, 1, 1) - CLASSES.sedan.launch[1]) < 1e-9, `${layout} realistic`);
    }
  });

  it("when the rear axle stands on half the grip, then a front-driven car keeps its launch, a rear-driven one is halved, an open-centre car is limited by its slipping rear (as the rear-driven one at the arcade end) and a locked 4wd lands between", () => {
    for (const realism of [0, 1]) {
      const launch = CLASSES.sedan.launch[realism]!;
      const fwd = on("fwd", 1, 0.5, realism);
      const rwd = on("rwd", 1, 0.5, realism);
      const awd = on("awd", 1, 0.5, realism);
      const locked = on("4wd", 1, 0.5, realism);
      const got = `realism ${realism}: fwd ${fwd.toFixed(2)}, rwd ${rwd.toFixed(2)}, awd ${awd.toFixed(2)}, 4wd ${locked.toFixed(2)} of ${launch}`;
      assert.ok(Math.abs(fwd - launch) < 1e-9, got);
      assert.ok(rwd <= 0.5 * launch + 1e-9 && rwd > 0, got);
      assert.ok((realism === 0 ? Math.abs(awd - rwd) < 1e-9 : awd > rwd && awd < fwd) && locked > rwd && locked < fwd, got);
    }
    // Mirrored grips mirror the one-axle layouts at the arcade end (no load transfer there).
    assert.ok(Math.abs(on("rwd", 0.5, 1, 0) - CLASSES.sedan.launch[0]) < 1e-9 && Math.abs(on("fwd", 0.5, 1, 0) - on("rwd", 1, 0.5, 0)) < 1e-9, "mirrored");
  });

  it("when the grip is halved under both axles at the realistic end, then a locked 4wd keeps exactly half its launch, a front-driven car a little more (its transfer penalty shrinks with the grip) and a rear-driven car less (its transfer gain shrinks)", () => {
    const kept = (drive: Driveline) => on(drive, 0.5, 0.5, 1) / CLASSES.sedan.launch[1];
    const fwd = kept("fwd");
    const rwd = kept("rwd");
    const locked = kept("4wd");
    assert.ok(Math.abs(locked - 0.5) < 1e-9 && rwd < 0.5 && fwd > 0.5 && fwd < 0.6, `kept: fwd ${fwd.toFixed(3)}, rwd ${rwd.toFixed(3)}, 4wd ${locked.toFixed(3)}`);
  });
});

for (const H of RATES) {
  describe(`at ${Math.round(1 / H)} Hz`, () => {
    describe("given a car launched flat out with its front wheels on asphalt and its rear wheels on grass", () => {
      it("when it is front-driven (the sedan), then its wheels never spin; when it is rear-driven (the police car), then they spin past 0.3 within 0.3 s; with the surfaces swapped, the reverse", () => {
        const peak = (cls: VehicleClassId, front: SurfaceId, rear: SurfaceId) => {
          let most = 0;
          drive(cls, flat(front, rear), 0.3, H, FULL, (car) => (most = Math.max(most, car.drive.spin)));
          return most;
        };
        assert.equal(peak("sedan", SURFACE.asphalt, SURFACE.grass), 0, "a front-driven car with its fronts on asphalt");
        assert.ok(peak("police", SURFACE.asphalt, SURFACE.grass) > 0.3, "a rear-driven car with its rears on grass");
        assert.ok(peak("sedan", SURFACE.grass, SURFACE.asphalt) > 0.3, "a front-driven car with its fronts on grass");
        assert.equal(peak("police", SURFACE.grass, SURFACE.asphalt), 0, "a rear-driven car with its rears on asphalt");
      });
    });

    describe("given a car on asphalt at full throttle with its front wheels lifted off the ground (a crest, a sedan's hood left behind)", () => {
      /** One slice of the drive with `wheelsDown` forced to `down`: the body's gain in speed per second. */
      function pull(cls: VehicleClassId, down: number): number {
        const car = makeCar(cls);
        car.spawnFacing(0, 0, 0, 5);
        car.integrate(H);
        car.wheelsDown = down;
        const before = along(car);
        applyDrive(car, FULL, H);
        return (along(car) - before) / H;
      }

      it("when it is front-driven, then it has no traction and does not pull; when it is rear-driven, then it pulls as on all four; when it is a locked 4wd, then its rears carry it on", () => {
        assert.equal(pull("sedan", 0b1100), 0, "a front-driven car with its fronts up");
        assert.ok(Math.abs(pull("police", 0b1100) / pull("police", 0b1111) - 1) < 1e-9, "a rear-driven car with its fronts up");
        assert.ok(Math.abs(pull("truck", 0b1100) / pull("truck", 0b1111) - 1) < 1e-9, "a locked 4wd with its fronts up");
        assert.equal(pull("police", 0b0011), 0, "a rear-driven car with its rears up");
      });
    });

    describe("given a 4wd truck at full throttle and boost, rolled onto its side with its wheels resting on a wall (all four in contact)", () => {
      it("when the drive runs, then its tyres give it no drive: its speed is unchanged, the pedals idle, and the same car upright pulls", () => {
        /** One slice of the drive rolled by `roll` rad about its nose, all four wheels in contact: the body's gain in speed. */
        const gain = (roll: number): { dv: number; throttle: number } => {
          const car = makeCar("truck");
          car.spawnFacing(0, 0, 0, 1);
          car.integrate(H);
          car.group.rotateZ(roll);
          car.wheelsDown = 0b1111;
          const before = car.velocity.clone();
          applyDrive(car, { ...FULL, boost: true }, H);
          return { dv: car.velocity.distanceTo(before), throttle: car.drive.throttle };
        };
        // A flat-out car lying on its side against the arena wall, its wheels on the wall, pushed itself through the 1 m wall at 0.5 m/s.
        const side = gain(Math.PI / 2);
        assert.deepEqual(side, { dv: 0, throttle: 0 }, "on its side");
        assert.ok(gain(0).dv > 0, "upright, it pulls");
      });
    });

    describe("given a sedan launched on asphalt with the boost lit", () => {
      it("when it launches, then its wheels never spin and the body gains the boosted launch pull per second (the city AI lost a lap to a boost that spun against an unboosted cap)", () => {
        const k = CLASSES.sedan;
        const boosted = { ...FULL, boost: true };
        let most = 0;
        let first = Number.NaN;
        drive("sedan", flat(SURFACE.asphalt), 0.3, H, boosted, (car) => {
          most = Math.max(most, car.drive.spin);
          if (Number.isNaN(first)) first = along(car) / H;
        });
        const launch = (k.launch[0] + (k.launch[1] - k.launch[0]) * HANDLING.realism) * k.boostAccel;
        assert.equal(most, 0, `the boost launch spun at ${most.toFixed(2)}`);
        assert.ok(Math.abs(first / launch - 1) < 0.01, `the first slice pulled ${first.toFixed(2)} against the boosted launch ${launch.toFixed(2)} m/s²`);
      });
    });

    describe("given the sedan launched flat out on grass at the arcade end", () => {
      it("when its wheels spin, then the body gains exactly the road's traction less the grass's rolling resistance per second, never the engine's pull", () => {
        HANDLING.realism = 0;
        const cap = CLASSES.sedan.launch[0] * SURFACES.grass.grip - rollingOver(SURFACES.grass.roll);
        const pulls: number[] = [];
        let last = 0;
        drive("sedan", flat(SURFACE.grass), BUILD_S, H, FULL, (car) => {
          const v = along(car);
          if (car.drive.spin > 0) pulls.push((v - last) / H);
          last = v;
        });
        assert.ok(pulls.length > 10, `${pulls.length} slices with the wheels spinning`);
        for (const pull of pulls) assert.ok(Math.abs(pull / cap - 1) <= 0.01, `${pull.toFixed(2)} m/s² against the traction ${cap.toFixed(2)}`);
      });
    });

    describe("given the sedan launched flat out on grass, then lifted off at 10 m/s", () => {
      it("when it launches, then the spin passes 0.6 within a second and is 0 on asphalt; when it lifts, then the spin fades over the driveline's rotating mass, never in one slice, and is gone within a second", () => {
        let most = 0;
        const car = drive("sedan", flat(SURFACE.grass), BUILD_S, H, FULL, (c) => (most = Math.max(most, c.drive.spin)));
        assert.ok(most > SPIN_PASSED, `the spin peaked at ${most.toFixed(2)}`);
        // Up to 10 m/s, still on the gas, on the grass.
        while (along(car) < 10) {
          applyDrive(car, FULL, H);
          car.integrate(H);
        }
        assert.ok(car.drive.spinSpeed > 1, `lifting with ${car.drive.spinSpeed.toFixed(2)} m/s of spin`);
        const k = CLASSES.sedan;
        let gone = Infinity;
        let steps = 0;
        let was = car.drive.spinSpeed;
        let bodyWas = along(car);
        drive("sedan", flat(SURFACE.grass), FADE_S, H, idleDrive(), (c, t) => {
          // The most the tyres take off the spin in a slice: the road's traction on the wheel's rotating mass (`rotatingShare` at the wheel speed the slice began at), plus what the body itself lost.
          const most = tractionLimit(k, SURFACES.grass.grip, SURFACES.grass.grip, HANDLING.realism) * (1 + 1 / rotatingShare(k, bodyWas + was)) * H + Math.max(0, bodyWas - along(c));
          if (was - c.drive.spinSpeed > most * 1.01 + 1e-9) steps++;
          if (c.drive.spinSpeed === 0 && gone === Infinity) gone = t;
          was = c.drive.spinSpeed;
          bodyWas = along(c);
        }, car);
        assert.equal(steps, 0, "the spin fell faster than the tyres can slow the wheel");
        assert.ok(gone <= FADE_S, `the spin was gone ${gone.toFixed(2)} s after the lift`);
        let onAsphalt = 0;
        HANDLING.realism = 0;
        drive("sedan", flat(SURFACE.asphalt), BUILD_S, H, FULL, (c) => (onAsphalt = Math.max(onAsphalt, c.drive.spin)));
        assert.equal(onAsphalt, 0, "no spin on asphalt at the arcade end");
      });
    });

    describe("given the sedan launched flat out on grass", () => {
      it("when its spinning wheels pass the top of first gear, then the gauge reads second while the body is still under half of first's top", () => {
        let early = false;
        drive("sedan", flat(SURFACE.grass), BUILD_S, H, FULL, (car) => {
          if (carGear(car) === 2 && along(car) < 0.5 * gearHi(CLASSES.sedan, 0)) early = true;
        });
        assert.ok(early, "the gauge never read second under half of first's top");
      });
    });

    describe("given every class launched flat out on asphalt, grass and sand, at each end of the slider and its default", () => {
      it("when the gauge is read every slice, then its revs fall by more than 0.3 only at an upshift, and the gear never hunts (at most one downshift over the run)", () => {
        for (const cls of VEHICLE_CLASS_IDS) {
          for (const realism of [0, DEFAULT_REALISM, 1]) {
            for (const surface of [SURFACE.asphalt, SURFACE.grass, SURFACE.sand] as const) {
              HANDLING.realism = realism;
              let gear = 1;
              let rpm = 0;
              let down = 0;
              const falls: string[] = [];
              drive(cls, flat(surface), 8, H, FULL, (car, t) => {
                const g = carGear(car);
                const r = carRpm(car);
                if (g < gear) down++;
                if (r < rpm - SHIFT_DROP && g <= gear) falls.push(`${t.toFixed(2)} s: ${rpm.toFixed(2)} → ${r.toFixed(2)} in gear ${g}`);
                gear = g;
                rpm = r;
              });
              const cell = `${cls} at realism ${realism} on ${surface}`;
              assert.deepEqual(falls, [], `${cell}: the revs fell without an upshift at ${falls.join(", ")}`);
              assert.ok(down <= 1, `${cell}: ${down} downshifts`);
            }
          }
        }
      });
    });

    describe("given a car mid-spin on grass with full steering lock", () => {
      /** The yaw rate and sideways hold of one more slice, with the spin as it is and with it forced to zero first. */
      function withAndWithoutSpin(cls: VehicleClassId): { yaw: [number, number]; hold: [number, number] } {
        const pair = [0, 1].map(() => drive(cls, flat(SURFACE.grass), 0.4, H, FULL, () => {}));
        const steer: DriveInput = { ...FULL, steer: 1 };
        pair[1]!.drive.spinSpeed = 0;
        for (const car of pair) applyDrive(car, steer, H);
        assert.ok(pair[0]!.drive.spin > 0.3, `${cls} spinning at ${pair[0]!.drive.spin.toFixed(2)}`);
        return { yaw: [pair[0]!.angular.y, pair[1]!.angular.y], hold: [pair[0]!.drive.hold, pair[1]!.drive.hold] };
      }

      it("when it is front-driven (the sedan), then the spin costs it steering authority and sideways hold; when it is rear-driven (the muscle car), then it steers as if gripping and only the hold falls", () => {
        const fwd = withAndWithoutSpin("sedan");
        assert.ok(fwd.yaw[0] < 0.9 * fwd.yaw[1], `a spinning front axle steers at ${fwd.yaw[0].toFixed(3)} against ${fwd.yaw[1].toFixed(3)} rad/s`);
        assert.ok(fwd.hold[0] < fwd.hold[1], `hold ${fwd.hold[0].toFixed(3)} spinning, ${fwd.hold[1].toFixed(3)} gripping`);
        const rwd = withAndWithoutSpin("muscle");
        assert.ok(Math.abs(rwd.yaw[0] / rwd.yaw[1] - 1) < 0.02, `a spinning rear axle steers at ${rwd.yaw[0].toFixed(3)} against ${rwd.yaw[1].toFixed(3)} rad/s`);
        assert.ok(rwd.hold[0] < rwd.hold[1], `hold ${rwd.hold[0].toFixed(3)} spinning, ${rwd.hold[1].toFixed(3)} gripping`);
      });
    });

    describe("given a car driven flat out on one surface for long enough to settle", () => {
      /** The terminal the law gives and where the gauge reads it: speed (m/s), gear and revs after `seconds`. */
      function settled(cls: VehicleClassId, surface: SurfaceId, seconds: number): { v: number; gear: number; rpm: number } {
        const car = drive(cls, flat(surface), seconds, H, FULL, () => {});
        return { v: along(car), gear: carGear(car), rpm: carRpm(car) };
      }

      it("when the sedan runs on grass, then it settles where its power meets the grass's rolling resistance over asphalt's, in 5th off the redline; on sand lower, in 4th; and the truck on grass in 4th: each at the law's terminalSpeed", () => {
        const cases: [VehicleClassId, SurfaceId, number][] = [
          ["sedan", SURFACE.grass, 5],
          ["sedan", SURFACE.sand, 4],
          ["truck", SURFACE.grass, 4],
        ];
        for (const [cls, surface, gear] of cases) {
          const k = CLASSES[cls];
          const law = terminalSpeed(k, rollingOver(SURFACES[surface].roll));
          assert.ok(law < k.topSpeed, `${cls} on ${surface}: the law's terminal ${law.toFixed(1)} is under the class top`);
          const got = settled(cls, surface, 60);
          const share = (law - gearLo(k, gear - 1)) / (gearHi(k, gear - 1) - gearLo(k, gear - 1));
          const detail = `${cls} on ${surface}: ${got.v.toFixed(2)} m/s in gear ${got.gear} at revs ${got.rpm.toFixed(2)} (law ${law.toFixed(2)}, gear ${gear} at ${(0.3 + 0.7 * share).toFixed(2)})`;
          assert.ok(got.v <= law && law - got.v <= 0.5, detail);
          assert.equal(got.gear, gear, detail);
          assert.ok(Math.abs(got.rpm - (0.3 + 0.7 * share)) <= 0.03 && got.rpm < 0.97, detail);
        }
        const asphalt = settled("sedan", SURFACE.asphalt, 30);
        assert.ok(Math.abs(asphalt.v - CLASSES.sedan.topSpeed) < 1e-6, `asphalt reaches the class top: ${asphalt.v.toFixed(2)}`);
      });

      it("when the sedan holds half throttle on grass, then it holds exactly that share of the class top (its power beats the drag there); when it holds 90 % on sand from 50 m/s, then it sags to the sand's terminal", () => {
        const k = CLASSES.sedan;
        // The pedal the sim runs is on the clip's grid (`THROTTLE_STEPS`): 0.5 rounds to 64/127.
        const share = Math.round(0.5 * THROTTLE_STEPS) / THROTTLE_STEPS;
        const half = drive("sedan", flat(SURFACE.grass), 20, H, { ...idleDrive(), throttle: 0.5 }, () => {});
        assert.ok(Math.abs(along(half) - share * k.topSpeed) < 1e-6, `half throttle on grass holds ${along(half).toFixed(3)} of ${(share * k.topSpeed).toFixed(3)}`);
        const seeded = makeCar("sedan");
        seeded.spawnFacing(0, 0, 0, 50);
        let last = 50;
        let falling = true;
        const sag = drive("sedan", flat(SURFACE.sand), 30, H, { ...idleDrive(), throttle: 0.9 }, (c) => {
          if (along(c) > last) falling = false;
          last = along(c);
        }, seeded);
        const law = terminalSpeed(k, rollingOver(SURFACES.sand.roll));
        // The sag is the law's approach from above (`power / v − resist` per second, a few hundredths near the terminal): still falling and within 1 m/s at 30 s.
        assert.ok(falling && along(sag) > law && along(sag) - law <= 1, `90 % throttle on sand sags to ${along(sag).toFixed(2)} (law ${law.toFixed(2)}, ${falling ? "still falling" : "rose"})`);
      });

      it("when the sedan freewheels in neutral, then on grass it sheds the whole of the grass's rolling resistance plus the air's drag, more than on asphalt", () => {
        const decel = (surface: SurfaceId) => {
          const car = makeCar("sedan");
          car.spawnFacing(0, 0, 0, 20);
          drive("sedan", flat(surface), 1, H, { ...idleDrive(), neutral: true }, () => {}, car);
          return 20 - along(car);
        };
        const grass = decel(SURFACE.grass);
        const asphalt = decel(SURFACE.asphalt);
        const law = SURFACES.grass.roll * FRICTION_G + DRIVE.drag * 20 * 20;
        assert.ok(Math.abs(grass / law - 1) <= 0.3, `neutral on grass sheds ${grass.toFixed(2)} m/s² (law about ${law.toFixed(2)})`);
        assert.ok(grass > 3 * asphalt, `grass ${grass.toFixed(2)} against asphalt ${asphalt.toFixed(2)} m/s²`);
      });

      it("when the sedan's right wheels stand on grass and its left on asphalt, then it feels half the grass's extra rolling resistance", () => {
        const g = new Ground();
        const wide = { nu: 2, nv: 2, stepV: 2e7, v0: -1e7, heights: new Float32Array(4), ox: 0, oy: 0, oz: 0, reach: Infinity };
        g.addGrid({ ...wide, step: 1e7, u0: 0, surface: SURFACE_IDS.indexOf(SURFACE.grass) });
        g.addGrid({ ...wide, step: 1e7, u0: -1e7, surface: SURFACE_IDS.indexOf(SURFACE.asphalt) });
        const decel = (ground: Ground) => {
          const car = makeCar("sedan");
          car.spawnFacing(0, 0, 0, 20);
          drive("sedan", ground, 1, H, { ...idleDrive(), neutral: true }, () => {}, car);
          return 20 - along(car);
        };
        const mixed = decel(g);
        const asphalt = decel(flat(SURFACE.asphalt));
        const grass = decel(flat(SURFACE.grass));
        const half = asphalt + 0.5 * (grass - asphalt);
        assert.ok(Math.abs(mixed / half - 1) <= 0.05, `mixed ${mixed.toFixed(3)} against half the grass's extra ${half.toFixed(3)} m/s²`);
      });
    });
  });
}

describe("given a muscle car mid-spin on grass and a twin rebuilt from its flight block", () => {
  it("when both are driven on with the same pedals for a second, then their spin and speed agree to the bit every slice", () => {
    const H = 1 / FINE_HZ;
    const car = drive("muscle", flat(SURFACE.grass), 0.5, H, FULL, () => {});
    assert.ok(car.drive.spinSpeed > 1, `mid-spin at ${car.drive.spinSpeed.toFixed(2)} m/s`);
    const block = new Float64Array(FLIGHT);
    car.flight(block, 0, false);
    const twin = makeCar("muscle");
    twin.spawnFacing(0, 0, 0, 0);
    twin.flight(block, 0, true);
    for (let t = 0; t < 1; t += H) {
      for (const c of [car, twin]) {
        applyDrive(c, FULL, H);
        c.integrate(H);
      }
      assert.equal(twin.drive.spinSpeed, car.drive.spinSpeed, `spin at ${t.toFixed(3)} s`);
      assert.equal(along(twin), along(car), `speed at ${t.toFixed(3)} s`);
    }
  });
});
