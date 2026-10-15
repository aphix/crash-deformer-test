import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CAR_HALF } from "../vehicle/car-mesh.ts";
import { MAX_CARS, layoutDerby } from "./fleet.ts";
import { DERBY_ARENA } from "./constants.ts";
import { DERBY_BOXES, DERBY_FREE_PROPS, DERBY_PROP, DerbyGround, type DerbyBox } from "./derby-ground.ts";
import { DERBY_RADIUS } from "./derby-arena.ts";

/**
 * The arena's ground is laid out so that a full field spawns on open level floor, and so that what is a prism stands on level ground clear
 * of every rise (a flat prism beside a heightfield ramp answers a false wall: measured, every car dies at the junction).
 */
const ground = new DerbyGround();
const props = DERBY_BOXES.filter((box) => box.kind !== DERBY_PROP.wall);
const { radius, gridHalf, spawnInset } = DERBY_ARENA;
/** A spawned car's hull corners (CAR_HALF) about its slot, and how far outside a prop's box a spawn must stay (m). */
const SPAWN_CLEARANCE = 1;
/** How far around a prop's box the floor must be level too (m): a car's tyre reaches that far over the box's face. */
const LEVEL_MARGIN = 1;
const SAMPLE_STEP = 0.5;
/** The foot of a rise is a parabola that dies out over its last metres: under this (m) the floor counts as level. */
const LEVEL = 0.01;

function localOf(box: DerbyBox, x: number, z: number): { across: number; along: number } {
  const dx = x - box.x;
  const dz = z - box.z;
  return { across: dx * Math.cos(box.yaw) - dz * Math.sin(box.yaw), along: dx * Math.sin(box.yaw) + dz * Math.cos(box.yaw) };
}

function isWithin(box: DerbyBox, x: number, z: number, margin: number): boolean {
  const local = localOf(box, x, z);
  return Math.abs(local.across) <= box.hx + margin && Math.abs(local.along) <= box.hz + margin;
}

function hullCorners(x: number, z: number, yaw: number): [number, number][] {
  const right = { x: Math.cos(yaw), z: -Math.sin(yaw) };
  const forward = { x: Math.sin(yaw), z: Math.cos(yaw) };
  return [-1, 1].flatMap((sideways) => [-1, 1].map((ahead): [number, number] => [x + right.x * sideways * CAR_HALF.x + forward.x * ahead * CAR_HALF.z, z + right.z * sideways * CAR_HALF.x + forward.z * ahead * CAR_HALF.z]));
}

describe("given the arena's ground and the full field's spawn ring", () => {
  it("when fields of every size are laid out, then every hull corner is inside the wall, on level floor at height 0 and clear of every prop", () => {
    for (let count = 1; count <= MAX_CARS; count++) {
      for (const [slotIndex, slot] of layoutDerby(count, DERBY_RADIUS, () => 0.37, DERBY_FREE_PROPS).entries()) {
        for (const [x, z] of hullCorners(slot.x, slot.z, slot.yaw)) {
          const label = `${count} cars, slot ${slotIndex} corner (${x.toFixed(1)}, ${z.toFixed(1)})`;
          assert.ok(Math.hypot(x, z) < radius, `${label} is in the wall`);
          assert.ok(ground.heightAt(x, z) < LEVEL, `${label} is not on level floor`);
          for (const prop of props) assert.ok(!isWithin(prop, x, z, SPAWN_CLEARANCE), `${label} is within ${SPAWN_CLEARANCE} m of a ${prop.kind}`);
        }
      }
    }
  });

  it("when fields of every size are laid out at every start bearing, then no car's line to the centre comes within its half length of a free-standing prop, and 32 cars stand over 4 m apart", () => {
    for (let count = 1; count <= MAX_CARS; count++) {
      for (let spin = 0; spin < 1; spin += 0.05) {
        const slots = layoutDerby(count, DERBY_RADIUS, () => spin, DERBY_FREE_PROPS);
        for (const [slotIndex, slot] of slots.entries()) {
          for (let t = 0; t <= 1; t += 0.01) {
            const x = slot.x * t;
            const z = slot.z * t;
            for (const prop of DERBY_FREE_PROPS) {
              const local = localOf(prop, x, z);
              const gap = Math.hypot(Math.max(0, Math.abs(local.across) - prop.hx), Math.max(0, Math.abs(local.along) - prop.hz));
              assert.ok(gap >= CAR_HALF.z, `${count} cars at spin ${spin.toFixed(2)}: slot ${slotIndex} heads at a ${prop.kind} (${gap.toFixed(2)} m)`);
            }
          }
        }
        if (count === MAX_CARS) {
          for (const [i, a] of slots.entries()) for (const b of slots.slice(i + 1)) assert.ok(Math.hypot(a.x - b.x, a.z - b.z) > 4, "two of 32 cars stand within 4 m");
        }
      }
    }
  });

  it("when the rises are read on the grid, then none reaches the ring where cars spawn, a grid cell's reach included", () => {
    // The ground reads its nodes bilinearly: a rise node raises the floor up to a cell (√2 m) beyond it.
    const innerEdgeOfSpawns = radius - spawnInset - CAR_HALF.z - Math.SQRT2;
    const nodes = 2 * gridHalf + 1;
    for (let j = 0; j < nodes; j++) {
      for (let i = 0; i < nodes; i++) {
        const height = ground.heights[j * nodes + i]!;
        if (height > LEVEL) assert.ok(Math.hypot(i - gridHalf, j - gridHalf) <= innerEdgeOfSpawns, `a rise at (${i - gridHalf}, ${j - gridHalf}) is in the spawn ring`);
      }
    }
  });
});

describe("given each prop of the arena", () => {
  it("when the floor under and around its box is read, then it is level, so the prop stands on flat ground and never beside a ramp", () => {
    for (const prop of props) {
      const reach = Math.hypot(prop.hx, prop.hz) + LEVEL_MARGIN;
      const heights: number[] = [];
      for (let x = prop.x - reach; x <= prop.x + reach; x += SAMPLE_STEP) {
        for (let z = prop.z - reach; z <= prop.z + reach; z += SAMPLE_STEP) {
          if (isWithin(prop, x, z, LEVEL_MARGIN)) heights.push(ground.heightAt(x, z, 0));
        }
      }
      assert.ok(Math.max(...heights) - Math.min(...heights) < LEVEL, `the ${prop.kind} at (${prop.x}, ${prop.z}) has a rise within ${LEVEL_MARGIN} m of it`);
    }
  });

  it("when the walls are read, then the ring is closed: every wall piece overlaps the next one's face", () => {
    const wall = DERBY_BOXES.filter((box) => box.kind === DERBY_PROP.wall);
    assert.equal(wall.length, DERBY_ARENA.wallPieces);
    for (const [index, piece] of wall.entries()) {
      const next = wall[(index + 1) % wall.length]!;
      const along = piece.hz + 0.01;
      const end = { x: piece.x + Math.sin(piece.yaw) * along, z: piece.z + Math.cos(piece.yaw) * along };
      assert.ok(isWithin(next, end.x, end.z, 0), `wall piece ${index} ends in a gap`);
    }
  });
});
