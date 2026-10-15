import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import { AI_EVERY_SLICE } from "../ai/constants.ts";
import { HudStore } from "../hud/hud-store.ts";
import { TIME_OF_DAY, type TimeOfDay } from "../match/types.ts";
import type { SceneId } from "../scenes/scene-id.ts";
import { TRACK_ID } from "../world/constants.ts";
import { setGround } from "../world/ground.ts";
import { CrashEngine } from "./engine.ts";
import { element, stubBrowser } from "./engine-headless.test-util.ts";

const FRAME = 1 / 60;

/** Race, then the scene picked after it: a race's time of day and night toggle leave the sandbox scene as a fresh page has it. */
const cases = [
  { it: "a Mall race at sunset with Night toggled on in the settings goes to the fleet", trackId: TRACK_ID.nationalMall, timeOfDay: TIME_OF_DAY.sunset, nightToggled: true, next: "fleet" },
  { it: "a city race at sunset goes to the fleet", trackId: TRACK_ID.city, timeOfDay: TIME_OF_DAY.sunset, nightToggled: false, next: "fleet" },
  { it: "a Mall race by day (no change made) goes to the fleet", trackId: TRACK_ID.nationalMall, timeOfDay: TIME_OF_DAY.day, nightToggled: false, next: "fleet" },
  { it: "a city race at night goes to the corkscrew", trackId: TRACK_ID.city, timeOfDay: TIME_OF_DAY.night, nightToggled: false, next: "corkscrew" },
  { it: "a Mall race at sunset with Night toggled on goes to the derby", trackId: TRACK_ID.nationalMall, timeOfDay: TIME_OF_DAY.sunset, nightToggled: true, next: "derby" },
] as const satisfies readonly { it: string; trackId: string; timeOfDay: TimeOfDay; nightToggled: boolean; next: SceneId }[];

describe("given the real engine, its sandbox sky as a fresh page has it", () => {
  // One engine for the file: a second `CrashEngine` in the same process never resolves `ready`.
  let engine: CrashEngine;
  const stage = (): CrashEngine["stage"] => engine["stage"];
  const scene = (): THREE.Scene => engine["scene"];
  const run = (seconds: number): void => {
    for (let i = 0; i < seconds * 60; i++) engine.advance(FRAME, { frameDt: FRAME });
  };
  /** What the sandbox's sky is made of: the background and fog, the three lights, the night setting, the dome and the far plane. */
  const sandboxSky = (): Record<string, string | number | boolean> => {
    const fog = scene().fog as THREE.FogExp2;
    const { sun, sky } = stage();
    return {
      background: (scene().background as THREE.Color).getHexString(),
      fog: fog.color.getHexString(),
      fogDensity: fog.density,
      sun: `${sun.color.getHexString()} ${sun.intensity}`,
      hemisphere: `${stage()["hemi"].color.getHexString()} ${stage()["hemi"].intensity}`,
      fill: `${stage()["fill"].color.getHexString()} ${stage()["fill"].intensity}`,
      night: stage().night,
      time: String(stage().time),
      dome: sky.mesh.visible,
      far: engine["camera"].far,
    };
  };
  let fresh: Record<string, string | number | boolean>;

  before(async () => {
    stubBrowser();
    engine = new CrashEngine(element(), new HudStore(), element());
    Object.assign(engine["renderer"], { render() {}, compile() {}, compileAsync: () => Promise.resolve() });
    await engine.ready;
    engine.fadeScenes = false;
    run(1);
    fresh = sandboxSky();
  });
  after(() => {
    engine.dispose();
    setGround(null);
  });

  for (const testCase of cases) {
    it(`when ${testCase.it}, then the scene's sky, fog, lights, night setting and far plane are as on a fresh load`, () => {
      engine.toggleRace();
      engine.raceCommand({ type: "program", options: { trackId: testCase.trackId, laps: 1, aiCount: 3, police: false, aggression: 0.5, aiDifficulty: AI_EVERY_SLICE, spectate: false, noReset: false, timeOfDay: testCase.timeOfDay } });
      engine.raceCommand({ type: "start" });
      run(3);
      const racing = sandboxSky();
      assert.notEqual(racing.background, fresh.background, "the race has its own sky (the control: the colours below are not trivially equal)");
      if (testCase.nightToggled) engine.setNight(true);
      engine["setScene"](testCase.next);
      run(1);
      const after = sandboxSky();
      for (const key of Object.keys(fresh)) assert.equal(after[key], fresh[key], `${key} after the race, in the ${testCase.next}`);
      engine["setScene"]("fleet");
    });
  }
});
