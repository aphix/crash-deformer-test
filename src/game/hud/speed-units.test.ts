import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatSpeed, speedUnitFor } from "./speed-units.ts";

const localeUnitCases = [
  { it: "when the locale is en-US, then the readout is in mph", tag: "en-US", unit: "mph" },
  { it: "when the locale is en-GB, then the readout is in km/h", tag: "en-GB", unit: "km/h" },
  { it: "when the locale is de-DE, then the readout is in km/h", tag: "de-DE", unit: "km/h" },
  { it: "when the locale is fr-CA, then the readout is in km/h", tag: "fr-CA", unit: "km/h" },
] as const;

describe("given the speed readout's unit, chosen from the browser's language tags", () => {
  for (const testCase of localeUnitCases) {
    it(testCase.it, () => {
      assert.equal(speedUnitFor([testCase.tag]), testCase.unit);
    });
  }

  it("when several tags are given, then the first tag that names a region decides, and a bare language says nothing", () => {
    assert.equal(speedUnitFor(["en", "en-US"]), "mph");
    assert.equal(speedUnitFor(["fr-CA", "en-US"]), "km/h");
    assert.equal(speedUnitFor(["en"]), "km/h");
  });

  it("when a 200 km/h top speed (55.56 m/s) is formatted, then it reads 200 in km/h and 124 in mph", () => {
    assert.equal(formatSpeed(200 / 3.6, "km/h"), "200");
    assert.equal(formatSpeed(200 / 3.6, "mph"), "124");
  });
});
