import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import { HudStore } from "../hud/hud-store.ts";
import { DummyMesh } from "../present/ragdoll-mesh.ts";
import { ROLE } from "../present/dummy-skin.ts";
import { setGround } from "../world/ground.ts";
import { CrashEngine } from "./engine.ts";
import { element, stubBrowser } from "./engine-headless.test-util.ts";
import { FRAME_HZ } from "../kernel/constants.ts";

/**
 * The showcase (`#scene=showcase`, by link only): every kind of person the game draws standing in rows in one draw, and a press on
 * one knocks him into the ragdoll world as a car-struck guard goes.
 */

const FRAME = 1 / FRAME_HZ;
const CHEST_Y = 1.2;

describe("given the real engine booted on #scene=showcase", () => {
  // One engine for the file: a second `CrashEngine` in the same process never resolves `ready`.
  let engine: CrashEngine;
  const run = (seconds: number): void => {
    for (let i = 0; i < seconds * FRAME_HZ; i++) engine.advance(FRAME, { frameDt: FRAME });
  };
  const art = () => engine["showcase"]!.art;
  const people = (): DummyMesh => art().people["mesh"];
  /** Whether figure `slot` is on the set. */
  const standing = (slot: number): boolean => ((people()["shown"] >> slot) & 1) === 1;
  /** Client coordinates (the stand-in canvas is 800 x 600) of figure `slot`'s chest in the camera now. */
  const chestOf = (slot: number): [number, number] => {
    const at = art().markOf(slot, new THREE.Vector3());
    at.y = CHEST_Y;
    engine["camera"].clearViewOffset();
    engine["camera"].aspect = 800 / 600;
    engine["camera"].updateProjectionMatrix();
    engine["camera"].updateMatrixWorld(true);
    at.project(engine["camera"]);
    return [((at.x + 1) / 2) * 800, ((1 - at.y) / 2) * 600];
  };

  before(async () => {
    stubBrowser();
    globalThis.location.hash = "#scene=showcase";
    engine = new CrashEngine(element(), new HudStore(), element());
    Object.assign(engine["renderer"], { render() {}, compile() {}, compileAsync: () => Promise.resolve() });
    await engine.ready;
    engine.fadeScenes = false;
    // Rapier loads in the background once the engine is ready: this is that load.
    await engine["ragdolls"].preload();
    run(0.5);
  });
  after(() => {
    engine.dispose();
    setGround(null);
  });

  it("when the page has loaded, then the showcase is the scene and every kind of person stands in one draw: a man, a woman, a cap and moustache, a guard, the president and a cop", () => {
    assert.equal(engine["sceneId"], "showcase");
    assert.equal(art().group.visible, true);
    const meshes: DummyMesh[] = [];
    art().group.traverse((o) => {
      if (o instanceof DummyMesh) meshes.push(o);
    });
    assert.equal(meshes.length, 1, "one instanced mesh draws them all");
    assert.equal(people().count, art().slots, "every slot is out");
    const figures = Array.from({ length: art().slots }, (_, slot) => art().figureOf(slot));
    assert.ok(figures.some((f) => f.look.woman) && figures.some((f) => f.look.portly) && figures.some((f) => f.cop) && figures.some((f) => f.look.mustache && f.look.hat !== null), "the kinds are all there");
    const drawn = (slot: number): number => {
      const at = new THREE.Vector3();
      let n = 0;
      for (let i = 0; i < people().geometry.getAttribute("position").count; i++) if (people().posed(slot, i, at)) n++;
      return n;
    };
    const kinds = new Set(Array.from({ length: art().slots / 2 }, (_, slot) => `${drawn(slot)}`));
    assert.ok(kinds.size >= 4, `the first row's six figures draw ${kinds.size} different bodies (man, woman, moustache, portly)`);
    for (let slot = 0; slot < art().slots; slot++) assert.ok(standing(slot), `slot ${slot} stands`);
  });

  it("when the camera opens on the set, then it is the free eye in front of the first row, and a press on a figure is the scene's, not the camera's", () => {
    assert.equal(engine["view"].flying, true);
    assert.equal(engine["view"].take, engine["showcase"]);
    const [x, y] = chestOf(0);
    const miss = engine["view"].take!.down(x + 4000, y);
    assert.equal(miss, false, "a press far from every figure leaves the camera its drag");
    assert.equal(standing(0), true, "and knocks nobody over");
  });

  it("when a figure is pressed, then he leaves the set and the ragdoll world has him in his own dress, falling; and a reset stands everybody up again", () => {
    const dolls = (): number => engine["ragdolls"]["dolls"].filter((d: { live: boolean }) => d.live).length;
    const out = dolls();
    const [x, y] = chestOf(0);
    assert.equal(engine["view"].take!.down(x, y, 0), true);
    assert.equal(standing(0), false, "off the set");
    assert.equal(dolls(), out + 1, "in the ragdoll world");
    const slot = engine["ragdolls"]["lastSlot"];
    const shirt = engine["ragdolls"]["mesh"].colourOf(slot, ROLE.SHIRT, new THREE.Color()).getHexString();
    assert.equal(shirt, new THREE.Color(art().figureOf(0).look.shirt).getHexString(), "in the shirt he stood in");
    const torso = new THREE.Vector3();
    assert.equal(engine["ragdolls"].torso(slot, torso, null), true);
    const from = torso.clone();
    run(1);
    engine["ragdolls"].torso(slot, torso, null);
    assert.ok(torso.z < from.z - 1, `knocked away from the eye: ${from.z.toFixed(2)} to ${torso.z.toFixed(2)} m`);
    engine.reset();
    assert.equal(engine["ragdolls"]["dolls"][slot].live, false, "the dummy is gone");
    for (let s = 0; s < art().slots; s++) assert.ok(standing(s), `slot ${s} is back on its mark`);
  });
});
