import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatSpeed, speedUnitFor } from "./speed-units.ts";

describe("speed readout units", () => {
  it("good: a US locale reads mph", () => {
    assert.equal(speedUnitFor(["en-US"]), "mph");
  });

  for (const tag of ["en-GB", "de-DE", "fr-CA"]) {
    it(`good: ${tag} reads km/h`, () => {
      assert.equal(speedUnitFor([tag]), "km/h");
    });
  }

  it("good: the first tag that names a region decides (a bare language says nothing)", () => {
    assert.equal(speedUnitFor(["en", "en-US"]), "mph");
    assert.equal(speedUnitFor(["fr-CA", "en-US"]), "km/h");
    assert.equal(speedUnitFor(["en"]), "km/h");
  });

  it("good: 200 km/h top speed (55.56 m/s) reads 200 km/h or 124 mph", () => {
    assert.equal(formatSpeed(200 / 3.6, "km/h"), "200");
    assert.equal(formatSpeed(200 / 3.6, "mph"), "124");
  });
});
