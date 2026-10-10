import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { newWorld, settleStep, stepWorld } from "../engine/world-step.ts";
import { physicsSlice, sliceSpeed } from "../contact/sat.ts";
import { applyDrive, type DriveInput } from "../vehicle/car-drive.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import type { VehicleClassId } from "../vehicle/vehicle-classes.ts";
import { EjectionWatch } from "../vehicle/ejection.ts";
import { launch } from "../contact/crash-scenarios.test-util.ts";
import { makeWorld as raceWorld } from "./race-world.test-util.ts";
import { armedCar } from "./solid-parity.test-util.ts";
import { activeGround, setGround } from "./ground.ts";
import { placeProps, propColliders, type PropCollider } from "./placements.ts";
import { Track } from "./track.ts";
import { parseTrack } from "./track-schema.ts";
import { OFF_MENU, TRACKS } from "./tracks/index.ts";

/**
 * The owner's three captures on Havana (`owner-captures/palm-sideswipe-teleport`, `sedan-first-tree-teleport`, `sedan-teleport-3`): a
 * car on the gas, the handbrake tapped while the wheel goes to full lock, slides its rear half sideways into a palm's trunk at about
 * 20 m/s, and one 0.254 s capture sample later it stands 139 m (monster, palm at -14.9, -121), 278 m (sedan, palm at -12.9, 350) or
 * 103 m (a second sedan, palms at 12.9, 252 and 266) away with its speed and yaw carried on. A hit never moves a car further than it
 * travels plus the depth it stands in the solid (`overlap`, the footprint against the trunk's circle, measured before the step), so no
 * physics step may carry it more than its speed (before or after the step, or the fastest car's) × step + 5 cm + that depth. The measured mechanism: a wreck drifting off a trunk at
 * 1 m/s had its depth taken as the walk back along that drift to the face it entered by, through the car's whole length (3.9 m where
 * the footprint is 0.11 m into the circle), and the wreck shove pushed it out that far, 3.4 m in one step.
 */

const FRAME = 1 / 60;
const SECONDS = 8;
/** How long (s) the handbrake is held: a tap. */
const TAP = 0.35;
/** A solid piece is one a car's body can touch below this height (m); a palm's crown and upper trunk are above any car. */
const LOW = 1;

type Scene = { cls: VehicleClassId; x: number; z: number; yaw: number; palm: { x: number; z: number }; vx?: number; vz?: number };
/** The captures' spawns on Havana's course and the first palm each one drove into (the trunk's lowest piece). */
const MONSTER: Scene = { cls: "monster", x: -39.0075, z: -157.3411, yaw: 0.5403, palm: { x: -14.9, z: -121.0 } };
const SEDAN: Scene = { cls: "sedan", x: 0, z: 426, yaw: Math.atan2(-12.9, -76), palm: { x: -12.9, z: 350.0 } };
/**
 * The second sedan's state at capture sample 53 (5.54, 272.36), 34 m/s heading (19.4, -27.5) down the avenue 1 m from the palm at
 * (12.9, 266): its inputs are not in the capture, so the car coasts in at `yaw` (its heading relative to its travel) and `share` of that speed.
 */
const sedanThree = (yaw: number, share: number): Scene => ({ cls: "sedan", x: 5.54, z: 272.36, yaw, palm: { x: 12.911, z: 266 }, vx: 19.4 * share, vz: -27.5 * share });

type Jump = { step: number; frame: number; moved: number; allowed: number; overlap: number; at: string; placements: number };

/**
 * How deep (m) `car`'s footprint (its cage's plan box) stands in solid `c`: where `c` is a circle, its depth in the rectangle where
 * its middle is outside it and the middle's way out through the nearest edge where it is inside; where it is a box, the least overlap of
 * the two rectangles along any of their four axes.
 */
function overlap(car: DeformableCar, c: PropCollider): number {
  const plan = car.cage.fields.planBox;
  const hw = (plan[1]! - plan[0]!) / 2;
  const hl = (plan[3]! - plan[2]!) / 2;
  const p = car.group.position;
  const [r, f] = [car.rightFlat, car.fwdFlat];
  const dx = c.x - p.x;
  const dz = c.z - p.z;
  const lx = dx * r.x + dz * r.z - (plan[0]! + plan[1]!) / 2;
  const lz = dx * f.x + dz * f.z - (plan[2]! + plan[3]!) / 2;
  if (c.kind === "circle") {
    const ex = Math.max(-hw, Math.min(hw, lx)) - lx;
    const ez = Math.max(-hl, Math.min(hl, lz)) - lz;
    const d = Math.hypot(ex, ez);
    if (d >= c.r) return 0;
    return d > 1e-9 ? c.r - d : c.r + Math.min(hw - Math.abs(lx), hl - Math.abs(lz));
  }
  const [ux, uz] = [Math.cos(c.yaw), -Math.sin(c.yaw)];
  const [wx, wz] = [Math.sin(c.yaw), Math.cos(c.yaw)];
  let least = Infinity;
  for (const [ax, az] of [[r.x, r.z], [f.x, f.z], [ux, uz], [wx, wz]] as const) {
    const reach = hw * Math.abs(r.x * ax + r.z * az) + hl * Math.abs(f.x * ax + f.z * az) + c.hx * Math.abs(ux * ax + uz * az) + c.hz * Math.abs(wx * ax + wz * az);
    least = Math.min(least, reach - Math.abs(dx * ax + dz * az - ((plan[0]! + plan[1]!) / 2) * (r.x * ax + r.z * az) - ((plan[2]! + plan[3]!) / 2) * (f.x * ax + f.z * az)));
  }
  return Math.max(0, least);
}

/**
 * Drives `scene`'s car on the gas for SECONDS; `turnIn` m from its palm (none when negative) the wheel goes to `steer` (±1) and the
 * handbrake is tapped for TAP s. Returns the step that moved it furthest past its allowance.
 */
function sideswipe(scene: Scene, steer: number, turnIn: number, boost = false): Jump {
  const w = raceWorld();
  w.race.showLobby("havana");
  const track = new Track([...TRACKS, ...OFF_MENU].find((j) => parseTrack(j).id === "havana"));
  const solids = propColliders(placeProps(track)).filter((c) => c.body === "solid" && c.base < LOW);
  assert.ok(solids.some((c) => c.prefab === "palm" && c.kind === "circle" && Math.hypot(c.x - scene.palm.x, c.z - scene.palm.z) < 0.5), "the palm stands where the capture says");
  const car = armedCar(scene.cls);
  launch(car, scene.x, scene.z, scene.yaw, scene.vx ?? 0, scene.vz ?? 0);
  const y = activeGround().heightAt(scene.x, scene.z);
  if (Number.isFinite(y)) {
    car.group.position.y = y;
    for (const m of car.deform.masses) m.world.y += y;
  }
  const world = newWorld([car]);
  world.ejection = new EjectionWatch();
  world.collide = (c, i, h) => w.race.courseHit(c, i, h);
  const input: DriveInput = { throttle: 1, steer: 0, brake: 0, ebrake: false, boost };
  const worst: Jump = { step: 0, frame: 0, moved: 0, allowed: Infinity, overlap: 0, at: "", placements: 0 };
  let margin = -Infinity;
  let acc = 0;
  let step = 0;
  let turned = -1;
  try {
    for (let f = 0; f < SECONDS / FRAME; f++) {
      const vmax = sliceSpeed(world.cars);
      acc = Math.min(0.05, acc + FRAME);
      for (let n = 0; acc > 1e-5 && n < 8; n++) {
        const h = Math.fround(physicsSlice(acc, vmax));
        if (turned < 0 && turnIn >= 0 && Math.hypot(car.group.position.x - scene.palm.x, car.group.position.z - scene.palm.z) < turnIn) turned = f * FRAME;
        const on = turned >= 0;
        input.steer = on ? steer : 0;
        input.ebrake = on && f * FRAME - turned < TAP;
        applyDrive(car, input, h);
        const [x0, z0, p0] = [car.group.position.x, car.group.position.z, car.placements];
        // A wreck's pose follows its masses, which can move faster than its group's velocity says: the fastest of them counts.
        let before = car.velocity.length();
        for (const m of car.deform.masses) before = Math.max(before, m.vel.length());
        let deepest = 0;
        for (const c of solids) if (Math.hypot(c.x - x0, c.z - z0) < c.r + 8) deepest = Math.max(deepest, overlap(car, c));
        stepWorld(world, h);
        settleStep(world.cars, h, false);
        acc -= h;
        step++;
        const moved = Math.hypot(car.group.position.x - x0, car.group.position.z - z0);
        const allowed = Math.max(before, car.velocity.length(), vmax) * h + 0.05 + deepest;
        if (moved - allowed > margin) {
          margin = moved - allowed;
          const at = `(${x0.toFixed(2)}, ${z0.toFixed(2)}) -> (${car.group.position.x.toFixed(2)}, ${car.group.position.z.toFixed(2)})`;
          Object.assign(worst, { step, frame: f, moved, allowed, overlap: deepest, placements: car.placements - p0, at });
        }
      }
    }
  } finally {
    setGround(null);
  }
  return worst;
}

const NO_STEP = (j: Jump): string => `step ${j.step} (frame ${j.frame}) moved the car ${j.moved.toFixed(3)} m, allowed ${j.allowed.toFixed(3)} m (footprint ${j.overlap.toFixed(3)} m in a solid), ${j.at}; placements fired ${j.placements}`;

describe("given a car on Havana's avenue, a palm in its path", () => {
  it("when a sedan on the gas taps the handbrake at full right lock 14 m out so its rear half sideswipes the palm, then no physics step carries it further than its speed times the step plus 5 cm plus its depth in a solid", () => {
    const worst = sideswipe(SEDAN, 1, 14);
    assert.ok(worst.moved <= worst.allowed, NO_STEP(worst));
  });
  it("when a monster on the gas taps the handbrake at full right lock 5 m out so its rear half sideswipes the palm, then no physics step carries it further than its speed times the step plus 5 cm plus its depth in a solid", () => {
    const worst = sideswipe(MONSTER, 1, 5);
    assert.ok(worst.moved <= worst.allowed, NO_STEP(worst));
  });
  it("when a sedan slides past the palms 1 m from a trunk at 34 m/s and 24 m/s at each heading from -3 to 3 rad to its travel, then no physics step carries it further than its speed times the step plus 5 cm plus its depth in a solid", () => {
    for (const share of [1, 0.7]) {
      for (let yaw = -3; yaw <= 3; yaw += 0.5) {
        const worst = sideswipe(sedanThree(yaw, share), 0, -1);
        assert.ok(worst.moved <= worst.allowed, `heading ${yaw}, share ${share}: ${NO_STEP(worst)}`);
      }
    }
  });
  it("when either car taps the handbrake at either lock, boost on or off, at each turn-in distance from 4 to 24 m, then no physics step carries it further than its speed times the step plus 5 cm plus its depth in a solid", () => {
    for (const scene of [SEDAN, MONSTER]) {
      for (const steer of [1, -1]) {
        for (const boost of [false, true]) {
          for (let turnIn = 4; turnIn <= 24; turnIn += 4) {
            const worst = sideswipe(scene, steer, turnIn, boost);
            assert.ok(worst.moved <= worst.allowed, `${scene.cls}, steer ${steer}, boost ${boost}, turn-in ${turnIn} m: ${NO_STEP(worst)}`);
          }
        }
      }
    }
  });
});
