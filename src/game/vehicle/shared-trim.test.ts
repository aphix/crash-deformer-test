import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as THREE from "three";
import { DeformableCar } from "./car.ts";

/** A car in `accent` trim; the body colour never matters to the trim. */
const carWithAccent = (accent: number, body: number): DeformableCar => new DeformableCar({ name: "Test", body, accent }, new THREE.Scene(), null, "sedan");

/** The material on the front and rear bumper meshes. */
const bumperMaterials = (car: DeformableCar): THREE.Material[] => [car["bumperF"], car["bumperR"]].map((bumper) => (bumper.children[0] as THREE.Mesh).material as THREE.Material);

describe("given cars wearing bumper trim", () => {
  it("when two cars share an accent colour, then all four of their bumpers draw with one material", () => {
    const a = carWithAccent(0x445566, 0x111111);
    const b = carWithAccent(0x445566, 0x222222);
    assert.equal(new Set([...bumperMaterials(a), ...bumperMaterials(b)]).size, 1);
    a.dispose();
    b.dispose();
  });

  it("when two cars have different accent colours, then their bumpers keep their own colour", () => {
    const a = carWithAccent(0x445566, 0x111111);
    const b = carWithAccent(0x665544, 0x111111);
    const [trimA] = bumperMaterials(a) as THREE.MeshStandardMaterial[];
    const [trimB] = bumperMaterials(b) as THREE.MeshStandardMaterial[];
    assert.notEqual(trimA, trimB);
    assert.equal(trimA!.color.getHex(), new THREE.Color(0x445566).getHex());
    assert.equal(trimB!.color.getHex(), new THREE.Color(0x665544).getHex());
    a.dispose();
    b.dispose();
  });

  it("when one car of an accent colour is removed, then the trim the other cars still wear is not freed", () => {
    const gone = carWithAccent(0x556677, 0x111111);
    const stays = carWithAccent(0x556677, 0x222222);
    let freed = 0;
    for (const m of bumperMaterials(stays)) m.addEventListener("dispose", () => freed++);
    gone.dispose();
    assert.equal(freed, 0);
    stays.dispose();
  });
});
