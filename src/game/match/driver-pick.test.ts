import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { driverCarApplies } from "./driver-pick.ts";

describe("the stored car pick against a share link", () => {
  it("good: with no link car the stored pick applies at boot", () => {
    assert.equal(driverCarApplies(null, "monster", false), true);
  });

  it("good: a link that names a car wins over the stored pick at boot", () => {
    assert.equal(driverCarApplies(null, "monster", true), false);
  });

  it("good: a pick the player changes afterwards applies even when the link named a car", () => {
    assert.equal(driverCarApplies("monster", "truck", true), true);
    assert.equal(driverCarApplies("monster", "truck", false), true);
  });

  it("good: an unchanged pick (a name edit) never re-applies, so it cannot undo a car chosen in the HUD since", () => {
    assert.equal(driverCarApplies("monster", "monster", false), false);
    assert.equal(driverCarApplies("monster", "monster", true), false);
  });
});
