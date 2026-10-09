import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as THREE from "three";
import { DeformableCar } from "./car.ts";
import { GLASS_COLOR, getCrackMap } from "./car-materials.ts";
import { paint } from "./test-support.ts";

const scene = new THREE.Scene();
const twoCars = () => [new DeformableCar(paint(), scene, null, "sedan"), new DeformableCar(paint(), scene, null, "coupe")] as const;
const materialsOf = (car: DeformableCar): THREE.MeshStandardMaterial[] => car.lookMeshes().glass.map((pane) => pane.material as THREE.MeshStandardMaterial);

describe("given two cars with six panes each", () => {
  test("when they are built, then all twelve panes draw one material", () => {
    const [a, b] = twoCars();
    assert.equal(new Set([...materialsOf(a), ...materialsOf(b)]).size, 1);
  });

  test("when one pane cracks, then only that pane changes material, to the crack map at the cracked opacity and roughness", () => {
    const [a, b] = twoCars();
    const before = materialsOf(a)[0]!;
    assert.equal(a.hitGlass("windshield"), true);
    const panes = a.lookMeshes().glass.map((pane) => pane.material as THREE.MeshStandardMaterial);
    const cracked = panes.filter((m) => m !== before);
    assert.equal(cracked.length, 1, "one pane left the shared material");
    assert.equal(cracked[0]!.map, getCrackMap());
    assert.ok(cracked[0]!.opacity < before.opacity, "a cracked pane is hazier");
    assert.ok(cracked[0]!.roughness > before.roughness, "and rougher");
    assert.equal(before.map, null, "the intact material was not edited");
    assert.ok(materialsOf(b).every((m) => m === before), "the other car's panes are untouched");
  });

  test("when a cracked pane is reset, then it draws the cleared pane: no crack map, the reset's opacity and roughness", () => {
    const [a] = twoCars();
    a.hitGlass("rear");
    a.resetVisual();
    const m = materialsOf(a);
    assert.equal(new Set(m).size, 1, "every pane is back on one material");
    assert.equal(m[0]!.map, null);
    assert.ok(m[0]!.opacity > 0.72 && m[0]!.opacity < 0.9, `${m[0]!.opacity}`);
  });

  test("when the player's glass colour is set on one car, then its panes wear it in their own looks and the other car's keep the built colour", () => {
    const [a, b] = twoCars();
    a.hitGlass("windshield");
    a.setGlassTint(0x884400);
    const mine = materialsOf(a);
    assert.ok(mine.every((m) => m.color.getHex() === 0x884400));
    assert.equal(mine.filter((m) => m.map === getCrackMap()).length, 1, "the cracked pane is still cracked");
    assert.ok(materialsOf(b).every((m) => m.color.getHex() === GLASS_COLOR));
  });
});
