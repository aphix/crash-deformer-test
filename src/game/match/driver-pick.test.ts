import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { driverCarApplies } from "./driver-pick.ts";

const bootPickCases = [
  { it: "when no car is named by the link, then the stored pick applies at boot", linkNamesCar: false, expected: true },
  { it: "when the link names a car, then the link's car wins over the stored pick at boot", linkNamesCar: true, expected: false },
] as const;

describe("given a stored car pick and a share link that may name a car", () => {
  for (const testCase of bootPickCases) {
    it(testCase.it, () => {
      assert.equal(driverCarApplies(null, "monster", testCase.linkNamesCar), testCase.expected);
    });
  }

  it("when the player switches from the monster truck to the truck after boot, then the new pick applies whether or not the link named a car", () => {
    assert.equal(driverCarApplies("monster", "truck", true), true);
    assert.equal(driverCarApplies("monster", "truck", false), true);
  });

  it("when the pick is unchanged (only the driver's name was edited), then it never re-applies, so it cannot undo a car chosen in the HUD since", () => {
    assert.equal(driverCarApplies("monster", "monster", false), false);
    assert.equal(driverCarApplies("monster", "monster", true), false);
  });
});
