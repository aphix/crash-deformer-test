import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { audioLevels, type AudioSetters } from "./audio-levels.ts";
import { INITIAL_HUD } from "./hud-store.ts";

/** An engine stand-in that records every sound setter call, in order. */
function recordingEngine() {
  const calls: string[] = [];
  const setters: AudioSetters = {
    toggleAudio: () => calls.push("toggleAudio"),
    setMusicVolume: (value) => calls.push(`setMusicVolume ${value}`),
    setEngineVolume: (value) => calls.push(`setEngineVolume ${value}`),
  };
  return { calls, engine: { current: setters } };
}

describe("given the sound settings the race menus and the settings panel's Audio section share", () => {
  it("when the HUD says audio is on with the music at 0.4 and the engines at 0.7, then the levels read exactly those values", () => {
    const { engine } = recordingEngine();
    const levels = audioLevels({ audioOn: true, musicVolume: 0.4, engineVolume: 0.7 }, engine);
    assert.equal(levels.on, true, "on");
    assert.equal(levels.music, 0.4, "music");
    assert.equal(levels.engines, 0.7, "engines");
  });

  it("when the HUD is untouched, then the levels are the defaults: audio off, music 0.15, engines 0.25", () => {
    const { engine } = recordingEngine();
    const levels = audioLevels(INITIAL_HUD, engine);
    assert.equal(levels.on, false, "on");
    assert.equal(levels.music, 0.15, "music");
    assert.equal(levels.engines, 0.25, "engines");
  });

  it("when the toggle, the music slider and the engines slider are used, then each calls the engine's own setter once and nothing else", () => {
    const { calls, engine } = recordingEngine();
    const levels = audioLevels(INITIAL_HUD, engine);
    levels.onToggle();
    levels.onMusic(0.3);
    levels.onEngines(0.9);
    assert.equal(calls.length, 3, "calls");
    assert.equal(calls[0], "toggleAudio", "toggle");
    assert.equal(calls[1], "setMusicVolume 0.3", "music");
    assert.equal(calls[2], "setEngineVolume 0.9", "engines");
  });

  it("when the engine is not up yet, then the controls do nothing instead of throwing", () => {
    const levels = audioLevels(INITIAL_HUD, { current: null });
    levels.onToggle();
    levels.onMusic(0.3);
    levels.onEngines(0.9);
    assert.equal(levels.on, false, "still off");
  });
});
