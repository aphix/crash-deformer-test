import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeCar } from "../contact/crash-scenarios.test-util.ts";
import { FRAME } from "./race-world.test-util.ts";
import { StuckWatch } from "./stuck-canary.test-util.ts";

/** A little over one 10 s window: the watch's first sample lands half a second in, its 20th at 10 s, and it judges the window then. */
const RUN_S = 10.6;

/** The first step puts the car on the watch's books; its first sample comes half a second later, and a window runs from the first sample of its ten seconds. */
const STUCK_AT_ORIGIN = "field: car 0 from t=0.5 s at (0.0, 0.0) moved 0.00 m in 10 s with mean throttle 1.00, fewest cars touching";

const testCases = [
  { it: "when its driver holds full throttle and it moves nowhere for 10 s with nothing touching it, then one stuck window is reported", throttle: 1, airThrottle: 0, creepMps: 0, touching: 0, replaceAtS: Infinity, alive: true, expectedEpisode: `${STUCK_AT_ORIGIN} 0` },
  { it: "when its driver holds full throttle and it moves nowhere for 10 s with one car touching it, then one stuck window is reported", throttle: 1, airThrottle: 0, creepMps: 0, touching: 1, replaceAtS: Infinity, alive: true, expectedEpisode: `${STUCK_AT_ORIGIN} 1` },
  { it: "when a car on its roof winds its wheels with the air throttle and moves nowhere for 10 s, then one stuck window is reported", throttle: 0, airThrottle: 1, creepMps: 0, touching: 0, replaceAtS: Infinity, alive: true, expectedEpisode: `${STUCK_AT_ORIGIN} 0` },
  { it: "when it creeps 0.1 m/s (1 m in 10 s) under full throttle, then it is going and nothing is reported", throttle: 1, airThrottle: 0, creepMps: 0.1, touching: 0, replaceAtS: Infinity, alive: true, expectedEpisode: null },
  { it: "when it sits for 10 s with its driver coasting at 0.2 throttle, then nobody asked for drive and nothing is reported", throttle: 0.2, airThrottle: 0, creepMps: 0, touching: 0, replaceAtS: Infinity, alive: true, expectedEpisode: null },
  { it: "when it sits at full throttle for 10 s with two cars touching it all the while, then it is in a pile and nothing is reported", throttle: 1, airThrottle: 0, creepMps: 0, touching: 2, replaceAtS: Infinity, alive: true, expectedEpisode: null },
  { it: "when it is put on a new spot 5 s into 10 s of sitting at full throttle, then the window starts over and nothing is reported", throttle: 1, airThrottle: 0, creepMps: 0, touching: 0, replaceAtS: 5, alive: true, expectedEpisode: null },
  { it: "when it sits for 10 s with its drivetrain dead, then it is not a driven car and nothing is reported", throttle: 1, airThrottle: 0, creepMps: 0, touching: 0, replaceAtS: Infinity, alive: false, expectedEpisode: null },
] as const;

describe("given the stuck watch of the AI-field canary, fed one car's pedals and position every 1/60 s", () => {
  for (const testCase of testCases) {
    it(testCase.it, () => {
      const car = makeCar();
      const watch = new StuckWatch("field", 3);
      let replaced = false;
      for (let n = 1; n * FRAME <= RUN_S; n++) {
        const t = n * FRAME;
        if (t >= testCase.replaceAtS && !replaced) {
          car.placements++;
          replaced = true;
        }
        car.drive.throttle = testCase.throttle;
        car.airThrottle = testCase.airThrottle;
        car.group.position.x = testCase.creepMps * t;
        for (let partner = 1; partner <= testCase.touching; partner++) watch.pair(0, partner);
        watch.step([car], t, FRAME, () => testCase.alive);
      }
      assert.equal(watch.episodes.length, testCase.expectedEpisode === null ? 0 : 1, "stuck windows reported");
      if (testCase.expectedEpisode !== null) assert.equal(watch.episodes[0], testCase.expectedEpisode, "the window reported");
    });
  }
});
