import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { celStrength, FADE, SceneFade } from "./scene-fade.ts";

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

describe("SceneFade", () => {
  it("idles at zero and never switches without a request", () => {
    const f = new SceneFade<string>();
    for (let i = 0; i < 10; i++) assert.equal(f.frame(DT, false), null);
    assert.equal(f.cel + f.black, 0);
  });

  it("ramps cel to 1 before black, switches once at black, then fades both down to 0", () => {
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

  it("takes 0.6-0.9 s end to end", () => {
    const f = new SceneFade<string>();
    f.request("race");
    const total = toSwitch(f, false).frames + settle(f, false);
    assert.ok(total * DT >= 0.6 && total * DT <= 0.9, `${total * DT}`);
  });

  it("starts the in-fade from cel 1 and black 1", () => {
    const f = new SceneFade<string>();
    f.request("race");
    toSwitch(f, false);
    assert.equal(f.cel, 1);
    assert.equal(f.black, 1);
    f.frame(FADE.hold + DT, false);
    f.frame(DT, false);
    assert.ok(f.black < 1 && f.cel < 1 && f.cel > f.black);
  });

  it("a second request before black retargets to the last scene, with one switch", () => {
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

  it("a request while fading back in runs out again from where the values stand and switches once more", () => {
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

  it("reduced motion: black only, never a cel value, still one switch", () => {
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

  it("holds black while the warm-up runs, for at least `hold` after it ends, and gives up after waitMax", () => {
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

  it("one long frame (the 0.1 s dt cap) still lands on black before switching", () => {
    const f = new SceneFade<string>();
    f.request("race");
    for (let i = 0; i < 3; i++) assert.equal(f.frame(0.1, false), null);
    assert.equal(f.black, 1);
    assert.equal(f.frame(0.1, false), "race");
    assert.equal(f.black, 1);
  });

  it("holds the new scene's sim from the switch frame through the warm-up wait, and releases it when the fade-in starts", () => {
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

  it("a pick during the hold ends it: the sim runs again under the out ramp", () => {
    const f = new SceneFade<string>();
    f.request("race");
    toSwitch(f, false);
    assert.equal(f.holding, true);
    f.request("range");
    assert.equal(f.holding, false);
  });
});

describe("celStrength (the cel value the composite pass gets)", () => {
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

  it("Auto: zero outside a pulse, the pulse itself (up to 1) during one", () => {
    const s = run(null);
    assert.equal(s[0], 0);
    assert.equal(s[s.length - 1], 0);
    assert.equal(Math.max(...s), 1);
  });

  it("manual: held at the slider outside a pulse, and the pulse still peaks at 1 over it", () => {
    const s = run(0.5);
    assert.equal(s[0], 0.5);
    assert.equal(s[s.length - 1], 0.5);
    assert.equal(Math.max(...s), 1);
    assert.ok(Math.min(...s) >= 0.5, "never dips under the slider while the pulse ramps down");
  });

  it("manual 100% is flat 1; manual 0% plays exactly the Auto pulse", () => {
    assert.ok(run(1).every((v) => v === 1));
    assert.deepEqual(run(0), run(null));
  });

  it("reduced motion: the pulse stays 0 (calm fade), so Auto stays 0 and a manual look is its steady value", () => {
    assert.ok(run(null, true).every((v) => v === 0));
    assert.ok(run(0.3, true).every((v) => v === 0.3));
  });
});
