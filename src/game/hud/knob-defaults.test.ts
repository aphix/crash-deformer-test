import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { INITIAL_HUD, KNOB_RANGES, squashForStroke, strokeAt56 } from "./hud-store.ts";
import { StreamedDeformation } from "../deform/streamed-deform.ts";

// The engine seeds and resets its knobs from INITIAL_HUD and pushes them into every car's
// deformer (`dressCar`); headless cars and tests use the deformer's own field defaults.
describe("given the calibrated crash knob defaults (squash, buckle and realism)", () => {
  it("when a fresh deformer is built, then it starts at the HUD defaults, so Defaults reproduces the headless car", () => {
    const d = new StreamedDeformation(new THREE.BoxGeometry(1.7, 1.3, 4.3, 3, 2, 6));
    assert.equal(d.squash, INITIAL_HUD.squash);
    assert.equal(d.buckle, INITIAL_HUD.buckle);
  });

  it("when each default is compared with its slider range, then it sits inside the range", () => {
    for (const k of ["squash", "buckle", "realism"] as const) {
      const r = KNOB_RANGES[k];
      assert.ok(r.min < r.max, `${k} range ${r.min}–${r.max}`);
      assert.ok(INITIAL_HUD[k] >= r.min && INITIAL_HUD[k] <= r.max, `${k} ${INITIAL_HUD[k]} outside ${r.min}–${r.max}`);
    }
  });

  it("when a stroke is written to the stroke slider and read back (stroke → squash → stroke), then it reads back what was written", () => {
    for (const m of [0.4, 0.47, 0.51, 0.62, 0.75]) {
      assert.ok(Math.abs(strokeAt56(squashForStroke(m)) - m) < 1e-12, `${m} m`);
    }
  });

  it("when the default squash sets the 56 km/h stroke, then the stroke sits in the real dynamic-crush band (0.35–0.55 m)", () => {
    const m = strokeAt56(INITIAL_HUD.squash);
    assert.ok(m >= 0.35 && m <= 0.55, `default stroke ${m.toFixed(3)} m`);
  });
});
