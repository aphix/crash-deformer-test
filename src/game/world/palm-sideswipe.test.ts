import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { newWorld, settleStep, stepWorld } from "../engine/world-step.ts";
import { physicsSlice, sliceSpeed } from "../contact/sat.ts";
import { applyDrive, type DriveInput } from "../vehicle/car-drive.ts";
import type { VehicleClassId } from "../vehicle/vehicle-classes.ts";
import { EjectionWatch } from "../vehicle/ejection.ts";
import { launch } from "../contact/crash-scenarios.test-util.ts";
import { makeWorld as raceWorld } from "./race-world.test-util.ts";
import { armedCar } from "./solid-parity.test-util.ts";
import { activeGround, setGround } from "./ground.ts";
import { placeProps, propColliders } from "./placements.ts";
import { Track } from "./track.ts";
import { parseTrack } from "./track-schema.ts";
import { OFF_MENU, TRACKS } from "./tracks/index.ts";

/**
 * The owner's two captures on Havana (palm-sideswipe-teleport, `owner-captures/`): a car on the gas, the handbrake tapped while the wheel
 * goes to full lock, slides its rear half sideways into a palm's trunk at about 20 m/s, and one 0.254 s capture sample later it stands
 * 139 m (monster, palm at -14.9, -121) or 278 m (sedan, palm at -12.9, 350) away with its speed and yaw carried on. A hit never moves a
 * car further than it travels, so no physics step may carry it more than its speed × step + 0.05 m.
 */

const FRAME = 1 / 60;
const SECONDS = 8;
/** How long (s) the handbrake is held: a tap. */
const TAP = 0.35;

type Scene = { cls: VehicleClassId; x: number; z: number; yaw: number; palm: { x: number; z: number } };
/** The captures' spawns on Havana's course and the first palm each one drove into (the trunk's lowest piece). */
const MONSTER: Scene = { cls: "monster", x: -39.0075, z: -157.3411, yaw: 0.5403, palm: { x: -14.9, z: -121.0 } };
const SEDAN: Scene = { cls: "sedan", x: 0, z: 426, yaw: Math.atan2(-12.9, -76), palm: { x: -12.9, z: 350.0 } };

type Jump = { step: number; frame: number; moved: number; allowed: number; at: string; placements: number };

/** Drives `scene`'s car at its palm on the gas; `turnIn` m from the palm the wheel goes to `steer` (±1) and the handbrake is tapped for TAP s. */
function sideswipe(scene: Scene, steer: number, turnIn: number, boost = false): { worst: Jump; best: Jump; speed: number } {
  const w = raceWorld();
  w.race.showLobby("havana");
  const track = new Track([...TRACKS, ...OFF_MENU].find((j) => parseTrack(j).id === "havana"));
  assert.ok(propColliders(placeProps(track)).some((c) => c.prefab === "palm" && Math.hypot(c.x - scene.palm.x, c.z - scene.palm.z) < 0.5), "the palm stands where the capture says");
  const car = armedCar(scene.cls);
  launch(car, scene.x, scene.z, scene.yaw, 0, 0);
  const y = activeGround().heightAt(scene.x, scene.z);
  if (Number.isFinite(y)) {
    car.group.position.y = y;
    for (const m of car.deform.masses) m.world.y += y;
  }
  const world = newWorld([car]);
  world.ejection = new EjectionWatch();
  world.collide = (c, i, h) => w.race.courseHit(c, i, h);
  const input: DriveInput = { throttle: 1, steer: 0, brake: 0, ebrake: false, boost };
  const worst: Jump = { step: 0, frame: 0, moved: 0, allowed: 0, at: "", placements: 0 };
  const best: Jump = { ...worst };
  let acc = 0;
  let step = 0;
  let turned = -1;
  let speed = 0;
  try {
    for (let f = 0; f < SECONDS / FRAME; f++) {
      const vmax = sliceSpeed(world.cars);
      acc = Math.min(0.05, acc + FRAME);
      for (let n = 0; acc > 1e-5 && n < 8; n++) {
        const h = Math.fround(physicsSlice(acc, vmax));
        if (turned < 0 && Math.hypot(car.group.position.x - scene.palm.x, car.group.position.z - scene.palm.z) < turnIn) {
          turned = f * FRAME;
          speed = car.velocity.length();
        }
        const on = turned >= 0;
        input.steer = on ? steer : 0;
        input.ebrake = on && f * FRAME - turned < TAP;
        applyDrive(car, input, h);
        const [x0, z0, p0] = [car.group.position.x, car.group.position.z, car.placements];
        stepWorld(world, h);
        settleStep(world.cars, h, false);
        acc -= h;
        step++;
        const moved = Math.hypot(car.group.position.x - x0, car.group.position.z - z0);
        const allowed = Math.max(car.velocity.length(), vmax) * h + 0.05;
        const at = `(${x0.toFixed(2)}, ${z0.toFixed(2)}) -> (${car.group.position.x.toFixed(2)}, ${car.group.position.z.toFixed(2)})`;
        if (moved - allowed > worst.moved - worst.allowed) Object.assign(worst, { step, frame: f, moved, allowed, placements: car.placements - p0, at });
        if (moved > best.moved) Object.assign(best, { step, frame: f, moved, allowed, placements: car.placements - p0, at });
      }
    }
  } finally {
    setGround(null);
  }
  return { worst, best, speed };
}

const TODO = (measured: string) => ({ todo: `${measured}; the 139 m / 278 m capture jumps do not reproduce headless, only this decimetre-to-metre kind; follow-up after Stage 2/3 landing` });

describe("given a car on Havana's avenue, a palm in its path", () => {
  it("when a sedan on the gas taps the handbrake at full right lock 14 m out so its rear half sideswipes the palm, then no physics step carries it further than its speed times the step plus 5 cm", TODO("measured: step 850 (frame 238), 3.37 m in one step at (-13.12, 352.43) -> (-15.19, 349.76), 30.4 m/s"), () => {
    const { worst } = sideswipe(SEDAN, 1, 14);
    assert.ok(worst.moved <= worst.allowed, `step ${worst.step} (frame ${worst.frame}) moved the car ${worst.moved.toFixed(3)} m, allowed ${worst.allowed.toFixed(3)} m, ${worst.at}; placements fired ${worst.placements}`);
  });
  it("when a monster on the gas taps the handbrake at full right lock 5 m out so its rear half sideswipes the palm, then no physics step carries it further than its speed times the step plus 5 cm", TODO("measured: 2.72 m in one step at (15.89, -118.91) -> (13.17, -119.13), 25.1 m/s"), () => {
    const { worst } = sideswipe(MONSTER, 1, 5);
    assert.ok(worst.moved <= worst.allowed, `step ${worst.step} (frame ${worst.frame}) moved the car ${worst.moved.toFixed(3)} m, allowed ${worst.allowed.toFixed(3)} m, ${worst.at}; placements fired ${worst.placements}`);
  });
});
