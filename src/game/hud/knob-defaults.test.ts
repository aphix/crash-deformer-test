import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { INITIAL_HUD, KNOB_RANGES, squashForStroke, strokeAt56 } from "./hud-store.ts";
import { StreamedDeformation } from "../deform/streamed-deform.ts";

// The engine seeds and resets its knobs from INITIAL_HUD and pushes them into every car's
// deformer (`dressCar`); headless cars and tests use the deformer's own field defaults.
describe("calibrated crash knob defaults", () => {
  it("good: a fresh deformer starts at the HUD defaults, so Defaults reproduces the headless car", () => {
    const d = new StreamedDeformation(new THREE.BoxGeometry(1.7, 1.3, 4.3, 3, 2, 6));
    assert.equal(d.squash, INITIAL_HUD.squash);
    assert.equal(d.buckle, INITIAL_HUD.buckle);
  });

  it("good: each default sits inside its slider range", () => {
    for (const k of ["squash", "buckle", "realism"] as const) {
      const r = KNOB_RANGES[k];
      assert.ok(r.min < r.max, `${k} range ${r.min}–${r.max}`);
      assert.ok(INITIAL_HUD[k] >= r.min && INITIAL_HUD[k] <= r.max, `${k} ${INITIAL_HUD[k]} outside ${r.min}–${r.max}`);
    }
  });

  it("good: the stroke slider reads back what it writes (stroke → squash → stroke)", () => {
    for (const m of [0.4, 0.47, 0.51, 0.62, 0.75]) {
      assert.ok(Math.abs(strokeAt56(squashForStroke(m)) - m) < 1e-12, `${m} m`);
    }
  });

  it("good: the default 56 km/h stroke sits in the real dynamic-crush band (0.35–0.55 m, RIG_ANALYSIS §3.3)", () => {
    const m = strokeAt56(INITIAL_HUD.squash);
    assert.ok(m >= 0.35 && m <= 0.55, `default stroke ${m.toFixed(3)} m`);
  });
});
