import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as THREE from "three";
import { launch, makeWorld, relaunchDamaged, tickWorld } from "../contact/crash-scenarios.test-util.ts";
import { buildCar, skinGap, stepFrames } from "./drawn-body.test-util.ts";

/**
 * docs/UNIFIED_CONTACT.md stage 3: two cars meet where their drawn bodies meet. A parked sedan and a second one that rolls at
 * it at walking pace or is dropped on its roof; the first frame at which the second car's velocity differs from a run without
 * the parked one (or the parked one moves) is where contact acts, and the drawn skins are read one frame earlier. The
 * collider audit (local://collider-audit.md rows 12-13, 16) found the rest hulls reaching 0.60 m past the drawn nose, the car
 * box 0.45 m past it after a head-on crash, the wall footprint 0.15-0.55 m, the roof plate 0.13-0.34 m off the drawn roof.
 */
const APPROACH_MPS = 1;
const DROP_FROM_M = 1.8;
/** A change of velocity (m/s) that is contact, not rolling drag or gravity. */
const FIRST_CONTACT_MPS = 0.02;
const GAP_M = 0.05;
const FRAMES = 60 * 5;

type Meeting = "nose" | "flank" | "drop";

const meetings = [
  { it: "when the second car's nose meets the first car's nose, then the drawn bodies are within 5 cm of touching", body: "an untouched sedan", damaged: false, meeting: "nose" },
  { it: "when the second car's nose meets the first car's right side, then the drawn bodies are within 5 cm of touching", body: "an untouched sedan", damaged: false, meeting: "flank" },
  { it: "when the second car lands belly-first on its roof, then the drawn bodies are within 5 cm of touching", body: "an untouched sedan", damaged: false, meeting: "drop" },
  { it: "when the second car's nose meets the first car's nose, then the drawn bodies are within 5 cm of touching", body: "a sedan that took a 50 km/h head-on crash", damaged: true, meeting: "nose" },
  { it: "when the second car's nose meets the first car's right side, then the drawn bodies are within 5 cm of touching", body: "a sedan that took a 50 km/h head-on crash", damaged: true, meeting: "flank" },
  { it: "when the second car lands belly-first on its roof, then the drawn bodies are within 5 cm of touching", body: "a sedan that took a 50 km/h head-on crash", damaged: true, meeting: "drop" },
] as const satisfies readonly { it: string; body: string; damaged: boolean; meeting: Meeting }[];

/** The parked car (at the origin, nose +z) and the second car aimed at its nose or its right side, or hanging over its roof. */
function scene(damaged: boolean, meeting: Meeting, withParked: boolean) {
  const parked = buildCar("sedan", "sedan");
  if (damaged) {
    const other = buildCar("sedan", "sedan");
    launch(parked, -5, 0, Math.PI / 2, 50 / 3.6, 0);
    launch(other, 5, 0, -Math.PI / 2, -50 / 3.6, 0);
    stepFrames(makeWorld([parked, other], false, false), 5);
    relaunchDamaged(parked, 0, 0, 0, 0, 0);
  } else launch(parked, 0, 0, 0, 0, 0);
  const second = buildCar("sedan", "sedan");
  if (meeting === "flank") launch(second, 6, 0, -Math.PI / 2, -APPROACH_MPS, 0);
  else if (meeting === "nose") launch(second, 0, 6, Math.PI, 0, -APPROACH_MPS);
  else {
    second.spawnFacing(0, 0, 0, 0);
    second.group.position.y = DROP_FROM_M;
    second.airborne = true;
  }
  return { parked, second, world: makeWorld(withParked ? [parked, second] : [second], false, false) };
}

for (const testCase of meetings) {
  describe(`given ${testCase.body} parked and a second sedan ${testCase.meeting === "drop" ? `${DROP_FROM_M} m over it` : `rolling at it at ${APPROACH_MPS} m/s`}`, () => {
    it(testCase.it, (t) => {
      const alone = scene(testCase.damaged, testCase.meeting, false);
      const free: THREE.Vector3[] = [];
      for (let f = 0; f < FRAMES; f++) {
        tickWorld(alone.world, 1 / 60);
        free.push(alone.second.velocity.clone());
      }
      const met = scene(testCase.damaged, testCase.meeting, true);
      let onset = -1;
      for (let f = 0; f < FRAMES && onset < 0; f++) {
        tickWorld(met.world, 1 / 60);
        if (met.second.velocity.distanceTo(free[f]!) > FIRST_CONTACT_MPS || met.parked.velocity.length() > FIRST_CONTACT_MPS) onset = f;
      }
      assert.ok(onset > 0, `the cars never touched in ${FRAMES / 60} s`);
      const before = scene(testCase.damaged, testCase.meeting, true);
      for (let f = 0; f < onset; f++) tickWorld(before.world, 1 / 60);
      const gap = skinGap(before.parked, before.second);
      t.diagnostic(`contact first acts in frame ${onset}, with the drawn bodies ${gap.toFixed(3)} m apart (negative: overlapping)`);
      assert.ok(Math.abs(gap) <= GAP_M, `contact first acts with the drawn bodies ${gap.toFixed(3)} m apart`);
    });
  });
}
