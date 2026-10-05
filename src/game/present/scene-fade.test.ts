import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { celStrength, FADE, SceneFade } from "./scene-fade.ts";
import { assertSameNumbers } from "../vehicle/test-support.ts";

const DT = 1 / 60;

/** Frames until the switch fires (or `max`); returns the target and the frame count. */
function toSwitch(f: SceneFade<string>, calm: boolean, max = 600): { target: string | null; frames: number } {
  for (let i = 1; i <= max; i++) {
    const target = f.frame(DT, calm);
    if (target !== null) return { target, frames: i };
  }
  return { target: null, frames: max };
}

function settle(f: SceneFade<string>, calm: boolean): number {
  let frames = 0;
  while ((f.black > 0 || f.cel > 0 || f.pending !== null) && frames < 600) {
    f.frame(DT, calm);
    frames++;
  }
  return frames;
}

describe("given a scene fade (the dip to black with a cel-shaded pulse the screen takes while switching between scenes)", () => {
  it("when no switch is requested, then it stays at zero and never switches", () => {
    const f = new SceneFade<string>();
    for (let i = 0; i < 10; i++) assert.equal(f.frame(DT, false), null);
    assert.equal(f.cel + f.black, 0);
  });

  it("when a switch is requested, then the cel-shaded pulse reaches 1 before black, the scene switches once at full black, and both then fade down to 0", () => {
    const f = new SceneFade<string>();
    f.request("race");
    let sawCelBeforeBlack = false;
    let switched = 0;
    let blackAtSwitch = -1;
    for (let i = 0; i < 120; i++) {
      const target = f.frame(DT, false);
      if (f.cel > 0.5 && f.black === 0) sawCelBeforeBlack = true;
      if (target !== null) {
        switched++;
        blackAtSwitch = f.black;
      }
    }
    assert.ok(sawCelBeforeBlack);
    assert.equal(switched, 1);
    assert.equal(blackAtSwitch, 1);
    assert.equal(f.cel + f.black, 0);
  });

  it("when a switch is requested and the fade plays out, then it takes 0.6-0.9 s from request to clear screen", () => {
    const f = new SceneFade<string>();
    f.request("race");
    const total = toSwitch(f, false).frames + settle(f, false);
    assert.ok(total * DT >= 0.6 && total * DT <= 0.9, `${total * DT}`);
  });

  it("when the scene has just switched, then the fade-in starts from full pulse and full black, and after the hold black falls while the pulse falls slower", () => {
    const f = new SceneFade<string>();
    f.request("race");
    toSwitch(f, false);
    assert.equal(f.cel, 1);
    assert.equal(f.black, 1);
    f.frame(FADE.hold + DT, false);
    f.frame(DT, false);
    assert.ok(f.black < 1 && f.cel < 1 && f.cel > f.black);
  });

  it("when a second switch is requested before the screen is black, then the fade retargets to the last scene requested, with one switch", () => {
    const f = new SceneFade<string>();
    f.request("race");
    for (let i = 0; i < 6; i++) f.frame(DT, false);
    f.request("range");
    const { target } = toSwitch(f, false);
    assert.equal(target, "range");
    let again = 0;
    for (let i = 0; i < 120; i++) if (f.frame(DT, false) !== null) again++;
    assert.equal(again, 0);
  });

  it("when a switch is requested while the screen is fading back in, then it fades out again from where the black and pulse stand and switches once more", () => {
    const f = new SceneFade<string>();
    f.request("race");
    toSwitch(f, false);
    for (let i = 0; i < 8; i++) f.frame(DT, false);
    const black = f.black;
    assert.ok(black < 1);
    f.request("range");
    f.frame(DT, false);
    assert.ok(f.black > black - 1e-9 && f.black !== black);
    assert.equal(toSwitch(f, false).target, "range");
  });

  it("when a switch is requested with reduced motion, then the screen goes black only, the cel-shaded pulse never rises, and the scene still switches once", () => {
    const f = new SceneFade<string>();
    f.request("race");
    let maxCel = 0;
    let switched = 0;
    for (let i = 0; i < 90; i++) {
      if (f.frame(DT, true) !== null) switched++;
      maxCel = Math.max(maxCel, f.cel);
    }
    assert.equal(maxCel, 0);
    assert.equal(switched, 1);
    assert.equal(f.black, 0);
  });

  it("when the new scene is still warming up after the switch, then the screen stays black while it runs, stays black for the minimum hold time after it ends, and gives up waiting after the maximum wait", () => {
    const f = new SceneFade<string>();
    f.request("race");
    toSwitch(f, false);
    for (let i = 0; i < 120; i++) f.frame(DT, false, true);
    assert.equal(f.black, 1);
    f.frame(DT, false, false);
    assert.equal(f.black, 1);
    for (let i = 0; i < 12; i++) f.frame(DT, false, false);
    assert.ok(f.black < 1);
    const g = new SceneFade<string>();
    g.request("race");
    toSwitch(g, false);
    for (let i = 0; i < (FADE.waitMax + FADE.hold + 0.5) / DT; i++) g.frame(DT, false, true);
    assert.ok(g.black < 1);
  });

  it("when a single long frame (the 0.1 s frame-time cap) arrives, then the screen still lands on black before the scene switches", () => {
    const f = new SceneFade<string>();
    f.request("race");
    for (let i = 0; i < 3; i++) assert.equal(f.frame(0.1, false), null);
    assert.equal(f.black, 1);
    assert.equal(f.frame(0.1, false), "race");
    assert.equal(f.black, 1);
  });

  it("when the scene switches, with or without reduced motion, then the new scene's simulation is held from the switch frame through the warm-up wait and released when the fade-in starts", () => {
    for (const calm of [false, true]) {
      const f = new SceneFade<string>();
      assert.equal(f.holding, false);
      f.request("race");
      let target: string | null = null;
      for (let i = 0; i < 600 && target === null; i++) {
        assert.equal(f.holding, false, "the old scene runs live through the out ramp and the cut");
        target = f.frame(DT, calm);
      }
      assert.equal(target, "race");
      assert.equal(f.holding, true, "held on the very frame the switch happens in");
      for (let i = 0; i < 90; i++) {
        f.frame(DT, calm, true);
        assert.equal(f.holding, true, "a warm-up in flight keeps the sim held");
      }
      let held = 0;
      while (f.holding && held < 60) {
        f.frame(DT, calm, false);
        held++;
      }
      assert.ok(held >= 1 && held <= Math.ceil(FADE.hold / DT) + 1, `${held} frames`);
      assert.equal(f.holding, false, "released as the fade-in starts");
      f.frame(DT, calm);
      assert.equal(f.holding, false);
      assert.ok(f.black < 1, "the scene is already fading up when it runs");
    }
  });

  it("when another switch is requested during the simulation hold, then the hold ends and the simulation runs again under the fade-out", () => {
    const f = new SceneFade<string>();
    f.request("race");
    toSwitch(f, false);
    assert.equal(f.holding, true);
    f.request("range");
    assert.equal(f.holding, false);
  });
});

describe("given the cel-shading strength the screen gets (the look setting combined with the fade's pulse) over one scene switch", () => {
  /** Per-frame strengths over one full scene switch plus the idle frames after it. */
  function run(look: number | null, calm = false): number[] {
    const f = new SceneFade<string>();
    const out = [celStrength(look, f.cel)];
    f.request("race");
    for (let i = 0; i < 90; i++) {
      f.frame(DT, calm);
      out.push(celStrength(look, f.cel));
    }
    return out;
  }

  it("when the look is Auto (no setting), then the strength is zero outside a pulse and the pulse itself, up to 1, during one", () => {
    const s = run(null);
    assert.equal(s[0], 0);
    assert.equal(s[s.length - 1], 0);
    assert.equal(Math.max(...s), 1);
  });

  it("when the look is set to 50% by hand, then the strength holds at 50% outside a pulse, peaks at 1 during one, and never dips under 50% while the pulse ramps down", () => {
    const s = run(0.5);
    assert.equal(s[0], 0.5);
    assert.equal(s[s.length - 1], 0.5);
    assert.equal(Math.max(...s), 1);
    assert.ok(Math.min(...s) >= 0.5, "never dips under the slider while the pulse ramps down");
  });

  it("when the look is set by hand to 100%, then the strength is a flat 1, and when it is set to 0%, then it plays exactly the Auto pulse", () => {
    assert.ok(run(1).every((v) => v === 1));
    assertSameNumbers(run(0), run(null), "manual 0% vs Auto");
  });

  it("when the fade runs with reduced motion, then the pulse stays 0, so Auto stays 0 and a hand-set 30% look stays at 30% throughout", () => {
    assert.ok(run(null, true).every((v) => v === 0));
    assert.ok(run(0.3, true).every((v) => v === 0.3));
  });
});
