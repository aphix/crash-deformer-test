import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { armedCar } from "../world/solid-parity.test-util.ts";
import { launch, strikeReach } from "./crash-scenarios.test-util.ts";
import { propContact, type PropHits } from "./prop-contact.ts";
import { solidsOf, type PropCollider } from "../world/placements.ts";
import { newWorld, settleStep, stepWorld } from "../engine/world-step.ts";
import { physicsSlice, sliceSpeed } from "./sat.ts";

/**
 * Stage 2 of docs/UNIFIED_CONTACT.md (statics as one solid). A fixed solid answers a car the same whichever instant the car
 * arrives on: the hit it gives must not depend on where in a physics step the first touch falls. Measured on the main line,
 * a 0.28 m post at the edge of a sedan's body at 55 m/s kills the car when the first touch falls on three of eight phases
 * of one step and lets it drive through untouched on the other five.
 */

const FRAME = 1 / 60;
/** Sim seconds a run plays out: the hit, the throw and the block's last travel. */
const SETTLE = 2.5;
const PHASES = 8;
/** One physics step's travel at `speed`: the finest step the engine takes (1/240 s). */
const STEP = 1 / 240;
/** The same band the solid-parity cells use for "the same order of damage". */
const HEALTH_BAND = 0.2;
/** A car that stops and a car that drives on differ by far more than this; the same hit differs by less. */
const SPEED_BAND = 5;

const HITS: PropHits = { knock() {}, fx() {}, wall() {} };

type Outcome = { health: number; speed: number };

/** A sedan driven along +z at `speed` into a fixed solid whose middle is `offset` m to the car's side, the run started `phase` of one step's travel further back. */
function strike(shape: { kind: "circle" | "box"; hx: number; hz: number; yawDeg: number; offset: number }, speed: number, phase: number): Outcome {
  const car = armedCar("sedan");
  const solid: PropCollider = {
    index: 0,
    prefab: null,
    body: "solid",
    x: shape.offset,
    z: 0,
    yaw: (shape.yawDeg * Math.PI) / 180,
    kind: shape.kind,
    r: shape.kind === "circle" ? shape.hx : Math.hypot(shape.hx, shape.hz),
    hx: shape.hx,
    hz: shape.hz,
    mass: 0,
    base: 0,
    top: 4.4,
    ends: 3,
  };
  const knocked = new Uint8Array(1);
  const prisms = solidsOf([], [solid]);
  const world = newWorld([car]);
  world.collide = (c, i, h) => propContact(c, i, prisms, knocked, HITS, h);
  launch(car, 0, -(3 + strikeReach(car, "front") + Math.max(shape.hx, shape.hz) + (phase / PHASES) * speed * STEP), 0, 0, speed);
  let acc = 0;
  for (let f = 0; f < SETTLE / FRAME; f++) {
    const vmax = sliceSpeed(world.cars);
    acc = Math.min(0.05, acc + FRAME);
    for (let steps = 0; acc > 1e-5 && steps < 8; steps++) {
      const h = Math.fround(physicsSlice(acc, vmax));
      stepWorld(world, h);
      settleStep(world.cars, h, false);
      acc -= h;
    }
  }
  return { health: car.deform.drivetrainHealth, speed: car.velocity.length() };
}

const SHAPES = [
  { it: "a 0.28 m wide post whose middle is 0.9 m beside the car's centre line", kind: "circle", hx: 0.14, hz: 0.14, yawDeg: 0, offset: 0.9 },
  { it: "a 0.28 m wide post whose middle is 0.75 m beside the car's centre line", kind: "circle", hx: 0.14, hz: 0.14, yawDeg: 0, offset: 0.75 },
  { it: "a 0.6 m wide post whose middle is 1.0 m beside the car's centre line", kind: "circle", hx: 0.3, hz: 0.3, yawDeg: 0, offset: 1.0 },
  { it: "a 2 m square block whose near edge is 0.8 m beside the car's centre line", kind: "box", hx: 1, hz: 1, yawDeg: 0, offset: 1.8 },
  { it: "a 2 m square block turned 30° whose near corner is about 0.5 m beside the car's centre line", kind: "box", hx: 1, hz: 1, yawDeg: 30, offset: 1.8 },
  { it: "a 2 m square block turned 45° whose near corner is about 0.3 m beside the car's centre line", kind: "box", hx: 1, hz: 1, yawDeg: 45, offset: 1.7 },
] as const;

const SPEEDS = [12, 30, 55] as const;

/**
 * todo -> Stage 4 item 5 (car-car through the kernel) (every contact through the kernel by the cage's own rows) for the 2 m block whose near edge is 0.8 m beside the
 * centre line at 55 m/s. On main the block's edge grazes the sedan's flank in all eight starts (health 1.00, speed 55.0). The drawn
 * body (the cage: outline 0.85 m, plan box 0.894 m, its flank out to z = 1.7 m) is a 0.05-0.09 m sliver in it, and the cage's contact
 * answers that as a hit: starts 1-5, 7 and 8 arm a full hit (the equivalent barrier speed 43.7 m/s, read at the first touch from the
 * face the car entered by, closing 55 m/s) from which the car loses 0.3 m/s in the contact (it is pushed 0.05-0.1 m out sideways the
 * steps after), and the lattice plays the armed hit out: health 0.26-0.40 in all but start 3, whose engine packs 0.454 m (health 0,
 * the car coasts to 1.5 m/s) where start 5 packs 0.333 m and start 7 0.274 m; start 6 is no hit at all (first touch with the plan box
 * 0.115 m in, the cage 0.245 m short of the face: the one step the entered axis is the face's; the next step the plan box is 0.344 m
 * in, past the axis window, the standing 0.094 m side overlap plus a step's travel 0.229 m, so the side is the face and the car is
 * pushed round the corner). Widening that window by 0.03 to 0.08 m turns start 6 into a hit (health 0.44) and leaves start 3 dead, so
 * no window closes it. [INFERENCE] A hit's strength has to be the impulse the contact delivers, which the cage's per-vertex rows
 * through the kernel give, not the closing at the first touch.
 */
const SLIVER = SHAPES[3];
const SLIVER_TODO = "Stage 4 item 5 (car-car through the kernel): a 0.09 m sliver of the cage arms a full 55 m/s hit it takes 0.3 m/s from; health 0.00-0.44 (start 3 dead, start 6 no hit) until the rows deliver the hit";

describe("given a fixed solid standing at the side of a sedan's path", () => {
  for (const shape of SHAPES) {
    for (const speed of SPEEDS) {
      const todo = shape === SLIVER && speed === 55 ? SLIVER_TODO : false;
      it(`when the sedan drives at ${shape.it} at ${speed} m/s, started eight times one eighth of a physics step apart, then every run ends with the same drivetrain health (within ${HEALTH_BAND}) and the same speed (within ${SPEED_BAND} m/s)`, { todo }, () => {
        const runs: Outcome[] = [];
        for (let k = 0; k < PHASES; k++) runs.push(strike(shape, speed, k));
        const health = runs.map((r) => r.health);
        const after = runs.map((r) => r.speed);
        const detail = `health ${health.map((h) => h.toFixed(2)).join(" ")}, speed ${after.map((s) => s.toFixed(1)).join(" ")}`;
        assert.ok(Math.max(...health) - Math.min(...health) <= HEALTH_BAND, `drivetrain health differs between starts: ${detail}`);
        assert.ok(Math.max(...after) - Math.min(...after) <= SPEED_BAND, `speed after the hit differs between starts: ${detail}`);
      });
    }
  }
});
