import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { launch, makeCar, makeWorld, Probe, run, type CrashResult } from "./crash-scenarios.test-util.ts";

/** `runPair`'s head-on (A from -x at `kph`, B from +x), with the world's car list in either order. */
function headOn(kph: number, bFirst: boolean): [CrashResult, CrashResult] {
  const a = makeCar(undefined, 0.32);
  const b = makeCar(undefined, 0.32);
  launch(a, -5, 0, Math.PI / 2, kph / 3.6, 0);
  launch(b, 5, 0, -Math.PI / 2, -kph / 3.6, 0);
  const w = makeWorld(bFirst ? [b, a] : [a, b], false, false);
  const pa = new Probe(a, new THREE.Vector3(1, 0, 0));
  const pb = new Probe(b, new THREE.Vector3(-1, 0, 0));
  run(w, [pa, pb], 1.5);
  return [pa.finish(), pb.finish()];
}

describe("given two identical cars in a mirror-symmetric head-on", () => {
  // 180 km/h: A's noses came out 0.939 m against B's 0.835 m (engine 0.481 against 0.498 m) while the world stepped A first;
  // at 100–150 km/h the pair was symmetric to 0.01 m.
  it("when the crash runs at 100 to 200 km/h with either car first in the world's car list, then the two cars' noses (within 0.01 m), engine blocks (within 5 mm) and popped hubs agree", () => {
    for (const kph of [100, 130, 150, 165, 180, 190, 200]) {
      for (const bFirst of [false, true]) {
        const [a, b] = headOn(kph, bFirst);
        const label = `${kph} km/h, ${bFirst ? "B" : "A"} first`;
        assert.ok(Math.abs(a.noseShortL - b.noseShortL) <= 0.01, `${label}: nose A ${a.noseShortL.toFixed(3)} m against B ${b.noseShortL.toFixed(3)} m`);
        assert.ok(Math.abs(a.noseShortR - b.noseShortR) <= 0.01, `${label}: nose (R) A ${a.noseShortR.toFixed(3)} m against B ${b.noseShortR.toFixed(3)} m`);
        assert.ok(Math.abs(a.engineTravel - b.engineTravel) <= 0.005, `${label}: engine block A ${a.engineTravel.toFixed(3)} m against B ${b.engineTravel.toFixed(3)} m`);
        assert.equal(a.hubsPopped.join(), b.hubsPopped.join(), `${label}: hubs popped A [${a.hubsPopped}] against B [${b.hubsPopped}]`);
      }
    }
  });
});
