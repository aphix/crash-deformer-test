import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { healthAfter, STRIKERS } from "./striker-parity.test-util.ts";

// docs/UNIFIED_CONTACT.md 13 (owner: "a hard surface crushes a car the same way whether it moves a little or is static"): the press
// plate, the piston and the moving jersey slab meet a car through one contact (`strikeCar`), so at one closing speed each leaves the
// drivetrain where the static slab leaves it. The band is the calibration suite's own health band (0.2).
const HEALTH_BAND = 0.2;
const REFERENCE = STRIKERS[0]!;

describe("given a sedan meeting a hard flat face head-on at a closing speed that half-kills its drivetrain (50 km/h)", () => {
  const reference = healthAfter(REFERENCE, 50);

  it("when the static slab is the face, then the drivetrain is neither whole nor dead, so the band can tell a wrong striker", () => {
    assert.ok(reference > HEALTH_BAND && reference < 1 - HEALTH_BAND, `reference health ${reference.toFixed(3)}`);
  });

  for (const striker of STRIKERS.slice(1)) {
    it(`when the ${striker} is the face at 50 km/h, then the drivetrain health is within ${HEALTH_BAND} of the static slab's`, () => {
      const got = healthAfter(striker, 50);
      assert.ok(Math.abs(got - reference) <= HEALTH_BAND, `${striker}: ${got.toFixed(3)} against the static slab's ${reference.toFixed(3)}`);
    });
  }
});

describe("given the same sedan meeting the face at 40 km/h (a hurt drivetrain) and at 56 km/h (a dead one)", () => {
  for (const kph of [40, 56]) {
    for (const striker of STRIKERS.slice(1)) {
      it(`when the ${striker} is the face at ${kph} km/h, then the drivetrain health is within ${HEALTH_BAND} of the static slab's`, () => {
        const want = healthAfter(REFERENCE, kph);
        const got = healthAfter(striker, kph);
        assert.ok(Math.abs(got - want) <= HEALTH_BAND, `${striker} at ${kph} km/h: ${got.toFixed(3)} against ${want.toFixed(3)}`);
      });
    }
  }
});
