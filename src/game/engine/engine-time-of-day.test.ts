import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import { AI_EVERY_SLICE } from "../ai/constants.ts";
import { HudStore } from "../hud/hud-store.ts";
import { TIME_OF_DAY, type TimeOfDay } from "../match/types.ts";
import { TRACK_ID } from "../world/constants.ts";
import { setGround } from "../world/ground.ts";
import { CrashEngine } from "./engine.ts";
import { element, stubBrowser } from "./engine-headless.test-util.ts";

const FRAME = 1 / 60;
const FRAMES = 120;
const COLOR_WRITES = ["copy", "set", "setHex", "setRGB", "setStyle", "lerp"] as const;

/** What a race's frames must leave alone: the time of day is chosen once, never worked on again while the race runs. */
const cases = [
  { it: "the National Mall at sunset", trackId: TRACK_ID.nationalMall, timeOfDay: TIME_OF_DAY.sunset },
  { it: "the National Mall at night", trackId: TRACK_ID.nationalMall, timeOfDay: TIME_OF_DAY.night },
  { it: "the city at sunset", trackId: TRACK_ID.city, timeOfDay: TIME_OF_DAY.sunset },
  { it: "the city by day", trackId: TRACK_ID.city, timeOfDay: TIME_OF_DAY.day },
];

describe("given the real engine in a race, lit for a time of day", () => {
  // One engine for the file: a second `CrashEngine` in the same process never resolves `ready`.
  let engine: CrashEngine;
  let drawn = 0;
  const stage = (): CrashEngine["stage"] => engine["stage"];
  const scene = (): THREE.Scene => engine["scene"];
  const hazeOf = (): THREE.Color => {
    // The dome's own shader uniform: a one-field read of a material the dome builds itself.
    const material = stage().sky.mesh.material as THREE.ShaderMaterial;
    return material.uniforms.haze!.value as THREE.Color;
  };
  const run = (frames: number): void => {
    for (let i = 0; i < frames; i++) engine.advance(FRAME, { frameDt: FRAME, render: true });
  };
  const race = (trackId: string, timeOfDay: TimeOfDay): void => {
    engine.raceCommand({ type: "program", options: { trackId, laps: 1, aiCount: 3, police: false, aggression: 0.5, aiDifficulty: AI_EVERY_SLICE, spectate: false, noReset: false, timeOfDay } });
    engine.raceCommand({ type: "start" });
    run(5 * 60);
  };
  /** The writes to each watched colour while `work` runs. */
  const colorWrites = (watched: ReadonlyMap<THREE.Color, string>, work: () => void): Record<string, number> => {
    const counts: Record<string, number> = {};
    const proto = THREE.Color.prototype;
    const originals = COLOR_WRITES.map((name) => proto[name]);
    for (const [i, name] of COLOR_WRITES.entries()) {
      const original = originals[i]! as (this: THREE.Color, ...args: unknown[]) => THREE.Color;
      (proto as unknown as Record<string, unknown>)[name] = function (this: THREE.Color, ...args: unknown[]) {
        const label = watched.get(this);
        if (label !== undefined) counts[`${label}.${name}`] = (counts[`${label}.${name}`] ?? 0) + 1;
        return original.apply(this, args);
      };
    }
    try {
      work();
    } finally {
      for (const [i, name] of COLOR_WRITES.entries()) (proto as unknown as Record<string, unknown>)[name] = originals[i];
    }
    return counts;
  };
  const watchedColors = (): Map<THREE.Color, string> =>
    new Map([
      [scene().background as THREE.Color, "background"],
      [scene().fog!.color, "fog"],
      [stage().sun.color, "sun"],
      [stage()["hemi"].color, "hemisphere"],
      [stage()["fill"].color, "fill"],
      [hazeOf(), "dome haze"],
    ]);

  before(async () => {
    stubBrowser();
    engine = new CrashEngine(element(), new HudStore(), element());
    // Nothing draws, but each visible object gets three's per-draw callback, as the renderer gives it.
    Object.assign(engine["renderer"], {
      render(drawScene: THREE.Scene, camera: THREE.Camera) {
        drawn++;
        drawScene.traverseVisible((o) => o.onBeforeRender(engine["renderer"], drawScene, camera, new THREE.BufferGeometry(), new THREE.Material(), new THREE.Group()));
      },
      compile() {},
      compileAsync: () => Promise.resolve(),
    });
    await engine.ready;
    engine.fadeScenes = false;
    // The minimal tier draws no sky by default: the dome's own per-draw callback only runs while it is shown.
    engine.setSky("on");
    engine.toggleRace();
  });
  after(() => {
    engine.dispose();
    setGround(null);
  });

  for (const testCase of cases) {
    it(`when ${testCase.it} runs ${FRAMES} frames, then nothing the time of day sets is written again (colours, intensities, shadow camera, sun axes) and the drawn frames really ran`, (t) => {
      race(testCase.trackId, testCase.timeOfDay);
      const sun = stage().sun;
      const intensityWrites: Record<string, number> = { sun: 0, hemisphere: 0, fill: 0 };
      const lights = [["sun", sun], ["hemisphere", stage()["hemi"]], ["fill", stage()["fill"]]] as const;
      for (const [label, light] of lights) {
        let value = light.intensity;
        Object.defineProperty(light, "intensity", { configurable: true, get: () => value, set: (v: number) => { intensityWrites[label] = intensityWrites[label]! + 1; value = v; } });
      }
      const projection = t.mock.method(sun.shadow.camera, "updateProjectionMatrix");
      const cross = t.mock.method(THREE.Vector3.prototype, "cross");
      const drawn0 = drawn;
      const writes = colorWrites(watchedColors(), () => run(FRAMES));
      for (const [, light] of lights) Object.defineProperty(light, "intensity", { configurable: true, writable: true, enumerable: true, value: light.intensity });
      assert.ok(drawn - drawn0 >= FRAMES, "the frames were drawn (the dome's per-draw callback ran with them)");
      assert.equal(Object.keys(writes).length, 0, `colour writes ${JSON.stringify(writes)}`);
      for (const [label] of lights) assert.equal(intensityWrites[label], 0, `${label} intensity writes`);
      assert.equal(projection.mock.callCount(), 0, "shadow camera projection rebuilds");
      assert.equal(cross.mock.callCount(), 0, "cross products (the sun's axes are made when the time of day is set)");
    });
  }

  it("when the time of day is changed in a race, then the sky, fog, lights and the dome's haze change together at once (the writes the frames above must not make)", () => {
    race(TRACK_ID.city, TIME_OF_DAY.day);
    const writes = colorWrites(watchedColors(), () => stage().setNight(true));
    for (const label of ["background", "fog", "sun", "hemisphere", "fill", "dome haze"]) {
      assert.ok(Object.keys(writes).some((k) => k.startsWith(`${label}.`)), `${label} written`);
    }
    assert.ok(hazeOf().equals(scene().fog!.color), "the haze is the fog's colour, without a frame between");
    assert.ok(stage().time === TIME_OF_DAY.night, "night");
  });

  it("when the sun is set for each time of day, then its right and up axes are unit, square to each other and to its offset", () => {
    for (const time of [TIME_OF_DAY.day, TIME_OF_DAY.sunset, TIME_OF_DAY.night]) {
      stage().setTime(time);
      const { sunRight, sunUp, sunOffset } = stage();
      assert.ok(Math.abs(sunRight.length() - 1) < 1e-9 && Math.abs(sunUp.length() - 1) < 1e-9, `${time}: unit axes`);
      assert.ok(Math.abs(sunRight.dot(sunOffset)) < 1e-9 && Math.abs(sunUp.dot(sunOffset)) < 1e-9 && Math.abs(sunRight.dot(sunUp)) < 1e-9, `${time}: square axes`);
    }
  });

  it("when a race is loaded, then no double-sided see-through material takes three's two-pass draw (back then front: two material rebuilds a frame for each)", () => {
    race(TRACK_ID.city, TIME_OF_DAY.sunset);
    const twoPass: string[] = [];
    scene().traverse((o) => {
      const materials = Array.isArray((o as THREE.Mesh).material) ? ((o as THREE.Mesh).material as THREE.Material[]) : (o as THREE.Mesh).material ? [(o as THREE.Mesh).material as THREE.Material] : [];
      for (const m of materials) if (m.transparent && m.side === THREE.DoubleSide && !m.forceSinglePass) twoPass.push(`${m.type} on ${o.type} "${o.name}"`);
    });
    assert.equal(twoPass.length, 0, `materials that would be drawn twice: ${twoPass.join(", ")}`);
  });
});
