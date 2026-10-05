import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { INITIAL_HUD, type CrashHudState } from "./hud-store.ts";
import { changedSettings, isChanged, SETTING_IDS, SETTINGS, type SettingId } from "./settings-changes.ts";

/** The menu after the user moved a Cinematic FX pick (Auto off) and the crumple stroke. */
const touched: CrashHudState = { ...INITIAL_HUD, fxAuto: false, fxTier: "high", squash: 0.2 };
/** What putting setting `id` back to its default does to the HUD state: its own fields go back, nothing else moves. */
const reset = (s: CrashHudState, id: SettingId): CrashHudState => ({ ...s, ...SETTINGS[id].defaults });

describe("settings changed from their defaults", () => {
  it("good: the untouched menu has none changed", () => {
    assert.deepEqual(changedSettings(INITIAL_HUD), []);
  });

  it("good: a changed setting is marked and counted in its own section only", () => {
    assert.deepEqual(changedSettings(touched), ["fx", "stroke"]);
    assert.deepEqual(changedSettings(touched, "playback"), ["fx"]);
    assert.deepEqual(changedSettings(touched, "tuning"), ["stroke"]);
    assert.deepEqual(changedSettings(touched, "driving"), []);
    assert.deepEqual(changedSettings(touched, "debug"), []);
  });

  it("good: resetting one setting restores only that setting, the other stays changed", () => {
    const afterFx = reset(touched, "fx");
    assert.deepEqual(changedSettings(afterFx), ["stroke"]);
    assert.equal(afterFx.squash, 0.2);
    const afterStroke = reset(touched, "stroke");
    assert.deepEqual(changedSettings(afterStroke), ["fx"]);
    assert.equal(afterStroke.fxAuto, false);
    assert.equal(afterStroke.fxTier, "high");
  });

  it("good: every setting resets on its own and no two settings share a field", () => {
    const owner = new Map<string, SettingId>();
    for (const id of SETTING_IDS) {
      for (const k of Object.keys(SETTINGS[id].defaults)) {
        assert.equal(owner.get(k), undefined, `${k} is owned by ${owner.get(k)} and ${id}`);
        owner.set(k, id);
      }
    }
  });

  it("good: resetting each changed setting in turn leaves the menu as the defaults", () => {
    const all: CrashHudState = {
      ...INITIAL_HUD,
      looping: !INITIAL_HUD.looping,
      autoSlomo: !INITIAL_HUD.autoSlomo,
      autoRotate: !INITIAL_HUD.autoRotate,
      audioOn: true,
      night: true,
      wet: true,
      fxAuto: false,
      celLook: 0.4,
      userTimeScale: 0.5,
      playerClass: "truck",
      realism: 0.9,
      carCount: 9,
      speedMin: 3,
      speedMax: 40,
      squash: 0.2,
      buckle: 0.9,
      fxDensity: 0.3,
      deformMode: "lattice",
      showRig: true,
      showParticles: true,
      captureTrace: true,
    };
    let s = all;
    const order = changedSettings(s);
    assert.equal(order.length, SETTING_IDS.length, "every setting differs in this state");
    for (const id of order) {
      s = reset(s, id);
      assert.equal(isChanged(s, id), false, id);
    }
    assert.deepEqual(changedSettings(s), []);
  });

  it("good: a slider put back on its default is not changed, and a setting hidden in this scene is not counted", () => {
    assert.equal(isChanged({ ...INITIAL_HUD, squash: INITIAL_HUD.squash + 1e-6 }, "stroke"), false);
    assert.equal(isChanged({ ...INITIAL_HUD, squash: INITIAL_HUD.squash + 0.01 }, "stroke"), true);
    const range = { ...INITIAL_HUD, carCount: 1, range: { distance: null, landed: false } };
    assert.equal(isChanged(range, "cars"), false, "the range's one car is the scene's");
    assert.equal(isChanged({ ...INITIAL_HUD, carCount: 1 }, "cars"), true);
  });
});
