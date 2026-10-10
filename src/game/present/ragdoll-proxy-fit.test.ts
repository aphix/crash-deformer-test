import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import { BODIES, carInState, drawnField, gapsOver, STATES, TOP_P95_M, TOP_PARTS, TOP_WORST_M, topGapsOff } from "../vehicle/drawn-body.test-util.ts";
import { RagdollSystem } from "./engine-ragdoll.ts";

/**
 * docs/UNIFIED_CONTACT.md stage 3: the dummies' world sees each car as its drawn body (its proxies "fed from the cage"). A
 * dummy lies 3 m from the car so that the car's proxies are in the world; a ray fired down at the world point of each drawn
 * top cell meets the car's colliding proxies (the lower box and the glass slabs) at some height, held against the drawn top
 * with the same tolerance as the surface other cars stand on. The collider audit (local://collider-audit.md rows 14, 15, 20,
 * 21): the lower box top 0.85 m stood 0.34-0.59 m over the hood and deck and 0.5 m under a deck of a pickup; the cabin box
 * did not follow the crushed roof.
 */
const FRAME = 1 / 60;
const RAY_FROM_M = 3;
const RAY_LENGTH_M = 8;

/**
 * Rows whose cabin the proxy cannot hold within the bars because the cage cannot: the proxy's roof leaf follows the cage's top to
 * 0.5 cm (cabin p95 0.056 m on 42 of 340 cells, the three rows at z 0.38-0.48 over the windshield's foot), and the drawn
 * interior (its headliner stands 1.09 m over the origin and does not follow the roof mass) pokes up through the roof the drop
 * crushed (flat 1.170 m drawn against the cage's 1.112-1.118 m there): the cause `car-top-fit.test.ts` names for the cage's own
 * rolled cabin rows (p95 0.062-0.064).
 */
const interiorThroughRoof =
  "the proxy's roof leaf is within 0.5 cm of the cage's top, which is 5.6 cm under the drawn headliner (standing 1.09 m over the origin, it does not follow the roof mass and pokes up through the roof the drop crushed) on the three rows over the windshield's foot; closes when the drawn interior follows the roof's crush (Stage 5 recalibration)";

const proxyCases = BODIES.flatMap((b) =>
  STATES.map((s) => ({
    it: `when a ray from above meets the car's collision shapes in the dummies' world over its hood, cabin and deck, then it meets them within ${TOP_P95_M * 100} cm of the drawn top (95th percentile) and ${TOP_WORST_M * 100} cm at worst, and over the drawn part`,
    body: b.body,
    style: b.style,
    cls: b.cls,
    state: s.id,
    stateText: s.text,
    /** The parts of this row held to the bars as a todo (`interiorThroughRoof`), the others as plain tests. */
    todoParts: s.id === "rolled" && b.style === "pickup" ? ["cabin"] : [],
  })),
);

type ProxyCase = (typeof proxyCases)[number];

/** The bars each part of the car's top is off by, as `topGapsOff` words them: the ray fired down at every drawn top cell of the part, against the proxies in the dummies' world. */
async function proxyGaps(t: TestContext, testCase: ProxyCase): Promise<Record<string, string[]>> {
  const car = carInState(testCase.state, testCase.style, testCase.cls);
  const field = drawnField(car);
  const ragdolls = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
  await ragdolls.preload();
  ragdolls.update(FRAME, [], true, true, 0, null);
  ragdolls["spawn"]({ car: 3, p: new THREE.Vector3(3, 1.2, 0), q: new THREE.Quaternion(), v: new THREE.Vector3(), w: new THREE.Vector3(), age: 0, cop: false, rides: true });
  for (let f = 0; f < 3; f++) ragdolls.update(FRAME, [car], true, true, 0, null);
  // The world holds only the leaves and slabs a dummy is near (`cull`); the fit is held over the whole car, in the world after one step (the rays read its scene queries).
  ragdolls["cull"](0, true, FRAME);
  ragdolls["world"]!.step();
  const world = ragdolls["world"]!;
  const R = ragdolls["R"]!;
  const body = ragdolls["carBodies"][0]!;
  const down = { x: 0, y: -1, z: 0 };
  const off: Record<string, string[]> = {};
  for (const [part, region] of Object.entries(TOP_PARTS)) {
    const g = gapsOver(car, field, region, (x, y, z) => {
      const hit = world.castRay(new R.Ray({ x, y: y + RAY_FROM_M, z }, down), RAY_LENGTH_M, true, undefined, undefined, undefined, undefined, (c) => c.parent() === body && c.collisionGroups() !== 0);
      return hit === null ? NaN : y + RAY_FROM_M - hit.timeOfImpact;
    });
    t.diagnostic(`${part}: cells ${g.cells} p95 ${g.p95.toFixed(3)} up ${g.worstUp.toFixed(3)} down ${g.worstDown.toFixed(3)} missing ${g.missing}`);
    off[part] = topGapsOff(part, g);
  }
  return off;
}

for (const testCase of proxyCases) {
  describe(`given a dummy lying 3 m from a ${testCase.body} body ${testCase.stateText}`, () => {
    it(testCase.it, async (t) => {
      const off = await proxyGaps(t, testCase);
      assert.deepEqual(
        Object.entries(off).flatMap(([part, wrong]) => (testCase.todoParts.includes(part) ? [] : wrong)),
        [],
      );
    });
    for (const part of testCase.todoParts) {
      it(`${testCase.it}, over its ${part}`, { todo: interiorThroughRoof }, async (t) => {
        assert.deepEqual((await proxyGaps(t, testCase))[part], []);
      });
    }
  });
}
