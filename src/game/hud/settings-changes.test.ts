import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { INITIAL_HUD, type CrashHudState } from "./hud-store.ts";
import { changedSettings, isChanged, SETTING_IDS, SETTINGS, type SettingId } from "./settings-changes.ts";
import { DRIVER_CARS } from "../match/types.ts";
import { CHASE_KNOBS, type ChaseKnobId } from "../present/drive-cam.ts";

/** The menu after the user moved a Cinematic FX pick (Auto off) and the crumple stroke. */
const touched: CrashHudState = { ...INITIAL_HUD, fxAuto: false, fxTier: "high", squash: 0.2 };
/** What putting setting `id` back to its default does to the HUD state: its own fields go back, nothing else moves. */
const reset = (s: CrashHudState, id: SettingId): CrashHudState => ({ ...s, ...SETTINGS[id].defaults });

describe("given the settings menu, where each setting is a group of HUD fields with its own defaults and its own reset", () => {
  it("when the menu is untouched, then no setting reads as changed", () => {
    assert.deepEqual(changedSettings(INITIAL_HUD), []);
  });

  it("when a Cinematic FX pick and the crumple stroke are changed, then each changed setting is marked and counted in its own section only", () => {
    assert.deepEqual(changedSettings(touched), ["fx", "stroke"]);
    assert.deepEqual(changedSettings(touched, "playback"), ["fx"]);
    assert.deepEqual(changedSettings(touched, "tuning"), ["stroke"]);
    assert.deepEqual(changedSettings(touched, "driving"), []);
    assert.deepEqual(changedSettings(touched, "debug"), []);
  });

  it("when the FX setting is reset on its own or the stroke setting is, then only that setting is restored and the other stays changed", () => {
    const afterFx = reset(touched, "fx");
    assert.deepEqual(changedSettings(afterFx), ["stroke"]);
    assert.equal(afterFx.squash, 0.2);
    const afterStroke = reset(touched, "stroke");
    assert.deepEqual(changedSettings(afterStroke), ["fx"]);
    assert.equal(afterStroke.fxAuto, false);
    assert.equal(afterStroke.fxTier, "high");
  });

  it("when Rumble is switched off, then it reads as a changed Driving setting alone, and on by default", () => {
    assert.equal(INITIAL_HUD.rumble, true);
    const off: CrashHudState = { ...INITIAL_HUD, rumble: false };
    assert.deepEqual(changedSettings(off), ["rumble"]);
    assert.deepEqual(changedSettings(off, "driving"), ["rumble"]);
    assert.deepEqual(changedSettings(reset(off, "rumble")), []);
  });

  it("when the fields each setting resets are listed, then every setting resets on its own and no two settings share a field", () => {
    const owner = new Map<string, SettingId>();
    for (const id of SETTING_IDS) {
      for (const k of Object.keys(SETTINGS[id].defaults)) {
        assert.equal(owner.get(k), undefined, `${k} is owned by ${owner.get(k)} and ${id}`);
        owner.set(k, id);
      }
    }
  });

  it("when every setting is changed and then each is reset in turn, then each reads as unchanged right after its reset and the menu ends as the defaults", () => {
    const camera: Partial<Record<ChaseKnobId, number>> = {};
    for (const k of CHASE_KNOBS) camera[k.id] = INITIAL_HUD[k.id] === k.max ? k.min : k.max;
    const all: CrashHudState = {
      ...INITIAL_HUD,
      looping: !INITIAL_HUD.looping,
      autoSlomo: !INITIAL_HUD.autoSlomo,
      autoRotate: !INITIAL_HUD.autoRotate,
      audioOn: true,
      night: true,
      wet: true,
      sky: "off",
      fxAuto: false,
      celLook: 0.4,
      userTimeScale: 0.5,
      playerCar: "truck",
      realism: 0.9,
      rumble: false,
      carCount: 9,
      speedMin: 3,
      speedMax: 40,
      squash: 0.2,
      buckle: 0.9,
      fxDensity: 0.3,
      musicVolume: 0.2,
      engineVolume: 0.8,
      deformMode: "lattice",
      showRig: true,
      showParticles: true,
      captureTrace: true,
      ...camera,
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

  it("when a slider is a hair off its default or a scene's own value differs, then a slider within a hair of its default is not changed, a real change is, and the range's one car is the scene's and not counted", () => {
    assert.equal(isChanged({ ...INITIAL_HUD, squash: INITIAL_HUD.squash + 1e-6 }, "stroke"), false);
    assert.equal(isChanged({ ...INITIAL_HUD, squash: INITIAL_HUD.squash + 0.01 }, "stroke"), true);
    const range = { ...INITIAL_HUD, carCount: 1, range: { distance: null, landed: false } };
    assert.equal(isChanged(range, "cars"), false, "the range's one car is the scene's");
    assert.equal(isChanged({ ...INITIAL_HUD, carCount: 1 }, "cars"), true);
  });

  it("when a camera slider is moved off its default or only a hair off, then it is a changed Debug setting only when moved, and resetting it clears it", () => {
    assert.equal(isChanged({ ...INITIAL_HUD, "cam.pos.lon": INITIAL_HUD["cam.pos.lon"] + 1e-6 }, "cam.pos.lon"), false);
    const moved = { ...INITIAL_HUD, "cam.pos.lon": INITIAL_HUD["cam.pos.lon"] + 1 };
    assert.deepEqual(changedSettings(moved), ["cam.pos.lon"]);
    assert.deepEqual(changedSettings(moved, "debug"), ["cam.pos.lon"]);
    assert.deepEqual(changedSettings(moved, "playback"), []);
    assert.deepEqual(changedSettings(reset(moved, "cam.pos.lon")), []);
  });
});

describe("given the settings menu's Car pick", () => {
  for (const car of DRIVER_CARS) {
    const changed = car.id !== INITIAL_HUD.playerCar;
    it(`when the ${car.label} is picked, then the Car setting reads as ${changed ? "changed" : "unchanged"}`, () => {
      assert.equal(isChanged({ ...INITIAL_HUD, playerCar: car.id }, "car"), changed);
    });
  }
});
