import { describe } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import * as THREE from "three";
import type { CarPaint } from "./car-core.ts";
import type { DriveInput } from "./car-drive.ts";
import { blankAiCar, type AiCar, type DerbyBrain } from "../ai/derby-ai.ts";
import type { DeformMode } from "../deform/deform-rig.ts";

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

// node:assert deep-diffs both sides on failure (Myers, O((N+M)·D)); two big float arrays once took 14.7 GB.
// These report one mismatch instead of a diff (ARCHITECTURE C9).

/** Element-wise equality within `tol`: length, then the first mismatching index and the max |diff| (NaN mismatches). */
export function assertSameNumbers(actual: ArrayLike<number>, expected: ArrayLike<number>, label: string, tol = 0): void {
  assert.equal(actual.length, expected.length, `${label}: length`);
  let first = -1;
  let max = 0;
  for (let i = 0; i < actual.length; i++) {
    const d = Math.abs(actual[i]! - expected[i]!);
    if (actual[i] === expected[i] || d <= tol) continue;
    if (first < 0) first = i;
    max = Number.isNaN(d) || d > max ? d : max;
  }
  if (first >= 0) assert.fail(`${label}: first mismatch at [${first}] ${actual[first]} vs ${expected[first]}, max |diff| ${max}`);
}

/** Same sha-256 of `JSON.stringify`; on mismatch names the first differing top-level index or key. */
export function assertSameDigest(a: unknown, b: unknown, label: string): void {
  const json = (v: unknown) => JSON.stringify(v) ?? "undefined";
  const [ha, hb] = [a, b].map((v) => createHash("sha256").update(json(v)).digest("hex"));
  if (ha === hb) return;
  const at = (o: unknown) => (o !== null && typeof o === "object" ? (o as Record<string, unknown>) : {});
  const keys = [...new Set([...Object.keys(at(a)), ...Object.keys(at(b))])];
  const first = keys.find((k) => json(at(a)[k]) !== json(at(b)[k]));
  assert.fail(`${label}: sha-256 ${ha!.slice(0, 12)} vs ${hb!.slice(0, 12)}, first difference at [${first ?? "top level"}]`);
}

/** A derby AI snapshot for the brain suites: blank car `id` rolling at 8 m/s, then `extra`. */
export function aiCar(id: number, extra: Partial<AiCar> = {}): AiCar {
  return { ...blankAiCar(id), vz: 8, ...extra };
}

/** One derby decision with the opening hold already behind us (first call ages the car 2 s), copied out of the scratch. */
export function decide(brain: DerbyBrain, self: AiCar, others: AiCar[], dt = 2): DriveInput {
  return { ...brain.think(self, others, dt) };
}
