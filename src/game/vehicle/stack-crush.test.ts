import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "./car.ts";
import { paint } from "./test-support.ts";
import { makeWorld, tickWorld, type CrashWorld } from "../contact/crash-scenarios.test-util.ts";
import { FACE_LEFT, FACE_NOSE, FACE_RIGHT, FACE_TAIL, FACE_TOP, faceMax, faceStrength } from "../deform/load-crush.ts";
import { MASS_SPECS } from "../kernel/rig-spec.ts";

/**
 * Load crush (docs/LOAD_CRUSH.md): a face yields under the load on it, so a stack of cars crushes each roof by the
 * weight above it, and a car dropped on its roof, nose, tail or flank crushes that face by its own weight and drop.
 * Headless, through the engine's own step (`stepWorld`), on the flat pad.
 */
const ROOF_REST_Y = MASS_SPECS.find((m) => m.name === "roof")!.rest[1];
/** Belly-to-roof gap of a car above (m): the 1.17 m between a car's origin and the roof it stands on, plus this. */
const GAP = 0.02;
const STACK_STEP = 1.17 + GAP;
const SETTLE_S = 8;

function roofSink(c: DeformableCar): number {
  return ROOF_REST_Y - c.deform.massLocal("roof").y;
}

function run(w: CrashWorld, seconds: number, hz = 60): void {
  for (let f = 0; f < seconds * hz; f++) tickWorld(w, 1 / hz);
}

/** `n` cars one above the other, bottom first: the bottom on the ground, the rest falling from `GAP` over the roof below. */
function stack(n: number, hz = 60): { cars: DeformableCar[]; w: CrashWorld } {
  const cars = Array.from({ length: n }, (_, i) => {
    const c = new DeformableCar(paint(), new THREE.Scene());
    c.spawnFacing(0, 0, 0, 0);
    c.group.position.y = i * STACK_STEP;
    c.airborne = i > 0;
    return c;
  });
  const w = makeWorld(cars, false, false);
  run(w, SETTLE_S, hz);
  return { cars, w };
}

/** One car `h` m over the ground (its lowest drawn point), turned (pitch, yaw, roll) as given, then dropped. */
const ORIENT: Record<"roof" | "nose" | "tail" | "left" | "right" | "corner", [number, number, number]> = {
  roof: [0, 0, Math.PI],
  nose: [Math.PI / 2, 0, 0],
  tail: [-Math.PI / 2, 0, 0],
  left: [0, 0, Math.PI / 2],
  right: [0, 0, -Math.PI / 2],
  corner: [Math.PI / 3, 0, Math.PI / 4],
};
function drop(kind: keyof typeof ORIENT, h: number, hz = 60): DeformableCar {
  const c = new DeformableCar(paint(), new THREE.Scene());
  c.spawnFacing(0, 0, 0, 0);
  const [rx, ry, rz] = ORIENT[kind];
  c.group.rotation.set(rx, ry, rz, "YXZ");
  c.group.updateMatrixWorld(true);
  c.group.position.y += h - new THREE.Box3().setFromObject(c.group).min.y;
  c.airborne = true;
  run(makeWorld([c], false, false), 5, hz);
  return c;
}

describe("load crush: a stack of cars", () => {
  it("bad: each roof is crushed more than the roof above it, the top car's not at all, and the stack stands still", () => {
    const { cars, w } = stack(4);
    const sink = cars.map(roofSink);
    for (let i = 1; i < 4; i++) assert.ok(sink[i - 1]! > sink[i]! + 0.02, `car ${i - 1} (${sink[i - 1]!.toFixed(3)} m) is not under a clearly worse roof than car ${i} (${sink[i]!.toFixed(3)} m)`);
    assert.ok(sink[3]! < 0.002, `the top car's roof is crushed ${sink[3]!.toFixed(3)} m with nothing on it`);
    assert.ok(sink[0]! > 0.12 && sink[0]! < 0.26, `the bottom roof took ${sink[0]!.toFixed(3)} m under three cars (FMVSS 216 band: 0.12-0.26 m with the drop's overshoot)`);
    for (const c of cars) assert.ok(Math.hypot(c.group.position.x, c.group.position.z) < 0.02, `a car slid ${Math.hypot(c.group.position.x, c.group.position.z).toFixed(3)} m off the stack`);
    const y = cars.map((c) => c.group.position.y);
    run(w, 5);
    cars.forEach((c, i) => {
      assert.ok(Math.abs(c.group.position.y - y[i]!) < 0.001, `car ${i} sank ${(y[i]! - c.group.position.y).toFixed(4)} m in 5 s more`);
      assert.ok(Math.abs(roofSink(c) - sink[i]!) < 0.001, `car ${i}'s roof moved ${(roofSink(c) - sink[i]!).toFixed(4)} m in 5 s more`);
    });
  });

  it("close-but-wrong: the bottom roof is crushed by the weight above it, not just by the car on it", () => {
    const bottom = [2, 3, 4].map((n) => roofSink(stack(n).cars[0]!));
    assert.ok(bottom[0]! > 0.02, `one car on a roof crushed it ${bottom[0]!.toFixed(3)} m`);
    assert.ok(bottom[1]! > bottom[0]! + 0.02 && bottom[2]! > bottom[1]! + 0.02, `bottom roof under 1, 2, 3 cars: ${bottom.map((b) => b.toFixed(3)).join(", ")} m`);
  });

  it("bad: the crush is the same at 60, 144 and 240 Hz", () => {
    const sinks = [60, 144, 240].map((hz) => stack(4, hz).cars.map(roofSink));
    for (let i = 0; i < 3; i++) {
      const v = sinks.map((s) => s[i]!);
      assert.ok(Math.max(...v) - Math.min(...v) < 0.04 * Math.max(...v) + 0.002, `car ${i}'s roof at 60/144/240 Hz: ${v.map((x) => x.toFixed(3)).join(" / ")} m`);
    }
  });
});

describe("load crush: a car dropped on a face", () => {
  it("bad: dropped upside-down, the roof crushes at 0.5 m, more from higher, and no further than packed", () => {
    const sink = [0.5, 1, 2].map((h) => roofSink(drop("roof", h)));
    assert.ok(sink[0]! > 0.1, `0.5 m onto the roof crushed it ${sink[0]!.toFixed(3)} m`);
    assert.ok(sink[1]! > sink[0]! + 0.03 && sink[2]! > sink[1]! + 0.03, `roof crush from 0.5 / 1 / 2 m: ${sink.map((s) => s.toFixed(3)).join(" / ")} m`);
    assert.ok(sink[2]! <= faceMax(FACE_TOP) + 0.001, `the roof crushed ${sink[2]!.toFixed(3)} m past its packed depth ${faceMax(FACE_TOP)} m`);
  });

  it("bad: dropped on the nose, tail or a flank, that face crushes and the opposite one does not", () => {
    const nose = drop("nose", 1).deform.crush;
    assert.ok(nose[FACE_NOSE]! > 0.02 && nose[FACE_TAIL] === 0, `nose drop: nose ${nose[FACE_NOSE]!.toFixed(3)} m, tail ${nose[FACE_TAIL]!.toFixed(3)} m`);
    const tail = drop("tail", 1).deform.crush;
    assert.ok(tail[FACE_TAIL]! > 0.02 && tail[FACE_NOSE] === 0, `tail drop: tail ${tail[FACE_TAIL]!.toFixed(3)} m, nose ${tail[FACE_NOSE]!.toFixed(3)} m`);
    const left = drop("left", 1).deform.crush;
    assert.ok(left[FACE_LEFT]! > 0.04 && left[FACE_RIGHT] === 0, `left drop: left ${left[FACE_LEFT]!.toFixed(3)} m, right ${left[FACE_RIGHT]!.toFixed(3)} m`);
    const right = drop("right", 1).deform.crush;
    assert.ok(right[FACE_RIGHT]! > 0.04 && right[FACE_LEFT] === 0, `right drop: right ${right[FACE_RIGHT]!.toFixed(3)} m, left ${right[FACE_LEFT]!.toFixed(3)} m`);
    const corner = drop("corner", 1).deform.crush;
    assert.ok(corner[FACE_NOSE]! + corner[FACE_LEFT]! + corner[FACE_RIGHT]! > 0.02 && corner[FACE_TAIL] === 0, `corner drop (nose, left): ${Array.from(corner, (x) => x.toFixed(3)).join(" / ")} m`);
  });

  it("bad: a face crushes more from a higher drop", () => {
    for (const kind of ["nose", "left"] as const) {
      const face = kind === "nose" ? FACE_NOSE : FACE_LEFT;
      const d = [0.5, 1, 2].map((h) => drop(kind, h).deform.crush[face]!);
      assert.ok(d[1]! > d[0]! && d[2]! > d[1]!, `${kind} crush from 0.5 / 1 / 2 m: ${d.map((x) => x.toFixed(3)).join(" / ")} m`);
    }
  });
});

describe("load crush: the roof's strength law", () => {
  it("bad: carries 3 car weights at 127 mm (FMVSS 216) and settles under 1, 2 and 3 car weights at 31, 81 and 122 mm", () => {
    assert.ok(faceStrength(FACE_TOP, 0.127) >= 3 && faceStrength(FACE_TOP, 0.127) < 3.5, `strength at 127 mm: ${faceStrength(FACE_TOP, 0.127).toFixed(2)} W`);
    for (const [w, d] of [[1, 0.031], [2, 0.081], [3, 0.122]] as const) assert.ok(Math.abs(faceStrength(FACE_TOP, d) - w) < 0.03, `${w} W settles at ${d} m, strength there ${faceStrength(FACE_TOP, d).toFixed(3)} W`);
    assert.equal(faceStrength(FACE_TOP, faceMax(FACE_TOP)), Infinity);
  });
});
