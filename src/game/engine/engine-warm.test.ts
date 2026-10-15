import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import { HudStore } from "../hud/hud-store.ts";
import { setGround } from "../world/ground.ts";
import { CrashEngine } from "./engine.ts";
import { element, stubBrowser } from "./engine-headless.test-util.ts";

describe("given the engine warming its programs before the loop starts", () => {
  let engine: CrashEngine;
  const drawnDebugViews = new Set<string>();
  const isDrawn = (object: THREE.Object3D): boolean => {
    for (let node: THREE.Object3D | null = object; node; node = node.parent) if (!node.visible) return false;
    return true;
  };
  before(async () => {
    stubBrowser();
    engine = new CrashEngine(element(), new HudStore(), element());
    const render = (scene: THREE.Scene): void => {
      scene.traverse((object) => {
        if (object.parent?.name === "ragdoll-debug" && isDrawn(object)) drawnDebugViews.add(object.type);
      });
    };
    Object.assign(engine["renderer"], { render, compile() {}, compileAsync: () => Promise.resolve() });
    await engine.ready;
  });
  after(() => {
    engine.dispose();
    setGround(null);
  });

  it("when the boot warm-up draws the scene, then the thrown dummies' rig lines and particle spheres are drawn too, and both views are off again after", () => {
    assert.deepEqual([...drawnDebugViews].sort(), ["LineSegments", "Mesh"]);
    assert.equal(engine["ragdolls"].debug.on, false);
  });
});
