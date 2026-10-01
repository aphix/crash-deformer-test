import { describe } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import type { CarPaint } from "./car.ts";
import type { DeformMode } from "./streamed-deform.ts";

/** Shared fixtures for the physics/deform suites; not a test file itself. */

export const DT = 1 / 60;
export const MODES: DeformMode[] = ["lattice", "shape"];

export function forModes(title: string, fn: (mode: DeformMode) => void): void {
  for (const mode of MODES) describe(`${title} [${mode}]`, () => fn(mode));
}

/** Low-poly sedan-sized box standing in for the body mesh. */
export function dummyGeom(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(1.7, 1.3, 4.3, 3, 2, 6);
}

export function paint(): CarPaint {
  return { name: "Test", body: 0xffffff, accent: 0x444444 };
}

/** Named control particle; fails the test when the rig lacks it. */
export function mass<M extends { name: string }>(d: { masses: readonly M[] }, name: string): M {
  const m = d.masses.find((n) => n.name === name);
  assert.ok(m, name);
  return m;
}
